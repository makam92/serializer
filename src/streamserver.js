'use strict';

/**
 * Tiny HTTP server that streams audio to Sonos players.
 *
 * Sonos plays from a URL: we hand it `http://<mac-lan-ip>:<port>/live.wav` and it
 * connects back and pulls the stream. So this server:
 *   - exposes a finite test tone at /test.wav (to verify the path end-to-end), and
 *   - exposes a live, open-ended PCM/WAV stream at /live.wav that we feed with
 *     audio captured in the renderer (BlackHole loopback).
 *
 * 16-bit stereo LPCM in a WAV container — no encoder, no dependencies.
 */

const http = require('node:http');
const os = require('node:os');

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BITS = 16;
const BYTES_PER_FRAME = CHANNELS * (BITS / 8);
// Cap how much un-flushed audio we let pile up per client (~250 ms) before we
// start dropping frames — keeps end-to-end latency from creeping up.
const MAX_BUFFERED_BYTES = Math.round(SAMPLE_RATE * 0.25) * BYTES_PER_FRAME;

/** Best-guess LAN IP the Sonos can reach us on. */
function lanIp() {
  const ifaces = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal);
  return (ifaces[0] && ifaces[0].address) || '127.0.0.1';
}

/** Build a 44-byte WAV header. `dataLen <= 0` => open-ended stream (max length). */
function wavHeader(dataLen) {
  const streaming = !(dataLen > 0);
  const len = streaming ? 0xffffffff : dataLen;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(streaming ? 0xffffffff : 36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);                 // PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  buf.writeUInt16LE(BYTES_PER_FRAME, 32);
  buf.writeUInt16LE(BITS, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(len, 40);
  return buf;
}

/** Generate `seconds` of a stereo sine tone as 16-bit PCM. */
function toneData(seconds, freq = 440, amp = 0.2) {
  const n = SAMPLE_RATE * seconds;
  const buf = Buffer.alloc(n * BYTES_PER_FRAME);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * amp * 32767);
    buf.writeInt16LE(s, i * BYTES_PER_FRAME);
    buf.writeInt16LE(s, i * BYTES_PER_FRAME + 2);
  }
  return buf;
}

class StreamServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.ip = lanIp();
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
    // Drift measurement (opt-in via SONOS_DRIFT_LOG=1): socket backlog + produced/
    // dropped rate, to see whether Sonos drifts like AirPlay did before we build a
    // correction. NB: Sonos's own ~1-2s buffer is invisible to us, so the socket
    // backlog is a ONE-SIDED proxy — it reveals over-production (backlog grows /
    // we drop), but under-production just shows an empty backlog (Sonos rebuffers
    // on its own). Mirrors the AirPlay drift logger.
    this._driftLog = process.env.SONOS_DRIFT_LOG === '1';
    this._producedBytes = 0;
    this._droppedBytes = 0;
    this._logTimer = null;
    this._logStart = 0;
    this._logPrev = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(0, () => {
        this.port = this.server.address().port;
        resolve({ ip: this.ip, port: this.port });
      });
    });
  }

  _handle(req, res) {
    const url = (req.url || '').split('?')[0];
    if (url === '/test.wav') {
      const data = toneData(8);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': 44 + data.length });
      res.write(wavHeader(data.length));
      res.end(data);
      console.log('[stream] test.wav pulled by', req.socket.remoteAddress);
      return;
    }
    if (url === '/live.wav') {
      console.log('[stream] live client connected:', req.socket.remoteAddress);
      res.writeHead(200, { 'Content-Type': 'audio/wav', Connection: 'close' });
      res.write(wavHeader(0)); // open-ended
      this.clients.add(res);
      this._startLog();
      const drop = () => {
        this.clients.delete(res);
        console.log('[stream] live client left');
        if (this.clients.size === 0) this._stopLog();
      };
      req.on('close', drop);
      res.on('error', drop);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  /**
   * Feed PCM (16-bit stereo LE) to every connected live client.
   *
   * This is a real-time stream: if a Sonos pulls slower than we produce (clock
   * drift, hiccup), Node would buffer the backlog forever and latency would grow
   * without bound. So we DROP frames for any client whose outgoing buffer is
   * already deep — a brief glitch is far better than ever-growing delay.
   */
  writePcm(buf) {
    this._producedBytes += buf.length;
    for (const res of this.clients) {
      if (res.writableEnded || res.destroyed) continue;
      if (res.writableLength > MAX_BUFFERED_BYTES) { this._droppedBytes += buf.length; continue; } // drop to bound latency
      res.write(buf);
    }
  }

  hasClients() { return this.clients.size > 0; }

  // ---- Drift measurement (opt-in via SONOS_DRIFT_LOG=1) ----
  _startLog() {
    if (!this._driftLog || this._logTimer) return;
    this._producedBytes = 0;
    this._droppedBytes = 0;
    this._logStart = Date.now();
    this._logPrev = { t: this._logStart, produced: 0, dropped: 0 };
    console.log('[sonos-drift] logging started');
    this._logTimer = setInterval(() => this._logTick(), 1000);
    if (this._logTimer.unref) this._logTimer.unref();
  }

  _stopLog() {
    if (!this._logTimer) return;
    clearInterval(this._logTimer);
    this._logTimer = null;
    console.log('[sonos-drift] logging stopped');
  }

  _logTick() {
    const now = Date.now();
    const p = this._logPrev;
    const dt = (now - p.t) / 1000;
    if (dt <= 0) return;
    const prod = (this._producedBytes - p.produced) / BYTES_PER_FRAME;
    const drop = (this._droppedBytes - p.dropped) / BYTES_PER_FRAME;
    const ips = (x) => Math.round(x / dt);
    // Per-client socket backlog as ms of audio (a proxy for how far ahead of the player we are).
    const backlog = [...this.clients]
      .map((r) => `${Math.round((r.writableLength / BYTES_PER_FRAME / SAMPLE_RATE) * 1000)}ms`)
      .join(',') || '-';
    const tSec = Math.round((now - this._logStart) / 1000);
    console.log(`[sonos-drift] t=+${tSec}s clients=${this.clients.size} backlog=${backlog} produced=${ips(prod)}f/s dropped=${ips(drop)}f/s`);
    this._logPrev = { t: now, produced: this._producedBytes, dropped: this._droppedBytes };
  }

  stop() {
    this._stopLog();
    for (const res of this.clients) { try { res.end(); } catch {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }
}

module.exports = { StreamServer, lanIp, SAMPLE_RATE, CHANNELS };
