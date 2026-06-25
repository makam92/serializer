'use strict';

/**
 * AirPlay discovery and streaming.
 *
 * macOS lists AirPlay receivers (Apple TV, AirPlay-2 TVs, HomePods) in its own
 * volume menu, but Chromium's enumerateDevices() never returns them — an AirPlay
 * target only becomes a CoreAudio sink once you select it as the system output.
 * So the app never saw them. We discover them ourselves over mDNS and stream to
 * them directly, exactly like the Sonos path.
 *
 * Two halves, deliberately decoupled:
 *   1. DISCOVERY — pure `dns-sd` (the system Bonjour daemon), no dependencies.
 *      Browses `_airplay._tcp` (AirPlay 2) and `_raop._tcp` (legacy RAOP) and
 *      resolves each to host/port + the Bonjour TXT record. This always works,
 *      so the TV shows up in the UI even if streaming is unavailable.
 *   2. STREAMING — node-airtunes2, required LAZILY inside a try/catch. It carries
 *      the AirPlay-2 pairing crypto (SRP / curve25519 / chacha20). If the module
 *      can't load, discovery still works and we report a clear error instead of
 *      crashing the app.
 *
 * node-airtunes2 wants 16-bit/44.1 kHz/stereo PCM — the same format the live
 * capture already produces for Sonos, so we feed it the very same frames.
 */

const { spawn } = require('node:child_process');
const { DriftResampler } = require('./drift-resampler');

const DISCOVER_BROWSE_MS = 2500; // how long to collect Bonjour "Add" records
const DISCOVER_RESOLVE_MS = 2500;
const DEFAULT_AIRPLAY_PORT = 7000;

// ---------------------------------------------------------------------------
// dns-sd helpers
// ---------------------------------------------------------------------------
/** Run a `dns-sd` command, collecting ALL stdout until `timeoutMs`, then resolve it. */
function runDnssdCollect(args, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn('dns-sd', args); }
    catch { resolve(''); return; }
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(out));
    setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, timeoutMs);
  });
}

/** Run a `dns-sd` command, resolving as soon as `parse(output)` returns truthy. */
function runDnssdFirst(args, parse, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn('dns-sd', args); }
    catch { resolve(null); return; }
    let out = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      resolve(val);
    };
    proc.stdout.on('data', (d) => { out += d.toString(); const v = parse(out); if (v) finish(v); });
    proc.on('error', () => finish(null));
    setTimeout(() => finish(parse(out) || null), timeoutMs);
  });
}

/** Bonjour escapes spaces in instance names as `\032` — undo that for display. */
function unescapeInstance(s) {
  return s.replace(/\\(\d{3})/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/** Collect every advertised instance name for a service type via `dns-sd -B`. */
async function browseInstances(serviceType) {
  const out = await runDnssdCollect(['-B', serviceType, 'local.'], DISCOVER_BROWSE_MS);
  // Lines look like: "<time>  Add  <flags>  <if>  local.  _airplay._tcp.  <Instance Name>"
  // Track Add/Rmv so a device that dropped mid-scan doesn't linger.
  const present = new Set();
  const re = new RegExp(`\\b(Add|Rmv)\\b.*${serviceType.replace(/\./g, '\\.')}\\.\\s+(.+?)\\s*$`, 'gm');
  let m;
  while ((m = re.exec(out)) !== null) {
    const name = m[2];
    if (m[1] === 'Add') present.add(name); else present.delete(name);
  }
  return [...present];
}

/**
 * Resolve one instance to { host, port, txt[] } via `dns-sd -L`. The TXT record
 * is what node-airtunes2 reads to decide AirPlay-2 vs legacy, encryption, and
 * whether a PIN/password is required — so we capture it verbatim.
 */
async function resolveInstance(instance, serviceType) {
  const out = await runDnssdCollect(['-L', instance, serviceType, 'local.'], DISCOVER_RESOLVE_MS);
  const reach = out.match(/can be reached at\s+(\S+?):(\d+)/i);
  if (!reach) return null;
  const host = reach[1].replace(/\.$/, '');
  const port = parseInt(reach[2], 10) || DEFAULT_AIRPLAY_PORT;
  // TXT pairs are printed after the "(interface N)" marker, space-separated.
  const after = out.slice(out.indexOf(reach[0]) + reach[0].length);
  const txt = [];
  const txtRe = /([A-Za-z0-9_.-]+=[^\s]*)/g;
  let t;
  while ((t = txtRe.exec(after)) !== null) {
    if (!/^interface=/i.test(t[1])) txt.push(t[1]);
  }
  return { host, port, txt };
}

/** Resolve an mDNS `.local` hostname to an IPv4 address (Sonos path does the same). */
async function resolveIp(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // already an IP
  const ip = await runDnssdFirst(
    ['-G', 'v4', host],
    (out) => { const m = out.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/); return m && m[1]; },
    DISCOVER_RESOLVE_MS,
  );
  return ip || host; // fall back to the hostname; macOS can resolve .local itself
}

function txtValue(txt, key) {
  const hit = txt.find((u) => String(u).startsWith(`${key}=`));
  return hit ? hit.slice(key.length + 1) : '';
}

// ---------------------------------------------------------------------------
// Public: discovery
// ---------------------------------------------------------------------------
/**
 * Discover AirPlay receivers on the LAN. Browses AirPlay 2 first, then legacy
 * RAOP, de-duplicating by device id so a receiver that advertises both shows
 * once (preferring the AirPlay-2 entry).
 * @returns {Promise<Array<{id, name, host, port, txt, airplay2, model}>>}
 */
async function discover() {
  const found = new Map(); // key: deviceid or host:port

  const collect = async (serviceType, airplay2) => {
    const instances = await browseInstances(serviceType);
    await Promise.all(instances.map(async (instance) => {
      const resolved = await resolveInstance(instance, serviceType);
      if (!resolved) return;
      const ip = await resolveIp(resolved.host);
      const deviceId = txtValue(resolved.txt, 'deviceid') || `${ip}:${resolved.port}`;
      if (found.has(deviceId)) return; // already have it (e.g. from the AirPlay-2 pass)
      found.set(deviceId, {
        id: `${ip}:${resolved.port}`,
        name: unescapeInstance(instance),
        host: ip,
        port: resolved.port,
        txt: resolved.txt,
        airplay2,
        model: txtValue(resolved.txt, 'model') || txtValue(resolved.txt, 'am') || 'AirPlay',
      });
    }));
  };

  await collect('_airplay._tcp', true);
  await collect('_raop._tcp', false);

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Public: streaming (lazy node-airtunes2)
// ---------------------------------------------------------------------------

/**
 * node-airtunes2 crashes the whole process (uncaught) when a HomeKit/AirPlay PIN
 * is rejected: in PAIR_SETUP_2 it reads the server's "Proof" TLV — which is absent
 * on a bad PIN (the device sends an error TLV instead) — and calls
 * `srp.checkM2(undefined)`, throwing "Cannot read properties of undefined
 * (reading 'toString')" synchronously inside the socket data handler. The library
 * handles this correctly in PAIR_SETUP_1 (emits `pair_failed`) but not _2.
 *
 * Wrap `Client.prototype.processData` once so any handshake parse error surfaces as
 * a clean `pair_failed` (which the UI already handles) instead of taking down main.
 */
let _pairingCrashPatched = false;
function patchPairingCrash() {
  if (_pairingCrashPatched) return;
  try {
    const path = require('path');
    const rtsp = require(path.join(path.dirname(require.resolve('node-airtunes2')), 'rtsp.js'));
    const Client = rtsp && rtsp.Client;
    if (Client && Client.prototype && typeof Client.prototype.processData === 'function') {
      const orig = Client.prototype.processData;
      Client.prototype.processData = function (blob, rawData) {
        try {
          return orig.call(this, blob, rawData);
        } catch (err) {
          console.warn('[airplay] handshake error (likely a rejected PIN):', err && err.message);
          try { this.emit('pair_failed'); } catch {}
          try { this.cleanup('pair_failed'); } catch {}
        }
      };
    }
    _pairingCrashPatched = true;
  } catch {
    // best-effort: if the library layout changes, fall back to unpatched
  }
}

/**
 * Wraps a single shared node-airtunes2 instance. All selected receivers share
 * one PCM stream so they stay sample-synchronised, just like a Sonos group.
 *
 * Device status events (`ready`, `playing`, `stopped`, `need_password`,
 * `pair_failed`, `pair_success`, `error`) are surfaced through `onStatus` so the
 * renderer can, e.g., prompt for the PIN a TV shows on screen.
 */
class AirPlayCaster {
  constructor() {
    this._airtunes = null;     // node-airtunes2 instance (lazy)
    this._loadError = null;    // why the module failed to load, if it did
    /** @type {Map<string, {device:any, name:string}>} keyed by `host:port` */
    this._devices = new Map();
    this.onStatus = null;      // (key, status, desc) => void

    // Drift instrumentation (temporary): measure produced-vs-consumed + buffer fill
    // while streaming, to size the adaptive-resampler control loop. See
    // docs/adaptive-resampling.md.
    this._bytesWritten = 0;
    this._bytesDropped = 0;
    this._logTimer = null;
    this._logStart = 0;
    this._logPrev = null;

    // Adaptive resampler (clock-drift correction). Enabled by default; set
    // AIRPLAY_RESAMPLE=0 to A/B test it off. The control loop is updated slowly
    // (EMA-smoothed buffer fill, ~1/s) so it tracks the ~500ppm drift, not the
    // large per-sample jitter. See docs/adaptive-resampling.md.
    this.resampleEnabled = process.env.AIRPLAY_RESAMPLE !== '0';
    this._resampler = null;
    this._fillEma = 0;
    // Verbose per-second drift logging is opt-in now that the loop is validated
    // (set AIRPLAY_DRIFT_LOG=1). The control loop itself always runs while streaming.
    this._driftLog = process.env.AIRPLAY_DRIFT_LOG === '1';
  }

  /** Lazily construct the AirTunes instance. Returns null if the module can't load. */
  _ensure() {
    if (this._airtunes) return this._airtunes;
    if (this._loadError) return null;
    try {
      const AirTunes = require('node-airtunes2');
      patchPairingCrash();
      this._airtunes = new AirTunes();
      // Per-device status fan-out (keyed). The instance re-emits device events.
      this._airtunes.on('device', (key, status, desc) => {
        // A receiver that stopped or errored is gone from the library's pool —
        // drop it from ours too, or setVolume/writePcm target a dead device.
        if (status === 'stopped' || status === 'error') this._devices.delete(key);
        if (this.onStatus) this.onStatus(key, status, desc || '');
      });
      this._airtunes.on('error', () => {}); // don't let a stream error crash main
      return this._airtunes;
    } catch (err) {
      this._loadError = err.message || String(err);
      return null;
    }
  }

  available() { return !this._loadError; }
  loadError() { return this._loadError; }
  hasActive() { return this._devices.size > 0; }

  /**
   * Ensure each requested receiver is connected. Returns the list of keys that
   * are now (being) streamed, or an { error } if the streaming module is absent.
   * @param {Array<{id,name,host,port,txt,airplay2,volume}>} receivers
   */
  play(receivers) {
    const at = this._ensure();
    if (!at) return { ok: false, error: `AirPlay streaming unavailable: ${this._loadError}` };
    for (const r of receivers) {
      const key = `${r.host}:${r.port}`;
      if (this._devices.has(key)) continue;
      // Pass the Bonjour TXT through so the library auto-detects AirPlay 2,
      // encryption, and whether a PIN/password is required. NB: node-airtunes2's
      // Devices.add() reads `txt`/`mode` from the options object — the positional
      // args on the top-level add() are ignored — so they must go in here.
      const device = at.add(r.host, {
        port: r.port,
        volume: typeof r.volume === 'number' ? r.volume : 50,
        airplay2: r.airplay2 !== false,
        mode: 0,
        txt: r.txt || [],
      });
      this._devices.set(key, { device, name: r.name });
    }
    if (this._devices.size > 0) this._startDriftLog();
    return { ok: true, keys: [...this._devices.keys()] };
  }

  /**
   * Feed one chunk of 16-bit LE stereo PCM to all connected receivers.
   *
   * node-airtunes2's circular buffer NEVER drops — write() always appends and just
   * returns false when full. It is drained on a wall-clock timer (Date.now()), but
   * we PRODUCE on the Mac audio-hardware clock (the capture AudioContext). Those two
   * oscillators differ slightly, so if we run faster the buffer grows without bound
   * and AirPlay falls progressively behind — drift no fixed delay can correct. Once
   * the buffer is comfortably past its ~0.8s play threshold, drop this chunk to keep
   * latency bounded (a rare brief glitch beats unbounded drift — same idea as the
   * Sonos stream-server back-pressure).
   */
  writePcm(buf) {
    if (!this._airtunes || this._devices.size === 0) return;
    const cb = this._airtunes.circularBuffer;
    if (cb && cb.maxSize && cb.currentSize > cb.maxSize * 0.6) { this._bytesDropped += buf.length; return; } // backstop only
    // Adaptive resampling: trim the chunk by the controller's current ratio so our
    // production rate tracks the receiver's drain (the ratio is steered slowly in
    // _driftTick). process() carries fractional state across chunks (click-free).
    let out = buf;
    if (this._resampler) {
      const inp = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
      const res = this._resampler.process(inp);
      out = Buffer.from(res.buffer, res.byteOffset, res.byteLength);
    }
    this._bytesWritten += out.length;
    try { this._airtunes.write(out); } catch { /* circular buffer closed mid-teardown */ }
  }

  setVolume(key, volume) {
    if (!this._airtunes || !this._devices.has(key)) return;
    try { this._airtunes.setVolume(key, Math.max(0, Math.min(100, Math.round(volume)))); } catch {}
  }

  setPasscode(key, passcode) {
    if (!this._airtunes || !this._devices.has(key)) return;
    try { this._airtunes.setPasscode(key, String(passcode)); } catch {}
  }

  /** Stop a subset of receivers (leaving the rest streaming). */
  stop(keys) {
    if (!this._airtunes) return;
    for (const key of keys) {
      if (!this._devices.has(key)) continue;
      try { this._airtunes.stop(key); } catch {}
      this._devices.delete(key);
    }
    if (this._devices.size === 0) this._stopDriftLog();
  }

  /**
   * Stop everything and drop the shared stream. NB: node-airtunes2's own
   * stopAll() is a no-op unless given a callback (it wraps its whole body in
   * `if (cb != null)`), so we stop each device by key instead.
   */
  stopAll() {
    if (!this._airtunes) { this._devices.clear(); this._stopDriftLog(); return; }
    this.stop([...this._devices.keys()]);
  }

  // ---- Per-session control loop (drives the adaptive resampler) + opt-in logging ----
  // The 1/s timer always runs while streaming so the resampler keeps adapting; the
  // verbose `[airplay-drift]` output is gated behind AIRPLAY_DRIFT_LOG.
  _startDriftLog() {
    if (this._logTimer) return;
    this._bytesWritten = 0;
    this._bytesDropped = 0;
    this._logStart = Date.now();
    this._logPrev = { t: this._logStart, written: 0, dropped: 0, fill: 0 };
    // Spin up the adaptive resampler for this session, targeting node-airtunes2's
    // ~0.8s play threshold (maxSize/2). One resampler governs the shared buffer.
    if (this.resampleEnabled && this._airtunes && this._airtunes.circularBuffer) {
      const targetFrames = (this._airtunes.circularBuffer.maxSize / 2) / 4;
      this._resampler = new DriftResampler({ channels: 2, targetFrames, maxAdjust: 0.004, ki: 0 });
      this._fillEma = targetFrames;
    }
    if (this._driftLog) console.log(`[airplay-drift] control loop started — adaptive resampler ${this._resampler ? 'ON' : 'OFF'}`);
    this._logTimer = setInterval(() => this._driftTick(), 1000);
    if (this._logTimer.unref) this._logTimer.unref();
  }

  _stopDriftLog() {
    this._resampler = null;
    if (!this._logTimer) return;
    clearInterval(this._logTimer);
    this._logTimer = null;
    if (this._driftLog) console.log('[airplay-drift] control loop stopped');
  }

  /**
   * Once per second: fill level (a proxy for accumulated drift) plus the
   * production vs. consumption rates. `drift` = frames/s we over/under-produce
   * relative to the receiver's wall-clock drain — that, in ppm, is exactly the
   * rate the adaptive resampler must trim. (Over-production shows up as dropped
   * frames once the 0.6 buffer bound kicks in, plus any buffer growth.)
   */
  _driftTick() {
    const cb = this._airtunes && this._airtunes.circularBuffer;
    if (!cb || !cb.maxSize || !this._logPrev) return;
    const now = Date.now();
    const p = this._logPrev;
    const dt = (now - p.t) / 1000;
    if (dt <= 0) return;
    const FR = 4; // bytes per stereo 16-bit frame
    const fill = cb.currentSize / FR;                 // frames buffered now
    const maxF = cb.maxSize / FR;
    const wF = (this._bytesWritten - p.written) / FR; // frames written to the buffer this interval
    const dF = (this._bytesDropped - p.dropped) / FR; // frames dropped by the bound this interval
    const prod = wF + dF;                             // frames produced from capture
    const consumed = wF - (fill - p.fill);            // frames the receiver drained
    const drift = prod - consumed;                    // >0 = we run fast
    const ips = (x) => Math.round(x / dt);            // -> per second
    const ppm = Math.round((drift / dt) / 44100 * 1e6);
    const tSec = Math.round((now - this._logStart) / 1000);

    // Adaptive-resampler control: smooth the (jittery) fill with a ~20s EMA, then
    // steer the resample ratio toward holding the target. Deliberately slow so it
    // tracks the ~0.5ms/s drift and ignores the per-sample noise.
    let ratio = 1;
    if (this._resampler) {
      const a = 1 - Math.exp(-dt / 20);
      this._fillEma += a * (fill - this._fillEma);
      this._resampler.setFill(this._fillEma);
      ratio = this._resampler.ratio;
    }

    if (this._driftLog) {
      console.log(
        `[airplay-drift] t=+${tSec}s fill=${(fill / 44100).toFixed(2)}s(${Math.round((fill / maxF) * 100)}%) ` +
        `prod=${ips(prod)}f/s cons=${ips(consumed)}f/s drift=${drift >= 0 ? '+' : ''}${ips(drift)}f/s ` +
        `(${ppm >= 0 ? '+' : ''}${ppm}ppm) [wrote ${ips(wF)} dropped ${ips(dF)}]` +
        (this._resampler ? ` | resamp ratio=${ratio.toFixed(5)} ema=${(this._fillEma / 44100).toFixed(2)}s` : ''),
      );
    }
    this._logPrev = { t: now, written: this._bytesWritten, dropped: this._bytesDropped, fill };
  }
}

module.exports = { discover, AirPlayCaster };
