'use strict';

import { Visualizer } from './visualizer.js';
import { COLS, moveElement, resizeElement, addElement, removeElement, bottom } from './grid-layout.js';

/**
 * Serializer renderer.
 *
 * Every speaker the OS knows about (Bluetooth, AirPlay, wired, built-in) shows
 * up as an "audiooutput" device. Serializer plays a single source through many
 * of them at once and keeps them in sync.
 *
 * Two source modes:
 *  - FILE: decode a local file into one <audio> element per device, routed with
 *    HTMLMediaElement.setSinkId. One element is the reference clock; the others
 *    are reconciled to it on an interval. Per-device "delay comp" nudges laggy
 *    speakers into alignment.
 *  - LIVE: capture a live audio *input* (e.g. the BlackHole loopback device that
 *    carries your browser/system audio) and route it to each speaker through a
 *    dedicated AudioContext (setSinkId) -> Delay -> Gain -> output graph.
 */

// ---- DOM ----
const el = {
  trackTitle: document.getElementById('trackTitle'),
  trackSub: document.getElementById('trackSubtitle'),
  trackFormat: document.getElementById('trackFormat'),
  timeCurrent: document.getElementById('timeCurrent'),
  timeTotal: document.getElementById('timeTotal'),
  seek: document.getElementById('seek'),
  btnPick: document.getElementById('btnOpen'),
  fileTransport: document.getElementById('fileTransport'),
  liveTransport: document.getElementById('liveTransport'),
  tpButtons: document.getElementById('tpButtons'),
  tpsTitle: document.getElementById('tpsTitle'),
  tpsSub: document.getElementById('tpsSub'),
  masterDb: document.getElementById('masterDb'),
  vuL: document.getElementById('vuL'),
  vuR: document.getElementById('vuR'),
  btnPlay: document.getElementById('btnPlay'),
  btnStop: document.getElementById('btnStop'),
  masterVol: document.getElementById('masterVol'),
  btnRescan: document.getElementById('btnRescan'),
  btnAutoSync: document.getElementById('btnAutoSync'),
  btnAutoSyncUndo: document.getElementById('btnAutoSyncUndo'),
  btnViz: document.getElementById('btnVisualize'),
  timecode: document.getElementById('timecode'),
  timecodeTotal: document.getElementById('timecodeTotal'),
  statusPill: document.getElementById('statusPill'),
  statusDot: document.getElementById('statusDot'),
  wallclock: document.querySelector('[data-wallclock]'),
  tally: document.getElementById('tally'),
  bgCanvas: document.getElementById('bgCanvas'),
  vizOverlay: document.getElementById('vizOverlay'),
  vizCanvas: document.getElementById('vizCanvas'),
  vizClose: document.getElementById('vizClose'),
  vizTitle: document.getElementById('vizTitle'),
  devicesHint: document.getElementById('devicesHint'),
  devicesMeta: document.getElementById('devicesMeta'),
  devicesDiscover: document.getElementById('devicesDiscover'),
  deviceList: document.getElementById('deviceList'),
  status: document.getElementById('statusText'),
  statusSys: document.getElementById('statusSys'),
  transportStatus: document.getElementById('transportStatus'),
  btnModeFile: document.getElementById('segFile'),
  btnModeLive: document.getElementById('segLive'),
  inputSelect: document.getElementById('inputDevice'),
  liveHint: document.getElementById('liveHint'),
  inputMeter: document.getElementById('inputMeter'),
  meterFill: document.getElementById('meterFill'),
  meterDb: document.getElementById('meterDb'),
  btnFindSonos: document.getElementById('btnFindSonos'),
  sonosHint: document.getElementById('sonosHint'),
  sonosDiscover: document.getElementById('sonosDiscover'),
  sonosControls: document.getElementById('sonosControls'),
  sonosWarn: document.getElementById('sonosWarn'),
  btnMuteLocal: document.getElementById('btnMuteLocal'),
  btnEchoDismiss: document.getElementById('btnEchoDismiss'),
  sonosList: document.getElementById('sonosList'),
  btnFindAirPlay: document.getElementById('btnFindAirPlay'),
  airplayHint: document.getElementById('airplayHint'),
  airplayDiscover: document.getElementById('airplayDiscover'),
  airplayControls: document.getElementById('airplayControls'),
  airplayList: document.getElementById('airplayList'),
};

// ---- State ----
/** @typedef {{ deviceId: string, label: string, isDefault: boolean }} DeviceInfo */
/**
 * @typedef {Object} Channel
 * @property {DeviceInfo} info
 * @property {HTMLAudioElement} audio        file-mode element
 * @property {boolean} enabled
 * @property {number} volume                 0..1
 * @property {number} offsetMs               delay compensation (file: +/-, live: >=0)
 * @property {?{ctx: AudioContext, src: MediaStreamAudioSourceNode, delay: DelayNode, gain: GainNode}} live
 */

/** @type {Map<string, Channel>} keyed by output deviceId */
const channels = new Map();

let mode = 'file'; // 'file' | 'live' — the VIEWED tab
let playMode = 'file'; // the mode whose playback is actually running (decoupled from the view)
let currentObjectUrl = null;
let trackName = '';
let masterVolume = 1;
let localMuted = false; // "Mute local output" (echo banner) — silences local speakers, keeps Sonos/AirPlay
let isPlaying = false;
let durationSec = 0;
let seeking = false;

// live state
let inputDeviceId = '';
let blackholeInstalled = false; // true once the BlackHole virtual driver is detected as an input
let liveStream = null;
// While paused in Live mode we keep the Sonos/AirPlay captures alive but feed
// them silence, so the receivers stay grouped + buffered and resume in sync
// instead of re-buffering (~1.5–2 s) from scratch.
let networkCapturePaused = false;

// input meter state
let meterCtx = null;
let meterAnalyser = null;
let meterData = null;
let meterRaf = 0;
let meterPeakHold = 0; // smoothed peak, 0..1

const DRIFT_THRESHOLD = 0.04; // seconds — re-align a file speaker once it drifts past this
const MAX_DELAY = 8.0;        // DelayNode max (seconds) — AirPlay TVs can buffer several seconds
const DELAY_COMP_RANGE = 8000; // delay-comp slider span (± ms)
const BASS_FREQ = 200;        // low-shelf corner (Hz) — boosts everything below this
const BASS_MAX_DB = 12;       // max bass boost (dB)

// ---- Per-speaker preference persistence ----
// Saved per output deviceId. Chromium device IDs are stable for the app's
// origin across launches, so a speaker keeps its delay/volume/bass next time.
const PREFS_KEY = 'serializer.devicePrefs.v1';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
  catch { return {}; }
}
const savedPrefs = loadPrefs();
function persistPrefs() {
  const out = {};
  for (const [id, ch] of channels) {
    // Remember a speaker if it's selected OR has any tuned value, so the same
    // speakers come back pre-selected (with their delay/volume/bass) next launch.
    if (ch.enabled || ch.offsetMs !== 0 || ch.volume !== 1 || ch.bass !== 0) {
      out[id] = { enabled: ch.enabled, offsetMs: ch.offsetMs, volume: ch.volume, bass: ch.bass };
    }
  }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(out)); } catch {}
}

/** Load a persisted array of selected ids (Sonos rooms / AirPlay receivers). */
function loadIdSet(key) {
  try { const a = JSON.parse(localStorage.getItem(key)); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
// Persistence is blocking (synchronous localStorage); never run it on a slider's
// per-`input` hot path — debounce so it fires only after dragging settles.
const schedulePersist = debounce(persistPrefs, 400);

// ---- Helpers ----
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function setStatus(msg) { el.status.textContent = msg; }

/**
 * Show a header "discovering…" spinner for at least `minMs` so the animation is
 * visible even when a scan returns near-instantly (e.g. local device enumeration).
 * Returns a `done()` to call when the scan finishes.
 */
function flashDiscovering(elDiscover, minMs = 650) {
  if (!elDiscover) return () => {};
  elDiscover.hidden = false;
  const start = Date.now();
  // safety: never let the spinner get stuck if a scan throws before done()
  const safety = setTimeout(() => { elDiscover.hidden = true; }, 20000);
  return () => {
    clearTimeout(safety);
    const wait = Math.max(0, minMs - (Date.now() - start));
    setTimeout(() => { elDiscover.hidden = true; }, wait);
  };
}

/** Rate-limit a function to at most once per `ms`, with a trailing call. */
function throttle(fn, ms) {
  let last = 0; let timer = null; let lastArgs;
  return (...args) => {
    lastArgs = args;
    const now = performance.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) { last = now; fn(...args); }
    else if (!timer) {
      timer = setTimeout(() => { last = performance.now(); timer = null; fn(...lastArgs); }, remaining);
    }
  };
}

/** Run `fn` only after `ms` of quiet — keeps blocking work off the drag hot path. */
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}
function enabledChannels() { return [...channels.values()].filter((c) => c.enabled); }

/** First enabled, loaded file-mode element — the reference clock. */
function referenceChannel() {
  for (const ch of channels.values()) {
    if (ch.enabled && ch.audio.readyState >= 1) return ch;
  }
  return null;
}

// ---- Device discovery ----
async function unlockDeviceLabels() {
  // Device labels (and input access) stay hidden until an audio permission is
  // granted once. Request it, then release.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch { /* labels stay generic; routing still works */ }
}

async function scanDevices() {
  setStatus('Scanning audio devices…');
  const doneDiscover = flashDiscovering(el.devicesDiscover);
  await unlockDeviceLabels();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  const inputs = devices.filter((d) => d.kind === 'audioinput');

  // Outputs -> channels
  const seen = new Set();
  for (const d of outputs) {
    seen.add(d.deviceId);
    if (!channels.has(d.deviceId)) {
      addChannel({ deviceId: d.deviceId, label: d.label || 'Audio output', isDefault: d.deviceId === 'default' });
    } else {
      channels.get(d.deviceId).info.label = d.label || channels.get(d.deviceId).info.label;
    }
  }
  for (const [id, ch] of channels) {
    // Only prune vanished devices that aren't in use. NEVER pause/deselect an
    // ENABLED speaker on a transient enumeration change — starting playback wakes
    // the device and fires a `devicechange`, during which the device can briefly
    // drop out of enumerateDevices(); pausing it there was killing audio the
    // instant you pressed Play. A genuinely unplugged speaker just goes silent
    // until you untick it, which is harmless.
    if (!seen.has(id) && !ch.enabled) channels.delete(id);
  }

  renderDevices();
  populateInputs(inputs);

  el.devicesHint.textContent = outputs.length
    ? `${outputs.length} output${outputs.length > 1 ? 's' : ''} found. Tick the speakers you want, then press ${mode === 'live' ? 'Start' : 'Play'}.`
    : 'No audio outputs found. Connect a speaker and press Rescan.';
  doneDiscover();
  setStatus('Ready.');
}

/** @param {DeviceInfo} info */
function addChannel(info) {
  const audio = new Audio();
  audio.preload = 'auto';
  const ch = { info, audio, enabled: false, volume: 1, offsetMs: 0, bass: 0, live: null, fileGraph: null };
  const saved = savedPrefs[info.deviceId];
  if (saved) {
    ch.volume = typeof saved.volume === 'number' ? saved.volume : 1;
    ch.offsetMs = typeof saved.offsetMs === 'number' ? saved.offsetMs : 0;
    ch.bass = typeof saved.bass === 'number' ? saved.bass : 0;
    ch.enabled = saved.enabled === true; // restore which speakers were selected
  }
  channels.set(info.deviceId, ch);
}

function populateInputs(inputs) {
  const prev = el.inputSelect.value;
  el.inputSelect.innerHTML = '';
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    const label = d.label || 'Audio input';
    opt.textContent = /blackhole/i.test(label) ? `${label}  ⟵ system audio` : label;
    el.inputSelect.appendChild(opt);
  }
  // Prefer BlackHole if present, else keep previous, else first.
  const blackhole = inputs.find((d) => /blackhole/i.test(d.label));
  blackholeInstalled = !!blackhole; // the BlackHole hint shows only when it's missing
  if (el.liveHint && mode === 'live' && !isPlaying) el.liveHint.hidden = blackholeInstalled;
  el.inputSelect.value = blackhole ? blackhole.deviceId : (prev || (inputs[0] && inputs[0].deviceId) || '');
  inputDeviceId = el.inputSelect.value;
}

// ---- FILE mode: source loading ----
async function loadFile() {
  const paths = await window.api.pickAudioFiles();
  if (!paths.length) return;
  const { name, bytes } = await window.api.readAudioFile(paths[0]);

  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(new Blob([bytes]));
  trackName = name;
  durationSec = 0;

  el.trackTitle.textContent = name;
  el.trackSub.textContent = 'Loading…';

  await Promise.all([...channels.values()].map((ch) => attachSource(ch)));

  el.btnPlay.disabled = false;
  el.btnStop.disabled = false;
  el.seek.disabled = false;
  setStatus(`Loaded "${name}".`);
}

/** @param {Channel} ch */
function attachSource(ch) {
  return new Promise((resolve) => {
    const a = ch.audio;
    a.src = currentObjectUrl;
    applyChannelVolume(ch);
    // Always settle exactly once — on metadata, on decode error, or on a timeout.
    // Otherwise an undecodable file would never fire 'loadedmetadata' and the
    // loadFile() Promise.all would hang forever (Play/Stop never enable).
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('error', onErr);
      resolve();
    };
    const onMeta = () => {
      durationSec = Math.max(durationSec, a.duration || 0);
      el.timeTotal.textContent = fmtTime(durationSec);
      el.trackSub.textContent = 'Ready';
      applySink(ch).finally(finish);
    };
    const onErr = () => {
      el.trackSub.textContent = 'Could not decode this file';
      setStatus(`Could not load "${trackName}" — unsupported or corrupt file.`);
      finish();
    };
    const timer = setTimeout(() => {
      setStatus(`"${trackName}" took too long to load.`);
      finish();
    }, 15000);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('error', onErr);
    a.load();
  });
}

/** @param {Channel} ch */
async function applySink(ch) {
  if (ch.fileGraph) return; // routed via its own AudioContext (ctx.setSinkId)
  if (typeof ch.audio.setSinkId !== 'function') return;
  try {
    if (ch.audio.sinkId !== ch.info.deviceId) await ch.audio.setSinkId(ch.info.deviceId);
  } catch (err) {
    setStatus(`Could not route to "${ch.info.label}": ${err.message}`);
  }
}

// ---- LIVE mode: capture an input and route to each speaker ----
let startingLive = false;
async function startLive() {
  if (startingLive) return; // guard against a double Start before the build finishes
  const active = enabledChannels();
  if (!active.length && !selectedSonosRooms().length && !selectedAirPlay().length) {
    setStatus('Select at least one speaker, Sonos room, or AirPlay device first.');
    return;
  }
  startingLive = true;
  try {
    // On a fresh start, open the input. On Resume-from-pause the stream and the
    // per-speaker contexts are still alive, so reuse them (preserves sync).
    if (!liveStream) {
      try {
        const audioConstraints = inputDeviceId
          ? { deviceId: { exact: inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        liveStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      } catch (err) {
        setStatus(`Could not open input: ${err.message}`);
        return;
      }
    }

    for (const ch of active) { await buildLiveNode(ch); applyChannelVolume(ch); }
    startMeter();

    isPlaying = true;
    playMode = 'live';
    setPlayState(true);
    const inputName = el.inputSelect.options[el.inputSelect.selectedIndex]?.textContent || 'input';
    setStatus(`Live: routing "${inputName}" to ${active.length} speaker${active.length > 1 ? 's' : ''}.`);
    if (selectedSonosRooms().length) refreshSonosStream();
    if (selectedAirPlay().length) refreshAirPlayStream();
    setNetworkCapturePaused(false); // unmute the captures on (re)start / resume
    startBackdrop();
    setLiveUI(true);
  } finally {
    startingLive = false;
  }
}

/**
 * Build a speaker's live AudioContext. A fresh context has its own, non-
 * deterministic output latency, so we build it ONCE and keep it (see
 * disableLiveNode) — recreating it on every toggle is what threw speakers out of
 * sync even with an unchanged Delay comp. Guarded against concurrent builds.
 * @param {Channel} ch
 */
async function buildLiveNode(ch) {
  if (ch.live) return ch.live;
  if (ch._liveP) return ch._liveP;
  if (!liveStream) return null;
  ch._liveP = (async () => {
    let ctx;
    try {
      ctx = new AudioContext({ latencyHint: 'playback' });
      try {
        if (typeof ctx.setSinkId === 'function') await ctx.setSinkId(ch.info.deviceId);
      } catch (err) {
        setStatus(`Could not route to "${ch.info.label}": ${err.message}`);
      }
      const src = ctx.createMediaStreamSource(liveStream);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowshelf';
      filter.frequency.value = BASS_FREQ;
      filter.gain.value = ch.bass;
      const delay = ctx.createDelay(MAX_DELAY);
      const gain = ctx.createGain();
      delay.delayTime.value = clampDelay(ch.offsetMs);
      // If the speaker was toggled back off while this async build was running,
      // come up muted so we don't leak audio to a disabled speaker.
      gain.gain.value = ch.enabled ? Math.min(1, ch.volume * masterVolume) : 0;
      src.connect(filter);
      filter.connect(delay);
      delay.connect(gain);
      gain.connect(ctx.destination);
      await ctx.resume();
      ch.live = { ctx, src, filter, delay, gain };
      return ch.live;
    } catch (err) {
      if (ctx) ctx.close().catch(() => {});
      setStatus(`Could not start "${ch.info.label}": ${err.message}`);
      return null;
    } finally {
      ch._liveP = null; // always clear the guard, even on failure (so it can retry)
    }
  })();
  return ch._liveP;
}

/**
 * Disable a live speaker WITHOUT destroying its context — just mute it. The
 * context keeps running at a fixed latency/phase, so re-enabling it stays in
 * sync with the others (no re-tuning of Delay comp needed).
 * @param {Channel} ch
 */
function disableLiveNode(ch) {
  if (ch.live) ch.live.gain.gain.value = 0;
}

/** Fully destroy a live node's context — only when stopping Live entirely. */
function teardownLiveNode(ch) {
  if (!ch.live) return;
  try { ch.live.src.disconnect(); ch.live.filter.disconnect(); ch.live.gain.disconnect(); ch.live.delay.disconnect(); } catch {}
  ch.live.ctx.close().catch(() => {});
  ch.live = null;
  ch._liveP = null;
}

function stopLive() {
  networkCapturePaused = false;
  stopMeter();
  stopSonosStream();
  stopAirPlayStream();
  for (const ch of channels.values()) teardownLiveNode(ch);
  if (liveStream) { liveStream.getTracks().forEach((t) => t.stop()); liveStream = null; }
}

/**
 * Pause/resume the network broadcast WITHOUT tearing it down: ramp each capture's
 * pre-worklet mute gain so the receivers keep their primed buffer (silence while
 * paused) and resume aligned. A capture built while paused comes up muted too.
 */
function setNetworkCapturePaused(paused) {
  networkCapturePaused = paused;
  for (const cap of [sonosCapture, airplayCapture]) {
    if (cap && cap.muteGain) {
      const t = cap.ctx.currentTime;
      cap.muteGain.gain.setTargetAtTime(paused ? 0 : 1, t, 0.02);
    }
  }
}

function clampDelay(ms) { return Math.max(0, Math.min(MAX_DELAY, ms / 1000)); }

// ---- Input level meter (live mode) ----
// Taps the captured input stream with an AnalyserNode so you can confirm signal
// is actually flowing in (handy for verifying the BlackHole loopback). This is a
// metering-only graph — it does not connect to any destination, so it makes no
// sound and is independent of the per-speaker live nodes.
function startMeter() {
  if (!liveStream || meterCtx) return;
  meterCtx = new AudioContext();
  const src = meterCtx.createMediaStreamSource(liveStream);
  meterAnalyser = meterCtx.createAnalyser();
  meterAnalyser.fftSize = 1024;
  meterAnalyser.smoothingTimeConstant = 0.3;
  meterData = new Float32Array(meterAnalyser.fftSize);
  src.connect(meterAnalyser);
  meterPeakHold = 0;
  el.inputMeter.hidden = false;
  meterCtx.resume().catch(() => {});
  meterRaf = requestAnimationFrame(meterTick);
}

function meterTick() {
  if (!meterAnalyser) return;
  meterAnalyser.getFloatTimeDomainData(meterData);
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < meterData.length; i++) {
    const s = meterData[i];
    sumSq += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / meterData.length);
  // Fast attack, slow release so brief peaks stay readable.
  meterPeakHold = peak > meterPeakHold ? peak : meterPeakHold * 0.92 + peak * 0.08;

  // Map RMS to a 0..1 bar over a useful -60..0 dB range.
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const frac = !isFinite(db) ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
  el.meterFill.style.width = `${(frac * 100).toFixed(1)}%`;
  el.meterFill.classList.toggle('clip', meterPeakHold >= 0.99);
  el.meterDb.textContent = isFinite(db) ? db.toFixed(1) : '–∞';

  meterRaf = requestAnimationFrame(meterTick);
}

function stopMeter() {
  if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = 0; }
  if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
  meterAnalyser = null;
  meterData = null;
  // Keep the INPUT LEVEL bar visible (empty) in live mode — just reset the fill.
  el.meterFill.style.width = '0%';
  el.meterFill.classList.remove('clip');
  el.meterDb.textContent = '–∞';
}

// ---- Transport (mode-aware) ----
async function play() {
  if (mode === 'live') return startLive();

  const active = enabledChannels();
  if (!active.length) { setStatus('Select at least one speaker first.'); return; }
  if (!currentObjectUrl) return;

  // Build EQ graphs for any speakers with a (possibly restored) bass boost.
  for (const ch of active) if (ch.bass && !ch.fileGraph) await ensureFileGraph(ch);

  const ref = referenceChannel() || active[0];
  const base = ref.audio.currentTime;
  for (const ch of active) {
    if (ch === ref) continue; // reference is the timing anchor — matches syncTick
    // Compensate relative to the reference's OWN offset, so the reference's
    // delay-comp isn't silently dropped when it isn't the slowest speaker.
    const target = base - (ch.offsetMs - ref.offsetMs) / 1000; // +offset = earlier content = comes out later
    if (Math.abs(ch.audio.currentTime - target) > 0.02) ch.audio.currentTime = Math.max(0, target);
  }
  await Promise.allSettled(active.map((ch) => ch.audio.play()));

  isPlaying = true;
  playMode = 'file';
  setPlayState(true);
  setStatus(`Playing on ${active.length} speaker${active.length > 1 ? 's' : ''}.`);
  startBackdrop();
}

function pause() {
  stopBackdrop();
  if (playMode === 'live') {
    // Pause WITHOUT tearing down: mute the live nodes but keep their contexts
    // running so latency/phase stay fixed and Resume comes back in sync. (Stop,
    // via the Stop button, does the full teardown.)
    for (const ch of channels.values()) if (ch.live) ch.live.gain.gain.value = 0;
    stopMeter();
    setNetworkCapturePaused(true); // mute Sonos/AirPlay but keep them primed
    isPlaying = false;
    setPlayState(false);
    setLiveUI(false);
    setStatus('Live paused.');
    return;
  }
  for (const ch of channels.values()) ch.audio.pause();
  isPlaying = false;
  setPlayState(false);
  setStatus('Paused.');
}

function stop() {
  stopBackdrop();
  if (playMode === 'live') { stopLive(); isPlaying = false; setPlayState(false); setLiveUI(false); setStatus('Live stopped.'); return; }
  for (const ch of channels.values()) { ch.audio.pause(); ch.audio.currentTime = 0; }
  isPlaying = false;
  setPlayState(false);
  el.seek.value = '0';
  el.timeCurrent.textContent = '0:00';
  setStatus('Stopped.');
}

function togglePlay() { if (isPlaying) pause(); else play(); }

function seekTo(fraction) {
  const t = fraction * durationSec;
  const ref = referenceChannel();
  const refOff = ref ? ref.offsetMs : 0;
  for (const ch of channels.values()) {
    // Anchor at t, others compensated relative to the reference's own offset — matches syncTick.
    const target = t - (ch.offsetMs - refOff) / 1000;
    ch.audio.currentTime = Math.max(0, target);
  }
  el.timeCurrent.textContent = fmtTime(t);
}

// ---- Sync loop (file mode only) ----
function syncTick() {
  if (playMode !== 'file' || !isPlaying) return;
  const ref = referenceChannel();
  if (!ref) return;
  const base = ref.audio.currentTime;
  for (const ch of enabledChannels()) {
    if (ch === ref) continue;
    const target = base - (ch.offsetMs - ref.offsetMs) / 1000;
    if (Math.abs(ch.audio.currentTime - target) > DRIFT_THRESHOLD) ch.audio.currentTime = Math.max(0, target);
  }
  if (!seeking && durationSec > 0) {
    el.seek.value = String(Math.round((base / durationSec) * 1000));
    el.timeCurrent.textContent = fmtTime(base);
  }
}
setInterval(syncTick, 250);

// ---- Volume / bass application ----
function effectiveVol(ch) { return localMuted ? 0 : Math.min(1, ch.volume * masterVolume); }

/** Route a channel's level to whichever node owns its output (graph gain or element). */
function applyChannelVolume(ch) {
  const v = effectiveVol(ch);
  if (ch.fileGraph) { ch.fileGraph.gain.gain.value = v; ch.audio.volume = 1; }
  else ch.audio.volume = v;
  // A live node kept alive while disabled stays muted (preserves its phase).
  if (ch.live) ch.live.gain.gain.value = ch.enabled ? v : 0;
}

function applyVolumes() {
  for (const ch of channels.values()) applyChannelVolume(ch);
}

/**
 * Set a channel's bass boost (dB on a low-shelf). In live mode the filter is
 * already in the graph. In file mode there's no graph until you boost bass — so
 * the first nonzero value builds one (lazily, leaving untouched speakers alone).
 * @param {Channel} ch
 */
async function setBass(ch, db) {
  ch.bass = db;
  schedulePersist();
  if (ch.live && ch.live.filter) ch.live.filter.gain.value = db;
  if (ch.fileGraph) ch.fileGraph.filter.gain.value = db;
  else if (mode === 'file' && db !== 0) await ensureFileGraph(ch);
}

function sinkIdFor(deviceId) { return deviceId === 'default' ? '' : deviceId; }

/**
 * Build a Web Audio graph (element -> low-shelf -> gain -> device) for a file-mode
 * channel so it can be EQ'd. Routing moves from element.setSinkId to ctx.setSinkId.
 * Created once per channel; safe no-op if it already exists. Falls back gracefully.
 * @param {Channel} ch
 */
function ensureFileGraph(ch) {
  if (ch.fileGraph) return Promise.resolve(ch.fileGraph);
  if (ch._fileGraphP) return ch._fileGraphP; // build already in flight
  ch._fileGraphP = (async () => {
    let ctx;
    try {
      ctx = new AudioContext({ latencyHint: 'playback' });
      const src = ctx.createMediaElementSource(ch.audio);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowshelf';
      filter.frequency.value = BASS_FREQ;
      filter.gain.value = ch.bass;
      const gain = ctx.createGain();
      gain.gain.value = effectiveVol(ch);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      if (typeof ctx.setSinkId === 'function') {
        try { await ctx.setSinkId(sinkIdFor(ch.info.deviceId)); }
        catch (err) { setStatus(`Could not route "${ch.info.label}": ${err.message}`); }
      }
      await ctx.resume();
      ch.audio.volume = 1; // gain node owns level now
      ch.fileGraph = { ctx, src, filter, gain };
      return ch.fileGraph;
    } catch (err) {
      if (ctx) ctx.close().catch(() => {});
      setStatus(`Bass unavailable for "${ch.info.label}": ${err.message}`);
      return null;
    } finally {
      ch._fileGraphP = null;
    }
  })();
  return ch._fileGraphP;
}

// ---- Mode switching ----
function setMode(next) {
  if (next === mode) return;
  mode = next; // this only switches the VIEW — playback (playMode) keeps running

  const live = mode === 'live';
  el.btnModeFile.classList.toggle('active', !live);
  el.btnModeLive.classList.toggle('active', live);
  if (el.fileTransport) el.fileTransport.hidden = live;
  if (el.liveTransport) el.liveTransport.hidden = !live;
  el.btnPick.hidden = live; // "Open file" is file-mode only; Play/Stop are shared
  if (el.tpButtons) el.tpButtons.classList.toggle('live', live);

  // If something is playing, leave the transport/display alone — just changed tabs.
  if (isPlaying) return;
  if (live) setLiveUI(false);

  playMode = next; // idle: the next Play uses the viewed mode
  el.seek.disabled = live;
  if (live) {
    el.trackTitle.textContent = 'Live input';
    el.trackSub.textContent = 'Capture an input device and broadcast it live';
    el.timeCurrent.textContent = '–:––';
    el.timeTotal.textContent = '–:––';
    el.seek.value = '0';
    setPlayState(false);
    el.btnPlay.disabled = false;
    el.btnStop.disabled = false;
  } else {
    el.trackTitle.textContent = trackName || 'No track loaded';
    el.trackSub.textContent = trackName ? 'Ready' : 'Choose an audio file to begin';
    el.timeTotal.textContent = fmtTime(durationSec);
    setPlayState(false);
    el.btnPlay.disabled = !currentObjectUrl;
    el.btnStop.disabled = !currentObjectUrl;
  }
}

/** The play button is a CSS orb — toggle its glyph via a class instead of text. */
function setPlayState(playing) {
  if (el.btnPlay) el.btnPlay.classList.toggle('playing', playing);
}

/** Live transport view: idle (hint + "press Start") vs streaming (level + status). */
function setLiveUI(streaming) {
  if (el.tpButtons) el.tpButtons.classList.toggle('streaming', streaming);
  // Hint only when idle AND BlackHole isn't installed (nothing to explain otherwise).
  if (el.liveHint) el.liveHint.hidden = streaming || blackholeInstalled;
  if (el.tpsTitle) el.tpsTitle.textContent = streaming ? 'Streaming live input' : 'Live input';
  if (el.tpsSub) {
    const n = enabledChannels().length + selectedSonosRooms().length + selectedAirPlay().length;
    el.tpsSub.textContent = streaming ? `→ ${n} output${n !== 1 ? 's' : ''} · 48 kHz` : 'press Start to broadcast';
  }
}

// ---- Rendering the device list ----
function renderDevices() {
  el.deviceList.innerHTML = '';
  for (const ch of channels.values()) el.deviceList.appendChild(renderDeviceRow(ch));
  updateDevicesMeta();
}

/** Output Bus header readout: "local · N of M" (N ticked of M discovered). */
function updateDevicesMeta() {
  if (!el.devicesMeta) return;
  const total = channels.size;
  const on = enabledChannels().length;
  el.devicesMeta.textContent = total ? `local · ${on} of ${total}` : '';
}

/** @param {Channel} ch */
// ---- Console row primitives ----
function rowBadge(text, kind) {
  const b = document.createElement('span');
  b.className = 'rbadge' + (kind ? ` rbadge-${kind}` : '');
  b.textContent = text;
  return b;
}
function fmtDb(v) { const d = v > 0 ? 20 * Math.log10(v) : -Infinity; return isFinite(d) && d > -60 ? `${d.toFixed(1)} dB` : (v > 0 ? '−60 dB' : 'muted'); }

/** One console slider control: label + range (+ optional center-detent tick + value). */
function miniSlider(opts) {
  const g = document.createElement('div');
  g.className = 'ctrl';
  const lbl = document.createElement('span'); lbl.className = 'ctrl-lbl'; lbl.textContent = opts.label;
  const wrap = document.createElement('span'); wrap.className = 'slide-wrap';
  if (opts.detent) { const t = document.createElement('i'); t.className = 'detent-tick'; wrap.appendChild(t); }
  const input = document.createElement('input');
  input.type = 'range'; input.className = 'mini' + (opts.detent ? ' detent' : '');
  input.min = String(opts.min); input.max = String(opts.max); input.value = String(opts.value);
  wrap.appendChild(input);
  g.append(lbl, wrap);
  let valEl = null;
  if (opts.fmtVal) { valEl = document.createElement('span'); valEl.className = 'ctrl-val'; valEl.textContent = opts.fmtVal(opts.value); g.appendChild(valEl); }
  input.addEventListener('input', () => { const v = Number(input.value); if (valEl) valEl.textContent = opts.fmtVal(v); opts.onInput(v); });
  return g;
}

function renderDeviceRow(ch) {
  const li = document.createElement('li');
  li.className = 'device' + (ch.enabled ? ' active' : '');

  const head = document.createElement('div');
  head.className = 'row-head';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'cbx'; cb.checked = ch.enabled;
  cb.addEventListener('change', () => onToggleDevice(ch, cb, li));
  const name = document.createElement('span');
  name.className = 'row-name'; name.textContent = ch.info.label;
  head.append(cb, name);
  if (ch.info.isDefault) head.appendChild(rowBadge('DEFAULT', 'default'));
  const spacer = document.createElement('span'); spacer.className = 'row-spacer';
  const db = document.createElement('span'); db.className = 'row-db'; db.textContent = fmtDb(ch.volume);
  head.append(spacer, db);

  const ctrls = document.createElement('div');
  ctrls.className = 'row-ctrls';
  ctrls.append(
    miniSlider({ label: 'VOL', min: 0, max: 100, value: Math.round(ch.volume * 100), onInput: (v) => { ch.volume = v / 100; applyChannelVolume(ch); db.textContent = fmtDb(ch.volume); schedulePersist(); } }),
    miniSlider({ label: 'BASS', min: -BASS_MAX_DB, max: BASS_MAX_DB, value: ch.bass, detent: true, fmtVal: (v) => (v > 0 ? `+${v}` : `${v}`), onInput: (v) => setBass(ch, v) }),
  );

  li.append(head, ctrls, delayControl(ch));
  return li;
}

async function onToggleDevice(ch, cb, li) {
  ch.enabled = cb.checked;
  li.classList.toggle('active', ch.enabled);
  updateDevicesMeta();
  schedulePersist(); // remember the selection across sessions

  if (mode === 'live') {
    if (ch.enabled) {
      if (isPlaying && liveStream) { await buildLiveNode(ch); applyChannelVolume(ch); }
    } else {
      disableLiveNode(ch); // mute, keep the context alive to preserve sync
    }
    return;
  }

  // file mode
  if (ch.enabled && currentObjectUrl && ch.audio.src !== currentObjectUrl) await attachSource(ch);
  if (ch.enabled && ch.bass && !ch.fileGraph) await ensureFileGraph(ch);
  if (ch.enabled && isPlaying) {
    await applySink(ch);
    const ref = referenceChannel();
    if (ref) ch.audio.currentTime = Math.max(0, ref.audio.currentTime - ch.offsetMs / 1000);
    ch.audio.play().catch(() => {});
  } else if (!ch.enabled) {
    ch.audio.pause();
  }
}

function sliderGroup(label, min, max, value, unit, onInput) {
  const g = document.createElement('div');
  g.className = 'slider-group';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = value + unit;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = v + unit;
    onInput(v);
  });
  g.appendChild(l);
  g.appendChild(input);
  g.appendChild(val);
  return g;
}

/**
 * Delay-comp control: nudge buttons + a type-in number box + a coarse slider.
 * The slider alone is impossible to fine-tune over a ±3 s range, so the buttons
 * (±10 / ±100 ms) and the number field are the precise way in.
 * @param {Channel} ch
 */
function delayControl(ch) {
  const g = document.createElement('div');
  g.className = 'delaycomp';

  // head: label + a cyan ms field (lights up when non-zero)
  const head = document.createElement('div'); head.className = 'dc-head';
  const lbl = document.createElement('span'); lbl.className = 'dc-lbl'; lbl.textContent = 'DELAY COMP';
  const field = document.createElement('div'); field.className = 'dc-field';
  const num = document.createElement('input');
  num.type = 'number'; num.className = 'dc-num';
  num.min = String(-DELAY_COMP_RANGE); num.max = String(DELAY_COMP_RANGE); num.step = '10'; num.value = String(ch.offsetMs);
  const unit = document.createElement('span'); unit.className = 'dc-unit'; unit.textContent = 'ms';
  field.append(num, unit);
  head.append(lbl, field);

  // nudges
  const nudges = document.createElement('div'); nudges.className = 'dc-nudges';
  // center-detent slider
  const slideWrap = document.createElement('span'); slideWrap.className = 'slide-wrap';
  const tick = document.createElement('i'); tick.className = 'detent-tick'; slideWrap.appendChild(tick);
  const slider = document.createElement('input');
  slider.type = 'range'; slider.className = 'mini detent';
  slider.min = String(-DELAY_COMP_RANGE); slider.max = String(DELAY_COMP_RANGE); slider.step = '10'; slider.value = String(ch.offsetMs);
  slideWrap.appendChild(slider);

  // size the number input to its content so the field hugs the value (matches design)
  const sizeNum = () => { num.style.width = `calc(${Math.max(1, String(num.value).length)}ch + 4px)`; };
  const apply = (v) => {
    v = Math.max(-DELAY_COMP_RANGE, Math.min(DELAY_COMP_RANGE, Math.round(v)));
    ch.offsetMs = v;
    slider.value = String(v); num.value = String(v);
    field.classList.toggle('nonzero', v !== 0);
    sizeNum();
    if (ch.live) ch.live.delay.delayTime.value = clampDelay(v);
    schedulePersist();
  };
  const nudge = (label, step) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nudge'; b.textContent = label;
    b.title = `${step > 0 ? '+' : ''}${step} ms`;
    b.addEventListener('click', () => apply(ch.offsetMs + step));
    return b;
  };
  nudges.append(nudge('−100', -100), nudge('−10', -10), nudge('+10', 10), nudge('+100', 100));
  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('input', () => apply(Number(num.value)));
  field.classList.toggle('nonzero', ch.offsetMs !== 0);
  sizeNum();

  g.append(head, nudges, slideWrap);
  return g;
}

// ---- Auto-sync: measure each speaker's latency with the mic, set Delay comp ----
//
// Plays a short log-sweep "chirp" on one speaker at a time, records it through the
// Mac's microphone, and cross-correlates the recording against the known chirp to
// find when it arrived. The mic's own latency is constant across speakers, so it
// cancels out — only the RELATIVE differences matter. We then delay every speaker
// to match the slowest, writing the result into each Delay comp.
let autoSyncing = false;
/** @type {?{local: Array<{ch: Channel, offsetMs: number}>, sonos: number}} */
let autoSyncBackup = null;
const CHIRP_SEC = 0.15;
const WARMUP_SEC = 1.0;     // quiet pre-roll to wake Bluetooth links before the chirp
const LOCAL_REC_SEC = 3.0;  // warm-up + high-latency device + chirp + margin
const SONOS_REC_SEC = 3.5;  // Sonos buffers ~1.5–2 s, so record longer
const AIRPLAY_REC_SEC = 4.0; // AirPlay TVs (e.g. The Frame) can buffer ~2 s — record longer still

/** Fill an array with a windowed 800 Hz→6 kHz sweep at `sampleRate`. */
function fillChirp(arr, sampleRate, durSec) {
  const n = arr.length;
  const f0 = 800; const f1 = 6000; const k = (f1 - f0) / durSec;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n)); // Hann window
    arr[i] = Math.sin(phase) * w * 0.5;
  }
}

/** Chirp as 16-bit stereo PCM at `rate` (for injecting into the Sonos stream). */
function makeChirpPcm(rate) {
  const f = new Float32Array(Math.floor(rate * CHIRP_SEC));
  fillChirp(f, rate, CHIRP_SEC);
  const pcm = new Int16Array(f.length * 2);
  for (let i = 0; i < f.length; i++) {
    const s = f[i] < 0 ? f[i] * 0x8000 : f[i] * 0x7fff;
    pcm[i * 2] = s; pcm[i * 2 + 1] = s;
  }
  return pcm;
}

async function pickMicDeviceId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const real = inputs.find((d) => !/blackhole/i.test(d.label)); // avoid the loopback
  return (real || inputs[0] || {}).deviceId || '';
}

/** Cross-correlate a recording against the chirp; return arrival lag in seconds. */
function correlateLagSec(recorded, recRate, maxLagSec) {
  const DOWN = 4;                    // decimate to speed up the correlation
  const rate = recRate / DOWN;
  const tn = Math.floor(rate * CHIRP_SEC);
  const tmpl = new Float32Array(tn);
  fillChirp(tmpl, rate, CHIRP_SEC);
  const rn = Math.floor(recorded.length / DOWN);
  const rec = new Float32Array(rn);
  for (let i = 0; i < rn; i++) {
    let s = 0; for (let j = 0; j < DOWN; j++) s += recorded[i * DOWN + j] || 0;
    rec[i] = s / DOWN;
  }
  const maxLag = Math.min(rn - tn, Math.floor(rate * maxLagSec));
  let bestLag = 0; let best = -Infinity;
  for (let lag = 0; lag < maxLag; lag++) {
    let sum = 0;
    for (let j = 0; j < tn; j++) sum += tmpl[j] * rec[lag + j];
    if (sum > best) { best = sum; bestLag = lag; }
  }
  return bestLag / rate;
}

/**
 * Record the mic for `recSec`, calling `onStart()` the instant recording begins
 * (that's the emit moment), then cross-correlate to find the chirp's arrival lag.
 */
async function recordAndMeasure(micStream, recSec, onStart) {
  const recCtx = new AudioContext();
  const micSrc = recCtx.createMediaStreamSource(micStream);
  const proc = recCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let recording = false;
  proc.onaudioprocess = (e) => { if (recording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  const sink = recCtx.createGain(); sink.gain.value = 0;
  micSrc.connect(proc); proc.connect(sink); sink.connect(recCtx.destination);
  await recCtx.resume();

  recording = true;
  if (onStart) onStart();
  await new Promise((r) => setTimeout(r, recSec * 1000));
  recording = false;

  let total = 0; for (const c of chunks) total += c.length;
  const rec = new Float32Array(total);
  let o = 0; for (const c of chunks) { rec.set(c, o); o += c.length; }
  const recRate = recCtx.sampleRate;
  try { proc.disconnect(); micSrc.disconnect(); sink.disconnect(); } catch {}
  recCtx.close().catch(() => {});
  return total ? correlateLagSec(rec, recRate, recSec - CHIRP_SEC - 0.1) : 0;
}

/**
 * Local OS speaker: play [warm-up tone + chirp] via its own context and record
 * via the mic. The warm-up wakes Bluetooth speakers (which mute the first moment
 * of audio after silence) so the chirp actually comes out; we subtract its known
 * length from the measured arrival.
 */
async function measureLocalLatencySec(ch, micStream) {
  const playCtx = new AudioContext();
  let routed = true;
  try { if (playCtx.setSinkId) await playCtx.setSinkId(ch.info.deviceId); } catch { routed = false; }
  if (!routed) setStatus(`Auto-sync: couldn't route to "${ch.info.label}".`);

  const rate = playCtx.sampleRate;
  const warmN = Math.floor(rate * WARMUP_SEC);
  const chirpN = Math.floor(rate * CHIRP_SEC);
  const buf = playCtx.createBuffer(1, warmN + chirpN, rate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < warmN; i++) data[i] = Math.sin((2 * Math.PI * 150 * i) / rate) * 0.15; // wake BT
  const chirp = new Float32Array(chirpN);
  fillChirp(chirp, rate, CHIRP_SEC);
  data.set(chirp, warmN);

  await playCtx.resume();
  const lag = await recordAndMeasure(micStream, LOCAL_REC_SEC, () => {
    const src = playCtx.createBufferSource();
    src.buffer = buf; src.connect(playCtx.destination); src.start();
  });
  playCtx.close().catch(() => {});
  return Math.max(0, lag - WARMUP_SEC); // chirp sits WARMUP_SEC into the buffer
}

/**
 * Sonos: stream silence to the room until its buffer reaches steady state, then
 * inject the chirp into that same live stream and time its arrival via the mic.
 * Measures the real broadcast latency the live audio will experience.
 */
async function measureSonosLatencySec(room, micStream) {
  const rate = 44100;
  const silence = new Int16Array(Math.round(rate * 0.05) * 2); // 50 ms of zeros
  const chirp = makeChirpPcm(rate);
  const res = await window.api.sonosPlay([roomPayload(room)]);
  if (!res || !res.ok) return null;
  const feed = setInterval(() => window.api.sendSonosPcm(silence.buffer), 50);
  try {
    await new Promise((r) => setTimeout(r, 5000)); // let Sonos reach steady-state buffering
    return await recordAndMeasure(micStream, SONOS_REC_SEC, () => window.api.sendSonosPcm(chirp.buffer));
  } finally {
    clearInterval(feed);
    await window.api.sonosStop([roomPayload(room)]);
  }
}

/**
 * AirPlay: stream silence to the receiver until its buffer is steady, then inject
 * the chirp into that same live stream and time its arrival via the mic — the real
 * broadcast latency the live audio will experience (TVs can be ~2 s behind).
 */
async function measureAirPlayLatencySec(receiver, micStream) {
  const rate = 44100;
  const silence = new Int16Array(Math.round(rate * 0.05) * 2); // 50 ms of zeros
  const chirp = makeChirpPcm(rate);
  const res = await window.api.airplayPlay([airplayPayload(receiver)]);
  if (!res || !res.ok) return null;
  const feed = setInterval(() => window.api.sendAirPlayPcm(silence.buffer), 50);
  try {
    await new Promise((r) => setTimeout(r, 5000)); // let AirPlay reach steady-state buffering
    return await recordAndMeasure(micStream, AIRPLAY_REC_SEC, () => window.api.sendAirPlayPcm(chirp.buffer));
  } finally {
    clearInterval(feed);
    await window.api.airplayStop([airplayKey(receiver)]);
  }
}

/**
 * Measure a network bus (Sonos / AirPlay) that's ALREADY connected via the live
 * capture and is currently muted/silent during an auto-sync soft-pause. We inject
 * the chirp straight into the live pipe — the receivers are never stopped or
 * re-added, so AirPlay never re-pairs and Sonos never re-buffers.
 */
async function measureBusLatencyLive(micStream, sendPcm) {
  const chirp = makeChirpPcm(44100);
  await new Promise((r) => setTimeout(r, 1200)); // let the (now-silent) buffer settle
  return await recordAndMeasure(micStream, AIRPLAY_REC_SEC, () => sendPcm(chirp.buffer));
}

function refreshSonosControls() {
  el.sonosControls.innerHTML = '';
  mountSonosControls();
}

function refreshAirPlayControls() {
  el.airplayControls.innerHTML = '';
  mountAirPlayControls();
}

/**
 * Reset delays. If an Auto-sync run is in memory, restore the values from just
 * before it (a true undo). Otherwise clear ALL Delay comps + the Sonos group
 * delay to 0 for a clean slate to re-tune from.
 */
function undoAutoSync() {
  if (autoSyncBackup) {
    for (const { ch, offsetMs } of autoSyncBackup.local) {
      ch.offsetMs = offsetMs;
      if (ch.live) ch.live.delay.delayTime.value = clampDelay(offsetMs);
    }
    setSonosDelay(autoSyncBackup.sonos);
    if (typeof autoSyncBackup.airplay === 'number') setAirplayDelay(autoSyncBackup.airplay);
    autoSyncBackup = null;
    setStatus('Reverted to your delays from before Auto-sync.');
  } else {
    for (const ch of channels.values()) {
      ch.offsetMs = 0;
      if (ch.live) ch.live.delay.delayTime.value = 0;
    }
    setSonosDelay(0);
    setAirplayDelay(0);
    setStatus('All delays reset to 0 — re-tune from scratch.');
  }
  refreshSonosControls();
  refreshAirPlayControls();
  persistPrefs();
  renderDevices();
  el.btnAutoSync.textContent = '⊕ Auto-sync';
}

async function autoSync() {
  if (autoSyncing) return;
  const locals = enabledChannels();
  const rooms = selectedSonosRooms();
  const receivers = selectedAirPlay();
  if (locals.length + rooms.length + receivers.length < 2) {
    setStatus('Tick at least 2 speakers (Sonos / AirPlay count), then Auto-sync.');
    return;
  }

  autoSyncing = true;
  el.btnAutoSync.disabled = true;
  // Don't measure over live audio. For a LIVE session, soft-pause instead of a
  // full stop: keep the network buses connected (silent) so AirPlay never
  // re-pairs and Sonos never re-buffers — we'll inject the chirp into the live
  // pipe and restore the session afterward.
  const wasLive = playMode === 'live' && !!liveStream; // a live session is set up (playing OR paused)
  const wasPlaying = isPlaying;
  if (wasLive) {
    setNetworkCapturePaused(true);
    for (const ch of channels.values()) if (ch.live) ch.live.gain.gain.value = 0;
    isPlaying = false;
    stopBackdrop();
  } else if (isPlaying) {
    stop();
  }

  let micStream;
  try {
    const micId = await pickMicDeviceId();
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId }, ...base } : base });
  } catch (err) {
    setStatus(`Auto-sync needs microphone access: ${err.message}`);
    autoSyncing = false; el.btnAutoSync.disabled = false;
    return;
  }

  try {
    const local = [];
    for (let i = 0; i < locals.length; i++) {
      const ch = locals[i];
      setStatus(`Auto-sync: measuring "${ch.info.label}" (${i + 1}/${locals.length})…`);
      let lat = 0;
      try { lat = await measureLocalLatencySec(ch, micStream); } catch { /* skip */ }
      local.push({ ch, lat });
      await new Promise((r) => setTimeout(r, 250)); // let echoes settle
    }

    // The Sonos rooms are grouped and tight, so one measurement (the coordinator)
    // represents the whole group; the group delay then shifts them together.
    let sonosLat = null;
    if (rooms.length) {
      setStatus('Auto-sync: measuring Sonos (this takes a few seconds)…');
      try {
        sonosLat = (wasLive && sonosActive.length)
          ? await measureBusLatencyLive(micStream, window.api.sendSonosPcm)
          : await measureSonosLatencySec(rooms[0], micStream);
      } catch { /* skip */ }
    }

    // AirPlay rides one shared group delay (like Sonos), so one representative
    // measurement shifts the whole AirPlay set together. While live, measure
    // through the existing connection so the receivers are never re-paired.
    let airplayLat = null;
    if (receivers.length) {
      setStatus('Auto-sync: measuring AirPlay (this takes a few seconds)…');
      try {
        airplayLat = (wasLive && airplayActive.length)
          ? await measureBusLatencyLive(micStream, window.api.sendAirPlayPcm)
          : await measureAirPlayLatencySec(receivers[0], micStream);
      } catch { /* skip */ }
    }

    // Snapshot the current delays BEFORE overwriting, so a bad run can be undone.
    autoSyncBackup = {
      local: local.map((r) => ({ ch: r.ch, offsetMs: r.ch.offsetMs })),
      sonos: sonosDelayMs,
      airplay: airplayDelayMs,
    };

    const allLats = local.map((r) => r.lat)
      .concat(sonosLat != null ? [sonosLat] : [])
      .concat(airplayLat != null ? [airplayLat] : []);
    const maxLat = Math.max(...allLats);
    for (const { ch, lat } of local) {
      ch.offsetMs = Math.max(0, Math.min(DELAY_COMP_RANGE, Math.round((maxLat - lat) * 1000)));
      if (ch.live) ch.live.delay.delayTime.value = clampDelay(ch.offsetMs);
    }
    if (sonosLat != null) { setSonosDelay(Math.round((maxLat - sonosLat) * 1000)); refreshSonosControls(); }
    if (airplayLat != null) { setAirplayDelay(Math.round((maxLat - airplayLat) * 1000)); refreshAirPlayControls(); }

    persistPrefs();
    renderDevices();
    const parts = local.map((r) => `${r.ch.info.label}: ${r.ch.offsetMs}ms`);
    if (sonosLat != null) parts.push(`Sonos: ${sonosDelayMs}ms`);
    if (airplayLat != null) parts.push(`AirPlay: ${airplayDelayMs}ms`);
    setStatus(`Auto-sync done — ${parts.join(', ')}. Not better? Click “↩ Undo sync”.`);
  } finally {
    micStream.getTracks().forEach((t) => t.stop());
    if (wasLive && wasPlaying) {
      // Resume the live session exactly as it was — the buses were never dropped.
      setNetworkCapturePaused(false);
      for (const ch of enabledChannels()) applyChannelVolume(ch);
      isPlaying = true;
      playMode = 'live';
      setPlayState(true);
      startBackdrop();
    }
    // If it was PAUSED before, leave the buses connected-but-silent (as they were).
    autoSyncing = false;
    el.btnAutoSync.disabled = false;
  }
}

// ---- Visualizer (audio-reactive animation overlay) ----
let visualizer = null;
let vizCleanup = null;

// Subtle backdrop behind the whole UI — only runs while audio is playing.
let bgVisualizer = null;
let bgCleanup = null;

/** A non-invasive audio tap (won't reroute file playback): live stream or an
 *  already-built file graph, else null (gentle idle drift). */
function audioTapNonInvasive() {
  if (liveStream) {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(liveStream);
    const an = ctx.createAnalyser();
    src.connect(an);
    return { analyser: an, cleanup: () => { try { src.disconnect(); } catch {} ctx.close().catch(() => {}); } };
  }
  const ref = referenceChannel();
  if (ref && ref.fileGraph) {
    const an = ref.fileGraph.ctx.createAnalyser();
    ref.fileGraph.gain.connect(an);
    return { analyser: an, cleanup: () => { try { ref.fileGraph.gain.disconnect(an); } catch {} } };
  }
  return { analyser: null, cleanup: null };
}

// ---- Output VU meters (real levels) ----
let vuRaf = 0; let vuCleanup = null; let vuAnalyser = null; let vuBuf = null; let vuLv = 0; let vuRv = 0;
async function startVU() {
  if (vuAnalyser) return;
  // Ensure a tap exists — in file mode, route the reference through Web Audio
  // (same path the visualizer/bass use) so the meter has signal.
  if (!liveStream) { const ref = referenceChannel(); if (ref && !ref.fileGraph) { try { await ensureFileGraph(ref); } catch {} } }
  const tap = audioTapNonInvasive();
  if (!tap.analyser) return;
  vuAnalyser = tap.analyser; vuCleanup = tap.cleanup;
  vuAnalyser.fftSize = 1024; vuAnalyser.smoothingTimeConstant = 0.4;
  vuBuf = new Float32Array(vuAnalyser.fftSize);
  const tick = () => {
    if (!vuAnalyser) return;
    vuAnalyser.getFloatTimeDomainData(vuBuf);
    let sum = 0; for (let i = 0; i < vuBuf.length; i++) sum += vuBuf[i] * vuBuf[i];
    const rms = Math.sqrt(sum / vuBuf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -60;
    const frac = Math.max(0, Math.min(1, (db + 50) / 50));
    vuLv = frac > vuLv ? frac : vuLv * 0.86 + frac * 0.14;            // fast attack, slow release
    vuRv = frac > vuRv ? frac * 0.96 : vuRv * 0.83 + frac * 0.17;     // slight L/R divergence
    if (el.vuL) el.vuL.style.width = `${(vuLv * 100).toFixed(1)}%`;
    if (el.vuR) el.vuR.style.width = `${(vuRv * 100).toFixed(1)}%`;
    vuRaf = requestAnimationFrame(tick);
  };
  vuRaf = requestAnimationFrame(tick);
}
function stopVU() {
  if (vuRaf) { cancelAnimationFrame(vuRaf); vuRaf = 0; }
  if (vuCleanup) { try { vuCleanup(); } catch {} vuCleanup = null; }
  vuAnalyser = null; vuBuf = null; vuLv = 0; vuRv = 0;
  if (el.vuL) el.vuL.style.width = '0%';
  if (el.vuR) el.vuR.style.width = '0%';
}

function startBackdrop() {
  document.body.classList.add('is-playing'); // lights the tally lamps + Play bias glow
  if (el.transportStatus) el.transportStatus.textContent = 'playing';
  startVU();
  if (!el.vizOverlay.hidden) return; // fullscreen overlay is up; backdrop hidden anyway
  if (!bgVisualizer) bgVisualizer = new Visualizer(el.bgCanvas, { background: true });
  if (bgCleanup) { bgCleanup(); bgCleanup = null; }
  el.bgCanvas.style.display = 'block';
  const tap = audioTapNonInvasive();
  bgCleanup = tap.cleanup;
  bgVisualizer.start(tap.analyser);
}
function stopBackdrop() {
  document.body.classList.remove('is-playing');
  if (el.transportStatus) el.transportStatus.textContent = 'standby';
  stopVU();
  if (bgVisualizer) bgVisualizer.stop();
  if (bgCleanup) { bgCleanup(); bgCleanup = null; }
  el.bgCanvas.style.display = 'none'; // reveal the ambient background when idle
}

/** Tap whatever audio is currently playing so the visualizer can react to it. */
async function makeVizAnalyser() {
  if (liveStream) {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(liveStream);
    const an = ctx.createAnalyser();
    src.connect(an);
    vizCleanup = () => { try { src.disconnect(); } catch {} ctx.close().catch(() => {}); };
    return an;
  }
  // File mode: tap the reference speaker's Web Audio graph (building it if needed
  // so the visualizer reacts even when no bass boost is set).
  if (mode === 'file' && currentObjectUrl) {
    const ref = referenceChannel();
    const graph = ref && (ref.fileGraph || await ensureFileGraph(ref));
    if (graph) {
      const an = graph.ctx.createAnalyser();
      graph.gain.connect(an);
      vizCleanup = () => { try { graph.gain.disconnect(an); } catch {} };
      return an;
    }
  }
  vizCleanup = null;
  return null; // no audio source — visualizer runs an idle drift
}

async function openVisualizer() {
  if (!visualizer) visualizer = new Visualizer(el.vizCanvas, { ride: true });
  window.visualizer = visualizer; // exposed for debugging / dev capture
  stopBackdrop(); // the overlay covers it — don't waste cycles
  el.vizOverlay.hidden = false;
  el.vizTitle.textContent = ''; // keep the visualizer immersive — no label overlay
  // Go true fullscreen (button click is a valid user gesture for the API).
  if (el.vizOverlay.requestFullscreen) el.vizOverlay.requestFullscreen().catch(() => {});
  visualizer.start(await makeVizAnalyser());
}

function closeVisualizer() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (visualizer) visualizer.stop();
  if (vizCleanup) { vizCleanup(); vizCleanup = null; }
  el.vizOverlay.hidden = true;
  if (isPlaying) startBackdrop(); // backdrop only while playing
}

function toggleVisualizer() { if (el.vizOverlay.hidden) openVisualizer(); else closeVisualizer(); }

// ---- Wire up UI ----
el.btnPick.addEventListener('click', loadFile);
el.btnViz.addEventListener('click', toggleVisualizer);
el.vizClose.addEventListener('click', closeVisualizer);
document.addEventListener('keydown', (e) => {
  if (el.vizOverlay.hidden) return;
  if (e.key === 'Escape') closeVisualizer();
  else if (e.key === 'ArrowRight') { e.preventDefault(); visualizer && visualizer.nextScene(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); visualizer && visualizer.prevScene(); }
});
el.btnAutoSync.addEventListener('click', autoSync);
el.btnAutoSyncUndo.addEventListener('click', undoAutoSync);
el.btnPlay.addEventListener('click', togglePlay);
el.btnStop.addEventListener('click', stop);
el.btnRescan.addEventListener('click', scanDevices);
el.btnModeFile.addEventListener('click', () => setMode('file'));
el.btnModeLive.addEventListener('click', () => setMode('live'));
el.inputSelect.addEventListener('change', () => {
  inputDeviceId = el.inputSelect.value;
  if (mode === 'live' && isPlaying) { stopLive(); isPlaying = false; setPlayState(false); setStatus('Input changed — press Start.'); }
});

el.masterVol.addEventListener('input', () => {
  masterVolume = Number(el.masterVol.value) / 100;
  if (el.masterDb) el.masterDb.textContent = masterVolume > 0 ? `${(20 * Math.log10(masterVolume)).toFixed(1)}` : '–∞';
  applyVolumes();
});

el.seek.addEventListener('mousedown', () => { seeking = true; });
el.seek.addEventListener('input', () => { el.timeCurrent.textContent = fmtTime((Number(el.seek.value) / 1000) * durationSec); });
el.seek.addEventListener('change', () => { seekTo(Number(el.seek.value) / 1000); seeking = false; });

navigator.mediaDevices.addEventListener('devicechange', scanDevices);

// Release the live input + AudioContexts and stop the network broadcasts when the
// window unloads (the main process also stops Sonos/AirPlay as a backstop).
window.addEventListener('beforeunload', () => { try { stopLive(); } catch {} });

// ---- Sonos (network) discovery + streaming ----
/** @type {Array<{id:string, ip:string, roomName:string, model:string}>} */
let sonosRooms = [];
/** @type {Set<string>} enabled room ids (restored from last session) */
const SONOS_SEL_KEY = 'serializer.sonosSelected.v1';
const sonosEnabled = new Set(loadIdSet(SONOS_SEL_KEY));
function persistSonosSel() { try { localStorage.setItem(SONOS_SEL_KEY, JSON.stringify([...sonosEnabled])); } catch {} }
/** @type {?{ctx: AudioContext, src: MediaStreamAudioSourceNode, delay: DelayNode, node: AudioNode, zero: GainNode}} */
let sonosCapture = null;
/** @type {?Promise<any>} guards against concurrent (async) capture builds */
let sonosCaptureBuilding = null;

// Group-wide delay applied to the audio we stream to Sonos (Sonos can only be
// pushed later, so 0..SONOS_MAX_DELAY ms). Persisted across sessions.
const SONOS_MAX_DELAY = 8000;
const SONOS_DELAY_KEY = 'serializer.sonosDelay.v1';
let sonosDelayMs = (() => {
  const v = parseInt(localStorage.getItem(SONOS_DELAY_KEY) || '0', 10);
  return isNaN(v) ? 0 : Math.max(0, Math.min(SONOS_MAX_DELAY, v));
})();

const persistSonosDelay = debounce(() => {
  try { localStorage.setItem(SONOS_DELAY_KEY, String(sonosDelayMs)); } catch {}
}, 400);
function setSonosDelay(ms) {
  sonosDelayMs = Math.max(0, Math.min(SONOS_MAX_DELAY, Math.round(ms)));
  // Smooth ramp instead of a hard jump, so retiming mid-stream doesn't click.
  if (sonosCapture && sonosCapture.delay) {
    const t = sonosCapture.ctx.currentTime;
    sonosCapture.delay.delayTime.setTargetAtTime(sonosDelayMs / 1000, t, 0.03);
  }
  persistSonosDelay();
}

/** @type {Array<{id:string, ip:string, roomName:string}>} rooms currently told to play */
let sonosActive = [];
function roomPayload(r) { return { id: r.id, ip: r.ip, roomName: r.roomName }; }
// Insertion order (NOT alphabetical) keeps the group coordinator stable as rooms
// are added — the first room ticked stays the coordinator.
function selectedSonosRooms() {
  return [...sonosEnabled].map((id) => sonosRooms.find((r) => r.id === id)).filter(Boolean);
}

/**
 * Tap the live BlackHole stream, downmix/convert to 16-bit stereo PCM at 44.1 kHz,
 * and ship each block to the main process (which fans it out to the Sonos clients).
 * Connected through a zero-gain node so it drives the graph without making sound.
 */
async function buildSonosCapture() {
  if (sonosCapture) return sonosCapture;
  if (sonosCaptureBuilding) return sonosCaptureBuilding;
  if (!liveStream) return null;
  sonosCaptureBuilding = (async () => {
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 44100 });
      const src = ctx.createMediaStreamSource(liveStream);
      const muteGain = ctx.createGain();           // gated on pause (silence, keeps the stream primed)
      muteGain.gain.value = networkCapturePaused ? 0 : 1;
      const delay = ctx.createDelay(SONOS_MAX_DELAY / 1000);
      delay.delayTime.value = sonosDelayMs / 1000;
      const zero = ctx.createGain();
      zero.gain.value = 0;

      let node;
      try {
        // Preferred: capture on the audio thread, immune to main-thread jank.
        await ctx.audioWorklet.addModule('sonos-capture-worklet.js');
        node = new AudioWorkletNode(ctx, 'sonos-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (e) => window.api.sendSonosPcm(e.data);
      } catch (err) {
        // Fallback: main-thread ScriptProcessor if the worklet can't load.
        node = ctx.createScriptProcessor(4096, 2, 1);
        node.onaudioprocess = (e) => {
          const inp = e.inputBuffer;
          const L = inp.getChannelData(0);
          const R = inp.numberOfChannels > 1 ? inp.getChannelData(1) : L;
          const pcm = new Int16Array(L.length * 2);
          for (let i = 0; i < L.length; i++) {
            const l = Math.max(-1, Math.min(1, L[i]));
            const r = Math.max(-1, Math.min(1, R[i]));
            pcm[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
            pcm[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
          }
          window.api.sendSonosPcm(pcm.buffer);
        };
        console.warn('Sonos capture worklet unavailable, using ScriptProcessor:', err.message);
      }

      src.connect(muteGain);
      muteGain.connect(delay);
      delay.connect(node);
      node.connect(zero);
      zero.connect(ctx.destination);
      await ctx.resume();
      sonosCapture = { ctx, src, muteGain, delay, node, zero };
      return sonosCapture;
    } catch (err) {
      if (ctx) ctx.close().catch(() => {});
      setStatus(`Sonos audio capture failed: ${err.message}`);
      return null;
    } finally {
      sonosCaptureBuilding = null; // clear the guard even on failure (allow retry)
    }
  })();
  return sonosCaptureBuilding;
}

function teardownSonosCapture() {
  if (!sonosCapture) return;
  try {
    if (sonosCapture.node.port) sonosCapture.node.port.onmessage = null;
    if ('onaudioprocess' in sonosCapture.node) sonosCapture.node.onaudioprocess = null;
    sonosCapture.src.disconnect();
    sonosCapture.muteGain.disconnect();
    sonosCapture.delay.disconnect();
    sonosCapture.node.disconnect();
    sonosCapture.zero.disconnect();
  } catch {}
  sonosCapture.ctx.close().catch(() => {});
  sonosCapture = null;
  sonosCaptureBuilding = null;
}

/**
 * Re-sync the Sonos group to the current selection. The capture keeps running
 * across changes (no gap), rooms dropped from the selection are ungrouped, and
 * the rest are (re)grouped under a stable coordinator.
 */
let sonosRefreshChain = Promise.resolve();
function refreshSonosStream() {
  // Serialize: rapid check/uncheck must not interleave and race `sonosActive`.
  return (sonosRefreshChain = sonosRefreshChain.then(runRefreshSonosStream, runRefreshSonosStream));
}
async function runRefreshSonosStream() {
  if (mode !== 'live' || !isPlaying || !liveStream) return;
  const rooms = selectedSonosRooms();
  if (!rooms.length) { await stopSonosStream(); return; }
  await buildSonosCapture(); // no-op if already running
  const keep = new Set(rooms.map((r) => r.id));
  const removed = sonosActive.filter((r) => !keep.has(r.id));
  if (removed.length) await window.api.sonosStop(removed.map(roomPayload));
  const res = await window.api.sonosPlay(rooms.map(roomPayload));
  sonosActive = rooms;
  if (!res || !res.ok) setStatus(`Sonos error: ${(res && res.error) || 'failed'}`);
  else { setStatus(`Streaming to Sonos: ${rooms.map((r) => r.roomName).join(', ')}.`); el.sonosWarn.hidden = false; }
}

async function stopSonosStream() {
  teardownSonosCapture();
  if (sonosActive.length) await window.api.sonosStop(sonosActive.map(roomPayload));
  sonosActive = [];
  el.sonosWarn.hidden = true;
}

async function findSonos() {
  if (!window.api || !window.api.discoverSonos) return;
  el.btnFindSonos.disabled = true;
  const doneDiscover = flashDiscovering(el.sonosDiscover);
  el.sonosHint.textContent = 'Searching your network for Sonos rooms…';
  try {
    sonosRooms = await window.api.discoverSonos();
  } catch (err) {
    sonosRooms = [];
    el.sonosHint.textContent = `Sonos search failed: ${err.message}`;
    el.btnFindSonos.disabled = false;
    doneDiscover();
    return;
  }
  renderSonos();
  el.btnFindSonos.disabled = false;
  doneDiscover();
}

function renderSonos() {
  el.sonosList.innerHTML = '';
  if (!sonosRooms.length) {
    el.sonosHint.textContent = 'No Sonos rooms found. Make sure they’re powered on and on the same network, then press Find Sonos.';
    return;
  }
  el.sonosHint.textContent = `${sonosRooms.length} Sonos room${sonosRooms.length > 1 ? 's' : ''} found. Tick rooms and use 🎙 Live input to broadcast to them.`;
  mountSonosControls();
  for (const room of sonosRooms) el.sonosList.appendChild(renderSonosRow(room));
}

/** One-time mount of the group-wide delay control, pinned to the panel bottom. */
function mountSonosControls() {
  if (el.sonosControls.childElementCount) { el.sonosControls.hidden = false; return; }
  el.sonosControls.appendChild(groupDelayControl(() => sonosDelayMs, setSonosDelay, SONOS_MAX_DELAY));
  el.sonosControls.hidden = false;
}

/**
 * Console "GROUP DELAY" row: label · nudges · fill slider · ms field.
 * add-only 0..max ms. `get` reads the live value, `set` clamps + applies it.
 */
function groupDelayControl(get, set, max) {
  const row = document.createElement('div');
  row.className = 'gdelay';

  const label = document.createElement('span');
  label.className = 'gd-label'; label.textContent = 'GROUP DELAY';

  const nudges = document.createElement('div');
  nudges.className = 'gd-nudges';

  const slideWrap = document.createElement('div');
  slideWrap.className = 'gd-slide';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.className = 'mini';
  slider.min = '0'; slider.max = String(max); slider.step = '10';
  slideWrap.appendChild(slider);

  const field = document.createElement('div');
  field.className = 'gd-field';
  const num = document.createElement('input');
  num.type = 'number'; num.className = 'gd-num';
  num.min = '0'; num.max = String(max); num.step = '10';
  const ms = document.createElement('span'); ms.className = 'ms'; ms.textContent = 'ms';
  field.append(num, ms);

  const sync = () => {
    const v = get();
    slider.value = String(v);
    slider.style.setProperty('--fill', `${max ? (v / max) * 100 : 0}%`);
    if (document.activeElement !== num) num.value = String(v);
    field.classList.toggle('nonzero', v > 0);
  };
  const apply = (v) => { set(v); sync(); };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('input', () => apply(Number(num.value)));

  const nudge = (text, step, wide) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nudge' + (wide ? ' wide' : ''); b.textContent = text;
    b.addEventListener('click', () => apply(get() + step));
    return b;
  };
  nudges.append(nudge('−100', -100, true), nudge('−10', -10), nudge('+10', 10), nudge('+100', 100, true));

  row.append(label, nudges, slideWrap, field);
  sync();
  return row;
}

/** Compact console network-row scaffold: checkbox + name/badge/subline. */
function netRow(activeId, enabledSet, name, badgeText, badgeKind, subText, onToggle) {
  const li = document.createElement('li');
  li.className = 'net-row' + (enabledSet.has(activeId) ? ' active' : '');
  const line = document.createElement('div'); line.className = 'net-line';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'cbx'; cb.checked = enabledSet.has(activeId);
  cb.addEventListener('change', () => onToggle(cb, li));
  const info = document.createElement('div'); info.className = 'net-info';
  const top = document.createElement('div'); top.className = 'net-top';
  const nm = document.createElement('span'); nm.className = 'net-name'; nm.textContent = name;
  top.appendChild(nm);
  if (badgeText) top.appendChild(rowBadge(badgeText, badgeKind));
  const sub = document.createElement('div'); sub.className = 'net-sub'; sub.textContent = subText;
  info.append(top, sub);
  line.append(cb, info);
  li.appendChild(line);
  return { li, line };
}

function renderSonosRow(room) {
  const { li, line } = netRow(room.id, sonosEnabled, room.roomName, room.model, 'model', `${room.ip} · ${room.model}`,
    (cb) => onToggleSonos(room, cb, li));
  const pushVol = throttle((v) => window.api.sonosSetVolume(room.ip, v), 80);
  const pushBass = throttle((v) => window.api.sonosSetBass(room.ip, v), 80);
  line.append(
    miniSlider({ label: 'V', min: 0, max: 100, value: room.volume ?? 25, onInput: (v) => { room.volume = v; pushVol(v); } }),
    miniSlider({ label: 'B', min: -10, max: 10, value: room.bass ?? 0, detent: true, onInput: (v) => { room.bass = v; pushBass(v); } }),
  );
  return li;
}

async function onToggleSonos(room, cb, li) {
  if (cb.checked) sonosEnabled.add(room.id);
  else sonosEnabled.delete(room.id);
  persistSonosSel(); // remember selected rooms across sessions
  li.classList.toggle('active', cb.checked);

  // Re-form the Sonos group if we're already broadcasting live.
  if (mode === 'live' && isPlaying) {
    await refreshSonosStream();
  } else if (cb.checked) {
    setStatus('Switch to 🎙 Live input and press Start to broadcast to Sonos.');
  }
}

el.btnFindSonos.addEventListener('click', findSonos);

// ---- AirPlay (network) discovery + streaming ----
// AirPlay receivers (Apple TV, AirPlay-2 TVs, HomePods) never show up in the OS
// audiooutput list until they're the system output, so we discover and stream to
// them ourselves — mirroring the Sonos path. Streaming reuses the same live
// capture format (16-bit/44.1 kHz/stereo), fed over its own IPC channel.
/** @type {Array<{id:string, name:string, host:string, port:number, txt:string[], airplay2:boolean, model:string, volume?:number}>} */
let airplayDevices = [];
/** @type {Set<string>} enabled device ids (restored from last session) */
const AIRPLAY_SEL_KEY = 'serializer.airplaySelected.v1';
const airplayEnabled = new Set(loadIdSet(AIRPLAY_SEL_KEY));
function persistAirplaySel() { try { localStorage.setItem(AIRPLAY_SEL_KEY, JSON.stringify([...airplayEnabled])); } catch {} }
// Per-receiver volume (AirPlay devices don't pass through our Web Audio gain, so
// volume lives on the device — remember it per id across sessions).
const AIRPLAY_VOL_KEY = 'serializer.airplayVol.v1';
const airplayVols = (() => { try { return JSON.parse(localStorage.getItem(AIRPLAY_VOL_KEY)) || {}; } catch { return {}; } })();
const persistAirplayVols = debounce(() => {
  try { localStorage.setItem(AIRPLAY_VOL_KEY, JSON.stringify(airplayVols)); } catch {}
}, 400);
/** @type {?{ctx: AudioContext, src: MediaStreamAudioSourceNode, delay: DelayNode, node: AudioNode, zero: GainNode}} */
let airplayCapture = null;
/** @type {?Promise<any>} guards concurrent (async) capture builds */
let airplayCaptureBuilding = null;
/** @type {Array<object>} devices currently told to play */
let airplayActive = [];

// Group-wide delay applied to the AirPlay feed (receivers can only be pushed
// later, like Sonos). Persisted across sessions.
const AIRPLAY_MAX_DELAY = 8000;
const AIRPLAY_DELAY_KEY = 'serializer.airplayDelay.v1';
let airplayDelayMs = (() => {
  const v = parseInt(localStorage.getItem(AIRPLAY_DELAY_KEY) || '0', 10);
  return isNaN(v) ? 0 : Math.max(0, Math.min(AIRPLAY_MAX_DELAY, v));
})();
const persistAirplayDelay = debounce(() => {
  try { localStorage.setItem(AIRPLAY_DELAY_KEY, String(airplayDelayMs)); } catch {}
}, 400);
function setAirplayDelay(ms) {
  airplayDelayMs = Math.max(0, Math.min(AIRPLAY_MAX_DELAY, Math.round(ms)));
  if (airplayCapture && airplayCapture.delay) {
    const t = airplayCapture.ctx.currentTime;
    airplayCapture.delay.delayTime.setTargetAtTime(airplayDelayMs / 1000, t, 0.03);
  }
  persistAirplayDelay();
}

function airplayKey(d) { return `${d.host}:${d.port}`; }
function airplayPayload(d) {
  return { id: d.id, name: d.name, host: d.host, port: d.port, txt: d.txt, airplay2: d.airplay2, volume: d.volume ?? 50 };
}
// Insertion order (NOT alphabetical) keeps selection stable.
function selectedAirPlay() {
  return [...airplayEnabled].map((id) => airplayDevices.find((d) => d.id === id)).filter(Boolean);
}

/**
 * Tap the live stream, convert to 16-bit stereo PCM at 44.1 kHz, and ship each
 * block to the main process for the AirPlay sender. Reuses the same audio-thread
 * worklet as the Sonos path; runs through a zero-gain node so it makes no sound.
 */
async function buildAirPlayCapture() {
  if (airplayCapture) return airplayCapture;
  if (airplayCaptureBuilding) return airplayCaptureBuilding;
  if (!liveStream) return null;
  airplayCaptureBuilding = (async () => {
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 44100 });
      const src = ctx.createMediaStreamSource(liveStream);
      const muteGain = ctx.createGain();           // gated on pause (silence, keeps the stream primed)
      muteGain.gain.value = networkCapturePaused ? 0 : 1;
      const delay = ctx.createDelay(AIRPLAY_MAX_DELAY / 1000);
      delay.delayTime.value = airplayDelayMs / 1000;
      const zero = ctx.createGain();
      zero.gain.value = 0;

      let node;
      try {
        await ctx.audioWorklet.addModule('sonos-capture-worklet.js');
        node = new AudioWorkletNode(ctx, 'sonos-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (e) => window.api.sendAirPlayPcm(e.data);
      } catch (err) {
        node = ctx.createScriptProcessor(4096, 2, 1);
        node.onaudioprocess = (e) => {
          const inp = e.inputBuffer;
          const L = inp.getChannelData(0);
          const R = inp.numberOfChannels > 1 ? inp.getChannelData(1) : L;
          const pcm = new Int16Array(L.length * 2);
          for (let i = 0; i < L.length; i++) {
            const l = Math.max(-1, Math.min(1, L[i]));
            const r = Math.max(-1, Math.min(1, R[i]));
            pcm[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
            pcm[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
          }
          window.api.sendAirPlayPcm(pcm.buffer);
        };
        console.warn('AirPlay capture worklet unavailable, using ScriptProcessor:', err.message);
      }

      src.connect(muteGain);
      muteGain.connect(delay);
      delay.connect(node);
      node.connect(zero);
      zero.connect(ctx.destination);
      await ctx.resume();
      airplayCapture = { ctx, src, muteGain, delay, node, zero };
      return airplayCapture;
    } catch (err) {
      if (ctx) ctx.close().catch(() => {});
      setStatus(`AirPlay audio capture failed: ${err.message}`);
      return null;
    } finally {
      airplayCaptureBuilding = null;
    }
  })();
  return airplayCaptureBuilding;
}

function teardownAirPlayCapture() {
  if (!airplayCapture) return;
  try {
    if (airplayCapture.node.port) airplayCapture.node.port.onmessage = null;
    if ('onaudioprocess' in airplayCapture.node) airplayCapture.node.onaudioprocess = null;
    airplayCapture.src.disconnect();
    airplayCapture.muteGain.disconnect();
    airplayCapture.delay.disconnect();
    airplayCapture.node.disconnect();
    airplayCapture.zero.disconnect();
  } catch {}
  airplayCapture.ctx.close().catch(() => {});
  airplayCapture = null;
  airplayCaptureBuilding = null;
}

/** Re-sync the AirPlay set to the current selection (capture keeps running). */
let airplayRefreshChain = Promise.resolve();
function refreshAirPlayStream() {
  // Serialize: rapid check/uncheck must not interleave and race `airplayActive`.
  return (airplayRefreshChain = airplayRefreshChain.then(runRefreshAirPlayStream, runRefreshAirPlayStream));
}
async function runRefreshAirPlayStream() {
  if (mode !== 'live' || !isPlaying || !liveStream) return;
  const devices = selectedAirPlay();
  if (!devices.length) { await stopAirPlayStream(); return; }
  await buildAirPlayCapture();
  const keep = new Set(devices.map(airplayKey));
  const removed = airplayActive.filter((d) => !keep.has(airplayKey(d))).map(airplayKey);
  if (removed.length) await window.api.airplayStop(removed);
  const res = await window.api.airplayPlay(devices.map(airplayPayload));
  airplayActive = devices;
  if (!res || !res.ok) setStatus(`AirPlay error: ${(res && res.error) || 'failed'}`);
  else setStatus(`Streaming to AirPlay: ${devices.map((d) => d.name).join(', ')}.`);
}

async function stopAirPlayStream() {
  teardownAirPlayCapture();
  if (airplayActive.length) await window.api.airplayStop(airplayActive.map(airplayKey));
  airplayActive = [];
}

async function findAirPlay() {
  if (!window.api || !window.api.discoverAirPlay) return;
  el.btnFindAirPlay.disabled = true;
  const doneDiscover = flashDiscovering(el.airplayDiscover);
  el.airplayHint.textContent = 'Searching your network for AirPlay devices…';
  try {
    airplayDevices = await window.api.discoverAirPlay();
  } catch (err) {
    airplayDevices = [];
    el.airplayHint.textContent = `AirPlay search failed: ${err.message}`;
    el.btnFindAirPlay.disabled = false;
    doneDiscover();
    return;
  }
  renderAirPlay();
  el.btnFindAirPlay.disabled = false;
  doneDiscover();
}

function renderAirPlay() {
  el.airplayList.innerHTML = '';
  if (!airplayDevices.length) {
    el.airplayHint.textContent = 'No AirPlay devices found. Make sure they’re powered on and on the same network, then press Find AirPlay.';
    el.airplayControls.hidden = true;
    return;
  }
  el.airplayHint.textContent = `${airplayDevices.length} AirPlay device${airplayDevices.length > 1 ? 's' : ''} found. Tick devices and use 🎙 Live input to broadcast to them.`;
  mountAirPlayControls();
  for (const dev of airplayDevices) el.airplayList.appendChild(renderAirPlayRow(dev));
}

/** One-time mount of the group-wide delay control above the device list. */
function mountAirPlayControls() {
  if (el.airplayControls.childElementCount) { el.airplayControls.hidden = false; return; }
  el.airplayControls.appendChild(groupDelayControl(() => airplayDelayMs, setAirplayDelay, AIRPLAY_MAX_DELAY));
  el.airplayControls.hidden = false;
}

function renderAirPlayRow(dev) {
  const { li, line } = netRow(dev.id, airplayEnabled, dev.name, dev.airplay2 ? 'AIRPLAY 2' : 'AIRPLAY', 'air',
    `${dev.host} · ${dev.model}`, (cb) => onToggleAirPlay(dev, cb, li));
  li.dataset.key = dev.id; // promptAirPlayPasscode finds the row by this
  dev.volume = airplayVols[dev.id] ?? dev.volume ?? 50; // restore saved level
  const pushVol = throttle((v) => window.api.airplaySetVolume(dev.id, v), 120);
  line.appendChild(miniSlider({
    label: 'VOL', min: 0, max: 100, value: dev.volume, fmtVal: (v) => `${v}%`,
    onInput: (v) => { dev.volume = v; airplayVols[dev.id] = v; persistAirplayVols(); pushVol(v); },
  }));
  return li;
}

async function onToggleAirPlay(dev, cb, li) {
  if (cb.checked) airplayEnabled.add(dev.id);
  else airplayEnabled.delete(dev.id);
  persistAirplaySel(); // remember selected receivers across sessions
  li.classList.toggle('active', cb.checked);

  if (mode === 'live' && isPlaying) {
    await refreshAirPlayStream();
  } else if (cb.checked) {
    setStatus('Switch to 🎙 Live input and press Start to broadcast to AirPlay.');
  }
}

// ---- AirPlay pairing (PIN) ----
// Some receivers (Apple TV, HomePod) show a code on screen the first time. The
// sender emits 'need_password'; we collect the code inline and send it back.
function promptAirPlayPasscode(key, name) {
  const li = el.airplayList.querySelector(`li[data-key="${CSS.escape(key)}"]`);
  if (!li || li.querySelector('.pin-pair')) return;
  li.classList.add('pairing');

  // "PAIRING" badge pinned to the far right of the row (VOL is hidden via CSS
  // while pairing, so the name column gets the room it needs).
  const line = li.querySelector('.net-line');
  if (line && !line.querySelector('.pin-status')) {
    const st = document.createElement('span'); st.className = 'pin-status'; st.textContent = 'PAIRING';
    line.appendChild(st);
  }

  const block = document.createElement('div');
  block.className = 'pin-pair';
  const prompt = document.createElement('span');
  prompt.className = 'pin-prompt';
  prompt.textContent = `Enter the 4-digit code shown on “${name}”.`;

  const cells = document.createElement('div'); cells.className = 'pin-cells';
  const inputs = [];
  const doPair = () => {
    const code = inputs.map((c) => c.value).join('');
    if (code.length === 4) { window.api.airplaySendPasscode(key, code); setStatus(`Pairing with “${name}”…`); }
    else (inputs.find((c) => !c.value) || inputs[0]).focus();
  };
  for (let i = 0; i < 4; i++) {
    const c = document.createElement('input');
    c.className = 'pin-cell'; c.type = 'text'; c.inputMode = 'numeric'; c.maxLength = 1;
    c.addEventListener('input', () => {
      c.value = c.value.replace(/\D/g, '').slice(0, 1);
      if (c.value && i < 3) inputs[i + 1].focus();
    });
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !c.value && i > 0) inputs[i - 1].focus();
      else if (e.key === 'Enter') doPair();
    });
    inputs.push(c); cells.appendChild(c);
  }

  const actions = document.createElement('div'); actions.className = 'pin-actions';
  const pair = document.createElement('button');
  pair.type = 'button'; pair.className = 'pin-pair-btn'; pair.textContent = 'Pair';
  pair.addEventListener('click', doPair);
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'pin-cancel-btn'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => clearAirPlayPasscode(key));
  actions.append(pair, cancel);

  block.append(prompt, cells, actions);
  li.appendChild(block);
  inputs[0].focus();
}

function clearAirPlayPasscode(key) {
  const li = el.airplayList.querySelector(`li[data-key="${CSS.escape(key)}"]`);
  if (!li) return;
  li.classList.remove('pairing');
  const block = li.querySelector('.pin-pair');
  if (block) block.remove();
  const st = li.querySelector('.pin-status');
  if (st) st.remove();
}

function handleAirPlayStatus({ key, status, desc }) {
  const dev = airplayDevices.find((d) => d.id === key);
  const name = dev ? dev.name : key;
  switch (status) {
    case 'need_password':
      promptAirPlayPasscode(key, name);
      setStatus(`AirPlay: enter the code shown on “${name}”.`);
      break;
    case 'pair_failed':
      setStatus(`AirPlay pairing failed for “${name}”. Re-tick it to try again.`);
      break;
    case 'pair_success':
    case 'ready':
      clearAirPlayPasscode(key);
      break;
    case 'playing':
      setStatus(`AirPlay: streaming to “${name}”.`);
      break;
    case 'error':
      setStatus(`AirPlay error on “${name}”: ${desc || 'unknown'}.`);
      break;
    default:
      break;
  }
}

el.btnFindAirPlay.addEventListener('click', findAirPlay);
if (window.api && window.api.onAirPlayStatus) window.api.onAirPlayStatus(handleAirPlayStatus);

// ---- Echo banner: mute local output / dismiss --------------------------------
function setLocalMuted(muted) {
  localMuted = muted;
  applyVolumes();
  if (el.btnMuteLocal) {
    el.btnMuteLocal.textContent = muted ? 'Unmute local output' : 'Mute local output';
    el.btnMuteLocal.classList.toggle('on', muted);
  }
}
if (el.btnMuteLocal) el.btnMuteLocal.addEventListener('click', () => setLocalMuted(!localMuted));
if (el.btnEchoDismiss) el.btnEchoDismiss.addEventListener('click', () => { el.sonosWarn.hidden = true; });

// ---- Fader fill: paint the amber portion of every range to its value --------
function paintRange(r) {
  const min = Number(r.min) || 0; const max = Number(r.max) || 100; const v = Number(r.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  if (r.classList.contains('detent')) {
    // bidirectional: teal grows from where 0 sits (the detent) toward the thumb
    const center = max > min ? ((0 - min) / (max - min)) * 100 : 50;
    r.style.setProperty('--a', `${Math.min(center, pct)}%`);
    r.style.setProperty('--b', `${Math.max(center, pct)}%`);
    r.style.setProperty('--thumb', Math.abs(pct - center) < 0.5 ? '#aeb4be' : 'var(--cyan-thumb)');
  } else {
    r.style.setProperty('--fill', `${pct}%`);
  }
}
function paintAllRanges() { document.querySelectorAll('input[type="range"]').forEach(paintRange); }
document.addEventListener('input', (e) => { if (e.target && e.target.type === 'range') paintRange(e.target); }, true);
// repaint after the device/sonos/airplay lists (re)render, which create new sliders
new MutationObserver(paintAllRanges).observe(el.deviceList, { childList: true });
new MutationObserver(paintAllRanges).observe(el.sonosList, { childList: true });
new MutationObserver(paintAllRanges).observe(el.airplayList, { childList: true });

// ---- Header chrome: mirror transport time + live wall-clock + active tally ----
if (el.timecode) {
  new MutationObserver(() => {
    el.timecode.textContent = el.timeCurrent.textContent || '0:00';
    if (el.timecodeTotal) el.timecodeTotal.textContent = `/ ${el.timeTotal.textContent || '0:00'}`;
  }).observe(el.timeCurrent, { childList: true, characterData: true, subtree: true });
}
function updateHeaderChrome() {
  if (el.wallclock) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    el.wallclock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  if (el.tally) {
    const n = enabledChannels().length + selectedSonosRooms().length + selectedAirPlay().length;
    el.tally.textContent = `${n} ACTIVE`;
    el.tally.parentElement?.classList.toggle('on', isPlaying && n > 0);
  }
  const live = playMode === 'live';
  if (el.transportStatus) el.transportStatus.textContent = !isPlaying ? 'STANDBY' : (live ? 'LIVE' : 'PLAYING');
  if (el.statusPill) {
    el.statusPill.classList.toggle('standby', !isPlaying);
    el.statusPill.classList.toggle('live', isPlaying && live);
  }
  if (el.statusSys) {
    const n = enabledChannels().length + selectedSonosRooms().length + selectedAirPlay().length;
    el.statusSys.textContent = `${n} active · 48 kHz · CoreAudio`;
  }
}
updateHeaderChrome();
setInterval(updateHeaderChrome, 1000);

scanDevices();
findSonos();
findAirPlay();
paintAllRanges();

// ---- Dashboard: draggable / resizable, add-or-remove panels ----------------
(() => {
  const PANELS = [
    { id: 'transport', name: 'Master · Transport', tag: '', w: 4, h: 15 },
    { id: 'devices', name: 'Output Bus', tag: '', w: 8, h: 15 },
    { id: 'sonos', name: 'Sonos', tag: 'network', w: 4, h: 9 },
    { id: 'airplay', name: 'AirPlay', tag: 'network', w: 4, h: 9 },
  ];
  // Narrow transport column + wide output bus, tall enough for the full transport
  // stack (incl. the bottom-pinned VU). Mirrors the design's 3-column proportions.
  const DEFAULT_LAYOUT = [
    { i: 'transport', x: 0, y: 0, w: 4, h: 15 },
    { i: 'devices', x: 4, y: 0, w: 8, h: 15 },
  ];
  const LAYOUT_KEY = 'serializer.layout.v2';
  const ROW = 26;     // px per grid row
  const MARGIN = 12;  // px gap between cells

  const gridEl = document.getElementById('grid');
  const widgets = {};
  for (const p of PANELS) widgets[p.id] = document.getElementById('w-' + p.id);
  const sizeOf = Object.fromEntries(PANELS.map((p) => [p.id, { w: p.w, h: p.h }]));

  let layout = loadLayout();

  function loadLayout() {
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY));
      if (Array.isArray(saved) && saved.length) {
        const clean = saved.filter((it) => widgets[it.i]).map((it) => {
          // Clamp to the grid so a stale/edited layout can't place a panel off-screen.
          const w = Math.max(1, Math.min(it.w | 0, COLS));
          const x = Math.max(0, Math.min(it.x | 0, COLS - w));
          return { i: it.i, x, y: Math.max(0, it.y | 0), w, h: Math.max(1, it.h | 0) };
        });
        if (clean.length) return clean;
      }
    } catch {}
    return DEFAULT_LAYOUT.map((it) => ({ ...it }));
  }
  function saveLayout() { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {} }
  const getItem = (id) => layout.find((it) => it.i === id);

  function colWidth() { return (gridEl.clientWidth - MARGIN * (COLS + 1)) / COLS; }
  function cellToPx(item, cw = colWidth()) {
    return {
      left: Math.round(MARGIN + item.x * (cw + MARGIN)),
      top: Math.round(MARGIN + item.y * (ROW + MARGIN)),
      width: Math.round(item.w * cw + (item.w - 1) * MARGIN),
      height: Math.round(item.h * ROW + (item.h - 1) * MARGIN),
    };
  }

  const placeholder = document.createElement('div');
  placeholder.className = 'grid-placeholder';
  gridEl.appendChild(placeholder);

  function paintPlaceholder(id) {
    const b = cellToPx(getItem(id));
    placeholder.style.transform = `translate(${b.left}px, ${b.top}px)`;
    placeholder.style.width = b.width + 'px';
    placeholder.style.height = b.height + 'px';
  }

  function renderLayout(skipId) {
    const shown = new Set(layout.map((it) => it.i));
    for (const p of PANELS) if (!shown.has(p.id)) widgets[p.id].hidden = true;
    const cw = colWidth();
    for (const item of layout) {
      const el = widgets[item.i];
      el.hidden = false;
      if (item.i === skipId) continue;
      const b = cellToPx(item, cw);
      el.style.transform = `translate(${b.left}px, ${b.top}px)`;
      el.style.width = b.width + 'px';
      el.style.height = b.height + 'px';
    }
    gridEl.style.height = (MARGIN + bottom(layout) * (ROW + MARGIN) + MARGIN) + 'px';
  }

  function startDrag(e, id) {
    const el = widgets[id];
    const cw = colWidth();
    const start = cellToPx(getItem(id), cw);
    const sx = e.clientX; const sy = e.clientY;
    el.classList.add('dragging');
    gridEl.classList.add('is-dragging');
    paintPlaceholder(id);
    const maxLeft = Math.max(MARGIN, gridEl.clientWidth - start.width - MARGIN);
    const onMove = (ev) => {
      const left = Math.max(MARGIN, Math.min(maxLeft, start.left + (ev.clientX - sx)));
      const top = Math.max(MARGIN, start.top + (ev.clientY - sy));
      el.style.transform = `translate(${left}px, ${top}px)`;
      const gx = Math.round((left - MARGIN) / (cw + MARGIN));
      const gy = Math.round((top - MARGIN) / (ROW + MARGIN));
      layout = moveElement(layout, id, gx, gy);
      renderLayout(id);
      paintPlaceholder(id);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.classList.remove('dragging');
      gridEl.classList.remove('is-dragging');
      renderLayout();
      saveLayout();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function startResize(e, id) {
    const el = widgets[id];
    const cw = colWidth();
    const start = cellToPx(getItem(id), cw);
    const sx = e.clientX; const sy = e.clientY;
    el.classList.add('resizing');
    gridEl.classList.add('is-dragging');
    paintPlaceholder(id);
    const onMove = (ev) => {
      const wpx = Math.max(120, start.width + (ev.clientX - sx));
      const hpx = Math.max(110, start.height + (ev.clientY - sy));
      el.style.width = wpx + 'px';
      el.style.height = hpx + 'px';
      const w = Math.round((wpx + MARGIN) / (cw + MARGIN));
      const h = Math.round((hpx + MARGIN) / (ROW + MARGIN));
      layout = resizeElement(layout, id, w, h);
      renderLayout(id);
      paintPlaceholder(id);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.classList.remove('resizing');
      gridEl.classList.remove('is-dragging');
      renderLayout();
      saveLayout();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function showPanel(id) {
    if (getItem(id)) return;
    layout = addElement(layout, { i: id, x: 0, w: sizeOf[id].w, h: sizeOf[id].h });
    renderLayout(); saveLayout(); renderModalList();
    widgets[id].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hidePanel(id) {
    layout = removeElement(layout, id);
    widgets[id].hidden = true;
    renderLayout(); saveLayout(); renderModalList();
  }

  // wire each widget's drag handle, resize grip and close button
  for (const p of PANELS) {
    const el = widgets[p.id];
    el.querySelector('.w-bar').addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, a, .info-icon, .w-close')) return;
      e.preventDefault();
      startDrag(e, p.id);
    });
    el.querySelector('.w-resize').addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startResize(e, p.id);
    });
    el.querySelector('.w-close').addEventListener('click', () => hidePanel(p.id));
  }

  // ---- add-panel modal ----
  const modal = document.getElementById('panelModal');
  const modalList = document.getElementById('panelModalList');
  function renderModalList() {
    const shown = new Set(layout.map((it) => it.i));
    modalList.innerHTML = '';
    for (const p of PANELS) {
      const li = document.createElement('li');
      li.className = 'modal-row';
      const name = document.createElement('span');
      name.className = 'mr-name';
      name.textContent = p.name;
      li.appendChild(name);
      if (p.tag) {
        const tag = document.createElement('span');
        tag.className = 'mr-tag';
        tag.textContent = p.tag;
        li.appendChild(tag);
      }
      const on = shown.has(p.id);
      const btn = document.createElement('button');
      btn.className = 'key key-ghost mr-toggle' + (on ? ' on' : '');
      btn.textContent = on ? 'Hide' : 'Add';
      btn.addEventListener('click', () => (on ? hidePanel(p.id) : showPanel(p.id)));
      li.appendChild(btn);
      modalList.appendChild(li);
    }
  }
  const closeModal = () => { modal.hidden = true; };
  document.getElementById('btnAddPanel').addEventListener('click', () => { renderModalList(); modal.hidden = false; });
  document.getElementById('panelModalClose').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.getElementById('btnResetLayout').addEventListener('click', () => {
    layout = DEFAULT_LAYOUT.map((it) => ({ ...it }));
    renderLayout(); saveLayout(); renderModalList(); closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; renderLayout(); });
  });

  renderLayout();
  renderModalList();
})();
