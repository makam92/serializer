'use strict';

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
  trackSub: document.getElementById('trackSub'),
  timeCurrent: document.getElementById('timeCurrent'),
  timeTotal: document.getElementById('timeTotal'),
  seek: document.getElementById('seek'),
  btnPick: document.getElementById('btnPick'),
  btnPlay: document.getElementById('btnPlay'),
  btnStop: document.getElementById('btnStop'),
  masterVol: document.getElementById('masterVol'),
  btnRescan: document.getElementById('btnRescan'),
  devicesHint: document.getElementById('devicesHint'),
  deviceList: document.getElementById('deviceList'),
  status: document.getElementById('status'),
  btnModeFile: document.getElementById('btnModeFile'),
  btnModeLive: document.getElementById('btnModeLive'),
  inputSelect: document.getElementById('inputSelect'),
  liveHint: document.getElementById('liveHint'),
  inputMeter: document.getElementById('inputMeter'),
  meterFill: document.getElementById('meterFill'),
  meterDb: document.getElementById('meterDb'),
  btnFindSonos: document.getElementById('btnFindSonos'),
  sonosHint: document.getElementById('sonosHint'),
  sonosControls: document.getElementById('sonosControls'),
  sonosList: document.getElementById('sonosList'),
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

let mode = 'file'; // 'file' | 'live'
let currentObjectUrl = null;
let trackName = '';
let masterVolume = 1;
let isPlaying = false;
let durationSec = 0;
let seeking = false;

// live state
let inputDeviceId = '';
let liveStream = null;

// input meter state
let meterCtx = null;
let meterAnalyser = null;
let meterData = null;
let meterRaf = 0;
let meterPeakHold = 0; // smoothed peak, 0..1

const DRIFT_THRESHOLD = 0.08; // seconds
const MAX_DELAY = 3.0;        // DelayNode max (seconds) — big enough for AirPlay/Sonos buffering
const DELAY_COMP_RANGE = 3000; // delay-comp slider span (± ms)
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
    if (ch.offsetMs !== 0 || ch.volume !== 1 || ch.bass !== 0) {
      out[id] = { offsetMs: ch.offsetMs, volume: ch.volume, bass: ch.bass };
    }
  }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(out)); } catch {}
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
    if (!seen.has(id) && !ch.enabled) channels.delete(id);
  }

  renderDevices();
  populateInputs(inputs);

  el.devicesHint.textContent = outputs.length
    ? `${outputs.length} output${outputs.length > 1 ? 's' : ''} found. Tick the speakers you want, then press ${mode === 'live' ? 'Start' : 'Play'}.`
    : 'No audio outputs found. Connect a speaker and press Rescan.';
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
    const onMeta = () => {
      durationSec = Math.max(durationSec, a.duration || 0);
      el.timeTotal.textContent = fmtTime(durationSec);
      el.trackSub.textContent = 'Ready';
      a.removeEventListener('loadedmetadata', onMeta);
      applySink(ch).finally(resolve);
    };
    a.addEventListener('loadedmetadata', onMeta);
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
async function startLive() {
  const active = enabledChannels();
  if (!active.length && !selectedSonosRooms().length) {
    setStatus('Select at least one speaker or Sonos room first.');
    return;
  }

  try {
    const audioConstraints = inputDeviceId
      ? { deviceId: { exact: inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch (err) {
    setStatus(`Could not open input: ${err.message}`);
    return;
  }

  for (const ch of active) await buildLiveNode(ch);
  startMeter();

  isPlaying = true;
  el.btnPlay.textContent = '⏸ Pause';
  const inputName = el.inputSelect.options[el.inputSelect.selectedIndex]?.textContent || 'input';
  setStatus(`Live: routing "${inputName}" to ${active.length} speaker${active.length > 1 ? 's' : ''}.`);
  if (selectedSonosRooms().length) refreshSonosStream();
}

/** @param {Channel} ch */
async function buildLiveNode(ch) {
  if (!liveStream || ch.live) return;
  const ctx = new AudioContext({ latencyHint: 'playback' });
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
  gain.gain.value = Math.min(1, ch.volume * masterVolume);
  src.connect(filter);
  filter.connect(delay);
  delay.connect(gain);
  gain.connect(ctx.destination);
  await ctx.resume();
  ch.live = { ctx, src, filter, delay, gain };
}

/** @param {Channel} ch */
function teardownLiveNode(ch) {
  if (!ch.live) return;
  try { ch.live.src.disconnect(); ch.live.filter.disconnect(); ch.live.gain.disconnect(); ch.live.delay.disconnect(); } catch {}
  ch.live.ctx.close().catch(() => {});
  ch.live = null;
}

function stopLive() {
  stopMeter();
  stopSonosStream();
  for (const ch of channels.values()) teardownLiveNode(ch);
  if (liveStream) { liveStream.getTracks().forEach((t) => t.stop()); liveStream = null; }
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
  el.meterFill.style.transform = `scaleX(${frac})`;
  el.meterFill.classList.toggle('clip', meterPeakHold >= 0.99);
  el.meterDb.textContent = isFinite(db) ? `${db.toFixed(0)} dB` : '–∞ dB';

  meterRaf = requestAnimationFrame(meterTick);
}

function stopMeter() {
  if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = 0; }
  if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
  meterAnalyser = null;
  meterData = null;
  el.inputMeter.hidden = true;
  el.meterFill.style.transform = 'scaleX(0)';
  el.meterFill.classList.remove('clip');
  el.meterDb.textContent = '–∞ dB';
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
    const target = base - ch.offsetMs / 1000; // +offset = play earlier content = come out later
    if (Math.abs(ch.audio.currentTime - target) > 0.02) ch.audio.currentTime = Math.max(0, target);
  }
  await Promise.allSettled(active.map((ch) => ch.audio.play()));

  isPlaying = true;
  el.btnPlay.textContent = '⏸ Pause';
  setStatus(`Playing on ${active.length} speaker${active.length > 1 ? 's' : ''}.`);
}

function pause() {
  if (mode === 'live') { stopLive(); isPlaying = false; el.btnPlay.textContent = '▶ Start'; setStatus('Live stopped.'); return; }
  for (const ch of channels.values()) ch.audio.pause();
  isPlaying = false;
  el.btnPlay.textContent = '▶ Play';
  setStatus('Paused.');
}

function stop() {
  if (mode === 'live') { stopLive(); isPlaying = false; el.btnPlay.textContent = '▶ Start'; setStatus('Live stopped.'); return; }
  for (const ch of channels.values()) { ch.audio.pause(); ch.audio.currentTime = 0; }
  isPlaying = false;
  el.btnPlay.textContent = '▶ Play';
  el.seek.value = '0';
  el.timeCurrent.textContent = '0:00';
  setStatus('Stopped.');
}

function togglePlay() { if (isPlaying) pause(); else play(); }

function seekTo(fraction) {
  const t = fraction * durationSec;
  for (const ch of channels.values()) ch.audio.currentTime = Math.max(0, t - ch.offsetMs / 1000);
  el.timeCurrent.textContent = fmtTime(t);
}

// ---- Sync loop (file mode only) ----
function syncTick() {
  if (mode !== 'file') return;
  const ref = referenceChannel();
  if (!ref) return;
  const base = ref.audio.currentTime;
  for (const ch of enabledChannels()) {
    if (ch === ref) continue;
    const target = base - ch.offsetMs / 1000;
    if (Math.abs(ch.audio.currentTime - target) > DRIFT_THRESHOLD) ch.audio.currentTime = Math.max(0, target);
  }
  if (!seeking && durationSec > 0) {
    el.seek.value = String(Math.round((base / durationSec) * 1000));
    el.timeCurrent.textContent = fmtTime(base);
  }
}
setInterval(syncTick, 250);

// ---- Volume / bass application ----
function effectiveVol(ch) { return Math.min(1, ch.volume * masterVolume); }

/** Route a channel's level to whichever node owns its output (graph gain or element). */
function applyChannelVolume(ch) {
  const v = effectiveVol(ch);
  if (ch.fileGraph) { ch.fileGraph.gain.gain.value = v; ch.audio.volume = 1; }
  else ch.audio.volume = v;
  if (ch.live) ch.live.gain.gain.value = v;
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
  // Stop whatever is currently running before switching.
  if (isPlaying) stop();
  else stopLive();
  mode = next;

  const live = mode === 'live';
  el.btnModeFile.classList.toggle('active', !live);
  el.btnModeLive.classList.toggle('active', live);
  el.inputSelect.hidden = !live;
  el.liveHint.hidden = !live;
  el.btnPick.hidden = live;
  el.seek.disabled = live;

  if (live) {
    el.trackTitle.textContent = 'Live input';
    el.trackSub.textContent = 'Capture an input device and broadcast it live';
    el.timeCurrent.textContent = '–:––';
    el.timeTotal.textContent = '–:––';
    el.seek.value = '0';
    el.btnPlay.textContent = '▶ Start';
    el.btnPlay.disabled = false;
    el.btnStop.disabled = false;
  } else {
    el.trackTitle.textContent = trackName || 'No track loaded';
    el.trackSub.textContent = trackName ? 'Ready' : 'Choose an audio file to begin';
    el.timeTotal.textContent = fmtTime(durationSec);
    el.btnPlay.textContent = '▶ Play';
    el.btnPlay.disabled = !currentObjectUrl;
    el.btnStop.disabled = !currentObjectUrl;
  }
}

// ---- Rendering the device list ----
function renderDevices() {
  el.deviceList.innerHTML = '';
  for (const ch of channels.values()) el.deviceList.appendChild(renderDeviceRow(ch));
}

/** @param {Channel} ch */
function renderDeviceRow(ch) {
  const li = document.createElement('li');
  li.className = 'device' + (ch.enabled ? ' active' : '');

  const enableWrap = document.createElement('div');
  enableWrap.className = 'dev-enable';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = ch.enabled;
  cb.addEventListener('change', () => onToggleDevice(ch, cb, li));
  enableWrap.appendChild(cb);

  const main = document.createElement('div');
  main.className = 'dev-main';

  const name = document.createElement('div');
  name.className = 'dev-name';
  name.textContent = ch.info.label;
  if (ch.info.isDefault) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'default';
    name.appendChild(badge);
  }
  main.appendChild(name);

  const sliders = document.createElement('div');
  sliders.className = 'dev-sliders';
  sliders.appendChild(sliderGroup('Volume', 0, 100, Math.round(ch.volume * 100), '%', (v) => {
    ch.volume = v / 100;
    applyChannelVolume(ch);
    schedulePersist();
  }));
  sliders.appendChild(sliderGroup('Bass', 0, BASS_MAX_DB, ch.bass, ' dB', (v) => { setBass(ch, v); }));
  sliders.appendChild(delayControl(ch));
  main.appendChild(sliders);

  li.appendChild(enableWrap);
  li.appendChild(main);
  return li;
}

async function onToggleDevice(ch, cb, li) {
  ch.enabled = cb.checked;
  li.classList.toggle('active', ch.enabled);

  if (mode === 'live') {
    if (ch.enabled && isPlaying && liveStream) await buildLiveNode(ch);
    else if (!ch.enabled) teardownLiveNode(ch);
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
  g.className = 'slider-group delay-group';

  const l = document.createElement('label');
  l.textContent = 'Delay comp';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(-DELAY_COMP_RANGE);
  slider.max = String(DELAY_COMP_RANGE);
  slider.step = '10';
  slider.value = String(ch.offsetMs);

  const num = document.createElement('input');
  num.type = 'number';
  num.className = 'delay-num';
  num.min = String(-DELAY_COMP_RANGE);
  num.max = String(DELAY_COMP_RANGE);
  num.step = '10';
  num.value = String(ch.offsetMs);

  const unit = document.createElement('span');
  unit.className = 'val';
  unit.textContent = 'ms';

  const apply = (v) => {
    v = Math.max(-DELAY_COMP_RANGE, Math.min(DELAY_COMP_RANGE, Math.round(v)));
    ch.offsetMs = v;
    slider.value = String(v);
    num.value = String(v);
    if (ch.live) ch.live.delay.delayTime.value = clampDelay(v);
    schedulePersist();
  };

  const nudge = (label, step) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nudge';
    b.textContent = label;
    b.title = `${step > 0 ? '+' : ''}${step} ms`;
    b.addEventListener('click', () => apply(ch.offsetMs + step));
    return b;
  };

  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('input', () => apply(Number(num.value)));

  g.appendChild(l);
  g.appendChild(nudge('−100', -100));
  g.appendChild(nudge('−10', -10));
  g.appendChild(num);
  g.appendChild(unit);
  g.appendChild(nudge('+10', 10));
  g.appendChild(nudge('+100', 100));
  g.appendChild(slider);
  return g;
}

// ---- Wire up UI ----
el.btnPick.addEventListener('click', loadFile);
el.btnPlay.addEventListener('click', togglePlay);
el.btnStop.addEventListener('click', stop);
el.btnRescan.addEventListener('click', scanDevices);
el.btnModeFile.addEventListener('click', () => setMode('file'));
el.btnModeLive.addEventListener('click', () => setMode('live'));
el.inputSelect.addEventListener('change', () => {
  inputDeviceId = el.inputSelect.value;
  if (mode === 'live' && isPlaying) { stopLive(); isPlaying = false; el.btnPlay.textContent = '▶ Start'; setStatus('Input changed — press Start.'); }
});

el.masterVol.addEventListener('input', () => { masterVolume = Number(el.masterVol.value) / 100; applyVolumes(); });

el.seek.addEventListener('mousedown', () => { seeking = true; });
el.seek.addEventListener('input', () => { el.timeCurrent.textContent = fmtTime((Number(el.seek.value) / 1000) * durationSec); });
el.seek.addEventListener('change', () => { seekTo(Number(el.seek.value) / 1000); seeking = false; });

navigator.mediaDevices.addEventListener('devicechange', scanDevices);

// ---- Sonos (network) discovery + streaming ----
/** @type {Array<{id:string, ip:string, roomName:string, model:string}>} */
let sonosRooms = [];
/** @type {Set<string>} enabled room ids */
const sonosEnabled = new Set();
/** @type {?{ctx: AudioContext, src: MediaStreamAudioSourceNode, delay: DelayNode, node: AudioNode, zero: GainNode}} */
let sonosCapture = null;
/** @type {?Promise<any>} guards against concurrent (async) capture builds */
let sonosCaptureBuilding = null;

// Group-wide delay applied to the audio we stream to Sonos (Sonos can only be
// pushed later, so 0..SONOS_MAX_DELAY ms). Persisted across sessions.
const SONOS_MAX_DELAY = 3000;
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
    const ctx = new AudioContext({ sampleRate: 44100 });
    const src = ctx.createMediaStreamSource(liveStream);
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

    src.connect(delay);
    delay.connect(node);
    node.connect(zero);
    zero.connect(ctx.destination);
    await ctx.resume();
    sonosCapture = { ctx, src, delay, node, zero };
    sonosCaptureBuilding = null;
    return sonosCapture;
  })();
  return sonosCaptureBuilding;
}

function teardownSonosCapture() {
  if (!sonosCapture) return;
  try {
    if (sonosCapture.node.port) sonosCapture.node.port.onmessage = null;
    if ('onaudioprocess' in sonosCapture.node) sonosCapture.node.onaudioprocess = null;
    sonosCapture.src.disconnect();
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
async function refreshSonosStream() {
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
  else setStatus(`Streaming to Sonos: ${rooms.map((r) => r.roomName).join(', ')}.`);
}

async function stopSonosStream() {
  teardownSonosCapture();
  if (sonosActive.length) await window.api.sonosStop(sonosActive.map(roomPayload));
  sonosActive = [];
}

async function findSonos() {
  if (!window.api || !window.api.discoverSonos) return;
  el.btnFindSonos.disabled = true;
  el.sonosHint.textContent = 'Searching your network for Sonos rooms…';
  try {
    sonosRooms = await window.api.discoverSonos();
  } catch (err) {
    sonosRooms = [];
    el.sonosHint.textContent = `Sonos search failed: ${err.message}`;
    el.btnFindSonos.disabled = false;
    return;
  }
  renderSonos();
  el.btnFindSonos.disabled = false;
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

/** One-time mount of the group-wide delay control above the room list. */
function mountSonosControls() {
  if (el.sonosControls.childElementCount) { el.sonosControls.hidden = false; return; }
  const label = document.createElement('span');
  label.className = 'sonos-controls-label';
  label.textContent = 'Group delay';
  el.sonosControls.appendChild(label);
  el.sonosControls.appendChild(sonosDelayControl());
  el.sonosControls.hidden = false;
}

/** Delay + nudge for the whole Sonos group (0..SONOS_MAX_DELAY ms, add-only). */
function sonosDelayControl() {
  const g = document.createElement('div');
  g.className = 'slider-group delay-group';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0'; slider.max = String(SONOS_MAX_DELAY); slider.step = '10';
  slider.value = String(sonosDelayMs);

  const num = document.createElement('input');
  num.type = 'number';
  num.className = 'delay-num';
  num.min = '0'; num.max = String(SONOS_MAX_DELAY); num.step = '10';
  num.value = String(sonosDelayMs);

  const unit = document.createElement('span');
  unit.className = 'val';
  unit.textContent = 'ms';

  const apply = (v) => {
    setSonosDelay(v);
    slider.value = String(sonosDelayMs);
    num.value = String(sonosDelayMs);
  };
  const nudge = (text, step) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nudge'; b.textContent = text;
    b.addEventListener('click', () => apply(sonosDelayMs + step));
    return b;
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('input', () => apply(Number(num.value)));

  g.appendChild(nudge('−100', -100));
  g.appendChild(nudge('−10', -10));
  g.appendChild(num);
  g.appendChild(unit);
  g.appendChild(nudge('+10', 10));
  g.appendChild(nudge('+100', 100));
  g.appendChild(slider);
  return g;
}

function renderSonosRow(room) {
  const li = document.createElement('li');
  li.className = 'device sonos-device' + (sonosEnabled.has(room.id) ? ' active' : '');

  const enableWrap = document.createElement('div');
  enableWrap.className = 'dev-enable';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = sonosEnabled.has(room.id);
  cb.addEventListener('change', () => onToggleSonos(room, cb, li));
  enableWrap.appendChild(cb);

  const main = document.createElement('div');
  main.className = 'dev-main';
  const name = document.createElement('div');
  name.className = 'dev-name';
  name.textContent = room.roomName;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = room.model;
  name.appendChild(badge);
  main.appendChild(name);

  const sub = document.createElement('div');
  sub.className = 'dev-sub';
  sub.textContent = `${room.ip} · ${room.model}`;
  main.appendChild(sub);

  // Native Sonos volume + bass, applied over the network (per room).
  const sliders = document.createElement('div');
  sliders.className = 'dev-sliders';
  const pushVol = throttle((v) => window.api.sonosSetVolume(room.ip, v), 80);
  sliders.appendChild(sliderGroup('Volume', 0, 100, room.volume, '%', (v) => { room.volume = v; pushVol(v); }));
  const pushBass = throttle((v) => window.api.sonosSetBass(room.ip, v), 80);
  sliders.appendChild(sliderGroup('Bass', -10, 10, room.bass, '', (v) => { room.bass = v; pushBass(v); }));
  main.appendChild(sliders);

  li.appendChild(enableWrap);
  li.appendChild(main);
  return li;
}

async function onToggleSonos(room, cb, li) {
  if (cb.checked) sonosEnabled.add(room.id);
  else sonosEnabled.delete(room.id);
  li.classList.toggle('active', cb.checked);

  // Re-form the Sonos group if we're already broadcasting live.
  if (mode === 'live' && isPlaying) {
    await refreshSonosStream();
  } else if (cb.checked) {
    setStatus('Switch to 🎙 Live input and press Start to broadcast to Sonos.');
  }
}

el.btnFindSonos.addEventListener('click', findSonos);

scanDevices();
findSonos();
