'use strict';

import { SCENES, pickNextScene, FIRST_SCENE } from './journey-scenes.js';
import { RIDE_ACTS } from './ride-acts.js';

/**
 * Audio-reactive visualizer: flow-field drifting particles + pulsing sound rings
 * with additive glow ("bloom"). Pure Canvas 2D — no dependencies.
 *
 * It analyses the live audio and adapts:
 *  - BPM is estimated from bass onsets (median inter-beat interval, octave-folded).
 *  - Bass dominance, spectral brightness (centroid) and energy pick a "mood"
 *    (Ambient / Chill / Pop / Electronic / Hip-Hop / Rock), each with its own
 *    palette and motion, chosen with hysteresis so it doesn't flicker.
 *  - Beats spawn rings; tempo/energy drive particle speed and field evolution.
 */

// ---- Compact 2D simplex noise (public domain, after Stefan Gustavson) ----
function makeNoise2D(seed) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed >>> 0) || 1;
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = perm[i] % 12; }
  const grad = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0, 1], [0, -1]];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  return function (xin, yin) {
    let n0 = 0; let n1 = 0; let n2 = 0;
    const sk = (xin + yin) * F2;
    const i = Math.floor(xin + sk); const j = Math.floor(yin + sk);
    const t = (i + j) * G2;
    const x0 = xin - (i - t); const y0 = yin - (j - t);
    let i1; let j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2; const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2; const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255; const jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { const g = grad[permMod12[ii + perm[jj]]]; t0 *= t0; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { const g = grad[permMod12[ii + i1 + perm[jj + j1]]]; t1 *= t1; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { const g = grad[permMod12[ii + 1 + perm[jj + 1]]]; t2 *= t2; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * (n0 + n1 + n2);
  };
}

/** Pre-rendered soft radial glow so we don't build a gradient per particle. */
function makeGlowSprite(r, g, b, size = 48) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.85)`);
  grad.addColorStop(0.25, `rgba(${r},${g},${b},0.32)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// Feel-based moods (audio features can't reliably name genres, so we map to a
// "feel"). Each = palette (3 particle colors), ring hue, background, motion.
const MOODS = [
  { name: 'Calm',   bg: [7, 9, 18],   colors: [[90, 140, 230], [120, 90, 210], [70, 170, 210]], ringHue: 220, speed: 0.55, force: 0.7, ringScale: 1.2, density: 0.85, fieldEvo: 0.6 },
  { name: 'Warm',   bg: [16, 11, 8],  colors: [[235, 180, 100], [230, 140, 90], [210, 170, 120]], ringHue: 35, speed: 0.8, force: 0.95, ringScale: 1.15, density: 0.95, fieldEvo: 0.8 },
  { name: 'Epic',   bg: [16, 8, 9],   colors: [[235, 110, 80], [235, 180, 90], [210, 90, 120]], ringHue: 18, speed: 1.0, force: 1.25, ringScale: 1.5, density: 1.05, fieldEvo: 0.9 },
  { name: 'Bright', bg: [8, 14, 14],  colors: [[120, 235, 160], [150, 220, 235], [200, 235, 140]], ringHue: 150, speed: 1.1, force: 1.05, ringScale: 1.0, density: 1.05, fieldEvo: 1.0 },
  { name: 'Groove', bg: [12, 8, 16],  colors: [[200, 110, 235], [150, 120, 250], [230, 120, 200]], ringHue: 285, speed: 1.0, force: 1.35, ringScale: 1.4, density: 1.0, fieldEvo: 0.9 },
  { name: 'Drive',  bg: [8, 8, 18],   colors: [[80, 230, 230], [210, 90, 235], [120, 130, 255]], ringHue: 292, speed: 1.6, force: 1.5, ringScale: 1.3, density: 1.2, fieldEvo: 1.6 },
];

// ---- "Journey" mode: a camera flying forward through a particle world ----
const J = { ZNEAR: 0.5, ZFAR: 26, ZFOG0: 9 };
// ---- "Ride" mode: a longer track with a deeper draw distance ----
const RIDE = { ZN: 0.6, ZF: 30, ZFOG: 12 };

// Critically-damped smoothing — eases a value toward a target with no overshoot.
// Returns [newX, newV]. tau = approx time (s) to cover ~63% of the distance.
function smoothDamp(x, v, g, tau, dt) {
  const omega = 1 / Math.max(0.0001, tau);
  const a = omega * dt;
  const exp = 1 / (1 + a + 0.48 * a * a + 0.235 * a * a * a);
  const dx = x - g;
  const temp = (v + omega * dx) * dt;
  const nv = (v - omega * temp) * exp;
  return [g + (dx + temp) * exp, nv];
}
function easeInOutCubic(x) { return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2; }

// Each flight state targets a parameter set; we blend between them on transitions.
const STATES = {
  DRIFT:  { speedMul: 0.5, trailFade: 0.22, turnGain: 1.0, focalMul: 1.0, ringMode: 0.0, density: 0.7 },
  BUILD:  { speedMul: 0.9, trailFade: 0.16, turnGain: 0.7, focalMul: 1.05, ringMode: 0.2, density: 0.9 },
  DROP:   { speedMul: 1.5, trailFade: 0.10, turnGain: 0.4, focalMul: 1.08, ringMode: 0.3, density: 1.0 },
  TUNNEL: { speedMul: 1.3, trailFade: 0.11, turnGain: 1.2, focalMul: 1.0, ringMode: 1.0, density: 1.0 },
  CALM:   { speedMul: 0.35, trailFade: 0.26, turnGain: 1.0, focalMul: 1.0, ringMode: 0.0, density: 0.6 },
};

export class Visualizer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.background = !!opts.background; // subtle always-on backdrop variant
    this.journey = !!opts.journey;      // cinematic forward-flight overlay
    this.ride = !!opts.ride;            // continuous generative rollercoaster
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.noise = makeNoise2D(1337);
    this.particles = [];
    this.rings = [];
    this.analyser = null;
    this.freq = null;
    this.prevFreq = null;
    this.raf = 0;
    this.t = 0;
    this.W = 1; this.H = 1;
    this.baseCount = 1500;

    this.smooth = { bass: 0, mid: 0, treble: 0, energy: 0, centroid: 0.3 };
    this.fluxRun = 0;
    this.lastBeat = 0;
    this.beatTimes = [];
    this.bpm = 0;
    this.beatConf = 0;         // 0..1 how steady/percussive the beat is
    this.kick = 0;             // sharp envelope that snaps on each beat
    this.beatThisFrame = false;

    this.moodIdx = 0;          // start on "Calm"
    this.moodCand = 0;
    this.moodHold = 0;
    this.mood = MOODS[this.moodIdx];
    this.sprites = this.mood.colors.map((c) => makeGlowSprite(c[0], c[1], c[2]));

    // Journey-mode state.
    this.cam = { px: 0, vpx: 0, py: 0, vpy: 0, roll: 0, vroll: 0, focal: 1, vfocal: 0, speed: 0.1, vspeed: 0 };
    this.fsm = {
      state: 'DRIFT', cur: { ...STATES.DRIFT }, from: { ...STATES.DRIFT }, to: { ...STATES.DRIFT },
      blendT: 1, transMs: 800, timeInState: 0, eSlopeS: 0, ePrev: 0, dropSurge: 0, shake: 0, flash: 0, lastDrop: -9999,
    };
    this.stars = [];
    this.lastMs = 0;
    this.journeyHue = 0;

    // Scene system (the distinct worlds the journey flies through).
    this.sceneObj = SCENES.find((s) => s.id === FIRST_SCENE) || SCENES[0];
    this.sceneHist = [this.sceneObj.id];
    this.sceneTime = 0;
    this.sceneLock = 0;
    this.kaleoN = 6;
    this.cam.spin = 0;
    if (this.journey) {
      this.sprites = this.sceneObj.colors.map((c) => makeGlowSprite(c[0], c[1], c[2]));
    }

    // Ride system (the continuous generative rollercoaster).
    this.actIdx = 0;
    this.actObj = RIDE_ACTS[0];
    this.prevActObj = null;
    this.actT = 0;
    this.actDur = 22;
    this.actBlend = 1;          // 0..1 cross-fade of the current act over the previous
    this.rideS = 0;             // distance travelled along the track
    this.rideSpeed = 0.18; this.vrideSpeed = 0;
    this.rideSurge = 0;         // transient speed boost (drops / warps)
    this.bendX = 0; this.vbendX = 0; this.bendXT = 0;   // track curvature (yaw)
    this.bendY = 0; this.vbendY = 0; this.bendYT = 0;   // track pitch (hills / dives)
    this.bendYDrop = 0;
    this.rideRoll = 0; this.vrideRoll = 0;              // bank into the turns
    this.rideFlash = 0;
    this.rideRings = [];
    this.rideIntensity = 0;
    this._lastRideDrop = -9999;
    if (this.ride) {
      this.sprites = this.actObj.colors.map((c) => makeGlowSprite(c[0], c[1], c[2]));
    }

    this._onResize = () => this.resize();
  }

  start(analyser) {
    this.analyser = analyser || null;
    if (this.analyser) {
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.7;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    }
    this.resize();
    window.addEventListener('resize', this._onResize);
    const loop = () => { this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener('resize', this._onResize);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.journey ? 1.5 : 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    const bg = this.background ? [14, 15, 19] : this.mood.bg;
    this.ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    this.ctx.fillRect(0, 0, w, h);

    if (this.journey || this.ride) {
      this.focalBase = 0.8 * Math.min(w, h);
      this.cam.focal = this.focalBase;
      // The ride wants a denser dust field so the tube feels alive at speed.
      const n = this.ride ? Math.min(4200, Math.round((w * h) / 420)) : Math.min(3200, Math.round((w * h) / 640));
      this.particles = [];
      for (let i = 0; i < n; i++) { const p = {}; if (this.ride) this._seedRide(p, RIDE.ZN, RIDE.ZF); else this._seedJ(p, J.ZNEAR, J.ZFAR); this.particles.push(p); }
      this.stars = [];
      const sc = Math.round((w * h) / 9000);
      for (let i = 0; i < sc; i++) this.stars.push({ x: Math.random() * w, y: Math.random() * h, a: 0.2 + Math.random() * 0.5, ph: Math.random() * 6.28 });
      this._buildVignette();
      return;
    }

    this.baseCount = this.background
      ? Math.round(Math.min(650, (w * h) / 3200))
      : Math.round(Math.min(2600, (w * h) / 760));
    this._resizeParticles(Math.round(this.baseCount * this.mood.density));
  }

  _buildVignette() {
    const c = document.createElement('canvas');
    c.width = this.W; c.height = this.H;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(this.W / 2, this.H / 2, Math.min(this.W, this.H) * 0.32, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.72);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = grad; g.fillRect(0, 0, this.W, this.H);
    this.vignette = c;
  }

  /** Seed a journey particle at depth [zMin,zMax]; x/y spread to fill the frame. */
  _seedJ(p, zMin, zMax) {
    p.z = zMin + Math.random() * (zMax - zMin);
    // sensible defaults; the scene's place() overrides x/y (and may set baseSz)
    p.sprite = (Math.random() * 3) | 0;
    p.baseSz = 0.07 + Math.random() * 0.13;
    p.seed = Math.random() * 1000;
    this.sceneObj.place.call(this, p);
  }

  /** Seed a ride particle as drifting dust in the track's tube cross-section. */
  _seedRide(p, zMin, zMax) {
    p.z = zMin + Math.random() * (zMax - zMin);
    const ang = Math.random() * 6.2832;
    // Bias toward the tube wall so dust streaks past you, not just at the centre.
    const rad = 0.14 + Math.pow(Math.random(), 0.6) * 0.42;
    p.x = Math.cos(ang) * rad;
    p.y = Math.sin(ang) * rad;
    p.sprite = (Math.random() * 3) | 0;
    p.baseSz = 0.05 + Math.random() * 0.12;
    p.seed = Math.random() * 1000;
  }

  _resizeParticles(target) {
    const cur = this.particles.length;
    if (target > cur) {
      for (let i = cur; i < target; i++) {
        this.particles.push({
          x: Math.random() * this.W, y: Math.random() * this.H,
          vx: 0, vy: 0, sprite: (Math.random() * 3) | 0, sz: 5 + Math.random() * 9,
        });
      }
    } else if (target < cur) {
      this.particles.length = Math.max(0, target);
    }
  }

  _setMood(idx) {
    this.moodIdx = idx; this.moodHold = 0;
    this.mood = MOODS[idx];
    this.sprites = this.mood.colors.map((c) => makeGlowSprite(c[0], c[1], c[2]));
    this._resizeParticles(Math.round(this.baseCount * this.mood.density));
  }

  _now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : this.t * 16.7; }

  /** Extract bands + centroid, detect onsets via spectral flux, estimate BPM. */
  _analyze() {
    this.beatThisFrame = false;
    let bass; let mid; let treble; let centroid; let flux = 0;
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.freq);
      const f = this.freq; const N = f.length;
      const band = (a, b) => { let s = 0; const hi = Math.min(b, N); for (let i = a; i < hi; i++) s += f[i]; return s / ((hi - a) * 255); };
      bass = band(1, 8); mid = band(10, 40); treble = band(50, 150);
      let num = 0; let den = 0;
      for (let i = 1; i < N; i++) { const m = f[i]; num += i * m; den += m; }
      centroid = den > 0 ? (num / den) / N : 0.3;
      // Spectral flux over low/low-mid (kick/snare band): sum of positive changes.
      if (this.prevFreq) {
        const hi = Math.min(64, N);
        for (let i = 1; i < hi; i++) { const d = f[i] - this.prevFreq[i]; if (d > 0) flux += d; }
        flux /= (hi - 1) * 255;
      } else {
        this.prevFreq = new Uint8Array(N);
      }
      this.prevFreq.set(f);
    } else {
      const b = 0.22 + 0.18 * Math.sin(this.t * 0.04);
      bass = b; mid = b * 0.6; treble = 0.18; centroid = 0.3;
    }
    const energy = (bass + mid + treble) / 3;

    const s = this.smooth; const k = 0.16;
    s.bass += (bass - s.bass) * 0.5;
    s.mid += (mid - s.mid) * k;
    s.treble += (treble - s.treble) * k;
    s.energy += (energy - s.energy) * k;
    s.centroid += (centroid - s.centroid) * k;

    // Onset = a flux spike clearly above its running level (refractory ~200 ms).
    const now = this._now();
    this.fluxRun += (flux - this.fluxRun) * 0.1;
    if (flux > this.fluxRun * 1.6 + 0.006 && now - this.lastBeat > 200) {
      this.lastBeat = now;
      this.beatThisFrame = true;
      this.kick = 1;
      this.beatTimes.push(now);
      if (this.beatTimes.length > 14) this.beatTimes.shift();
      this._updateBpm();
    }
    this.kick *= 0.86;
    this._updateConfidence(now);

    return { bass: s.bass, mid: s.mid, treble: s.treble, energy: s.energy, centroid: s.centroid };
  }

  _updateBpm() {
    if (this.beatTimes.length < 4) return;
    const iv = [];
    for (let i = 1; i < this.beatTimes.length; i++) iv.push(this.beatTimes[i] - this.beatTimes[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    if (!med) return;
    let bpm = 60000 / med;
    while (bpm < 70) bpm *= 2;     // octave-fold into a musical range
    while (bpm > 170) bpm /= 2;
    this.bpm = this.bpm ? this.bpm + (bpm - this.bpm) * 0.2 : bpm;
  }

  /** Confidence the beat is steady/regular (low inter-onset variance, recent). */
  _updateConfidence(now) {
    let target = 0;
    if (this.beatTimes.length >= 4 && now - this.lastBeat < 1600) {
      const iv = [];
      for (let i = 1; i < this.beatTimes.length; i++) iv.push(this.beatTimes[i] - this.beatTimes[i - 1]);
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      let v = 0; for (const x of iv) v += (x - mean) * (x - mean); v /= iv.length;
      const cv = Math.sqrt(v) / (mean || 1);   // coefficient of variation
      target = Math.max(0, Math.min(1, 1 - cv * 2.2));
    }
    this.beatConf += (target - this.beatConf) * 0.08;
  }

  _detectMood(f) {
    const conf = this.beatConf;
    const bpm = this.bpm;
    const bassDom = f.bass / (f.energy + 0.01);
    let m;
    if (f.energy < 0.12) m = 0;                              // Calm
    else if (conf > 0.5 && bpm >= 120) m = 5;                // Drive (fast + steady beat)
    else if (conf > 0.45 && bassDom > 0.38) m = 4;           // Groove (beat-forward, bassy)
    else if (f.energy > 0.42 && f.centroid < 0.4) m = 2;     // Epic (loud + warm/dark, e.g. orchestral)
    else if (f.centroid > 0.5) m = 3;                        // Bright
    else m = 1;                                              // Warm

    if (m === this.moodIdx) { this.moodHold = 0; this.moodCand = m; }
    else if (m === this.moodCand) { if (++this.moodHold > 80) this._setMood(m); }
    else { this.moodCand = m; this.moodHold = 0; }
  }

  frame() {
    if (this.ride) { this._frameRide(); return; }
    if (this.journey) { this._frameJourney(); return; }
    this.t++;
    const ctx = this.ctx; const W = this.W; const H = this.H;
    const a = this._analyze();
    this._detectMood(a); // backdrop palette follows the music
    const mood = this.mood;
    const bgMode = this.background;
    const dim = bgMode ? 0.6 : 1;

    // Trails: fade toward the background.
    ctx.globalCompositeOperation = 'source-over';
    const bg = bgMode ? [9, 10, 14] : mood.bg;
    ctx.fillStyle = `rgba(${bg[0]},${bg[1]},${bg[2]},${bgMode ? 0.15 : 0.15})`;
    ctx.fillRect(0, 0, W, H);

    // Particles (additive glow). Tempo drives motion when the beat is confident;
    // otherwise energy does. The backdrop reacts harder so it feels alive.
    ctx.globalCompositeOperation = 'lighter';
    const scale = 0.0016;
    const tempoF = (this.beatConf > 0.4 && this.bpm) ? this.bpm / 120 : 1;
    const drift = this.t * 0.0013 * mood.fieldEvo * (0.6 + tempoF * 0.6);
    const force = (0.14 + a.bass * (bgMode ? 1.6 : 0.9) + this.kick * (bgMode ? 0.9 : 0.4) * this.beatConf) * mood.force;
    const speedCap = (1.2 + a.energy * (bgMode ? 6.5 : 4.5)) * mood.speed * (0.7 + tempoF * 0.5);
    const sizeBoost = 0.8 + a.treble * 0.9 + this.kick * (bgMode ? 1.1 : 0.5);
    for (const p of this.particles) {
      const ang = this.noise(p.x * scale + drift, p.y * scale) * Math.PI * 2 * 1.4;
      p.vx = (p.vx + Math.cos(ang) * force) * 0.92;
      p.vy = (p.vy + Math.sin(ang) * force) * 0.92;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > speedCap) { const kk = speedCap / sp; p.vx *= kk; p.vy *= kk; }
      p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20; else if (p.y > H + 20) p.y = -20;
      ctx.globalAlpha = Math.min(0.9, 0.12 + sp * 0.5) * dim;
      const s = p.sz * sizeBoost * (this.background ? 0.8 : 1);
      ctx.drawImage(this.sprites[p.sprite], p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    // The backdrop variant is particles-only — no rings or readout.
    if (this.background) { ctx.globalCompositeOperation = 'source-over'; return; }

    // Rings, centered. Beats spawn expanding rings; steady rings breathe.
    const cx = W / 2; const cy = H / 2;
    const hue = mood.ringHue + a.treble * 40 - 20;
    const minDim = Math.min(W, H);

    if (this.beatThisFrame) {
      this.rings.push({ r: 18 + a.bass * 60, life: 1, hue });
    }
    // Steady rings snap on the beat "kick" (tempo-synced); fall back to a gentle
    // bass swell when there's no clear beat.
    const pulse = Math.max(this.kick * (0.4 + this.beatConf * 0.6), a.bass * 0.55);
    for (let i = 1; i <= 3; i++) {
      const r = (minDim * (0.07 * i + 0.05) + pulse * 90 + i * 6) * mood.ringScale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue}, 80%, 62%, ${0.07 + a.energy * 0.22})`;
      ctx.lineWidth = 1 + a.mid * 4;
      ctx.shadowBlur = 16 + a.bass * 28;
      ctx.shadowColor = `hsla(${hue}, 90%, 60%, 0.8)`;
      ctx.stroke();
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const rg = this.rings[i];
      rg.r += (3 + a.treble * 9) * mood.ringScale;
      rg.life -= 0.012;
      if (rg.life <= 0 || rg.r > minDim * 1.1) { this.rings.splice(i, 1); continue; }
      ctx.beginPath();
      ctx.arc(cx, cy, rg.r, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${rg.hue}, 85%, 66%, ${rg.life * 0.5})`;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 22;
      ctx.shadowColor = `hsla(${rg.hue}, 90%, 66%, ${rg.life})`;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Readout: BPM + detected mood.
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const showBpm = this.beatConf > 0.4 && this.bpm;
    const label = (showBpm ? `${Math.round(this.bpm)} BPM · ` : '') + mood.name;
    ctx.fillText(label, 24, H - 24);
  }

  // ---- Journey mode ----------------------------------------------------------

  _dropPayload(E) {
    const f = this.fsm;
    f.shake = 1; f.flash = Math.min(1, 0.55 + E * 0.5); f.dropSurge = 0.5;
    // Burst: fling a batch of particles right past the camera.
    const n = Math.min(160, this.particles.length);
    for (let i = 0; i < n; i++) this._seedJ(this.particles[(Math.random() * this.particles.length) | 0], 1.2, 3.5);
  }

  _updateFSM(a, dt) {
    const f = this.fsm;
    f.timeInState += dt * 1000;
    const slope = a.energy - f.ePrev; f.ePrev = a.energy;
    f.eSlopeS += (slope - f.eSlopeS) * 0.1;
    const E = a.energy; const conf = this.beatConf; const kick = this.kick; const now = this._now();
    const go = (s, ms = 800) => {
      if (s === f.state) return;
      f.from = { ...f.cur }; f.to = { ...STATES[s] }; f.blendT = 0; f.transMs = ms;
      f.state = s; f.timeInState = 0;
      if (s === 'DROP') { f.lastDrop = now; this._dropPayload(E); }
    };
    if (f.timeInState > 500) {
      switch (f.state) {
        case 'DRIFT':
          if (f.eSlopeS > 0.004 && E > 0.2) go('BUILD');
          break;
        case 'BUILD':
          if (this.beatThisFrame && kick > 0.8 && E > 0.4 && conf > 0.45 && now - f.lastDrop > 3000) go('DROP', 250);
          else if (E > 0.55 && conf > 0.5) go('TUNNEL');
          else if (f.eSlopeS < -0.003) go('DRIFT');
          break;
        case 'DROP':
          if (f.timeInState > 1200) go(conf > 0.5 && E > 0.45 ? 'TUNNEL' : 'DRIFT');
          break;
        case 'TUNNEL':
          if (E < 0.3 || conf < 0.35) go('CALM');
          else if (this.beatThisFrame && kick > 0.85 && f.eSlopeS > 0.006 && now - f.lastDrop > 3000) go('DROP', 250);
          break;
        case 'CALM':
          if (f.eSlopeS > 0.004) go('BUILD');
          else if (f.timeInState > 3000 && E > 0.18) go('DRIFT');
          break;
        default: break;
      }
    }
    f.blendT = Math.min(1, f.blendT + (dt * 1000) / f.transMs);
    const e = easeInOutCubic(f.blendT);
    for (const k in STATES.DRIFT) f.cur[k] = f.from[k] + (f.to[k] - f.from[k]) * e;
    f.dropSurge *= 0.92; f.shake *= 0.85; f.flash *= 0.9;
  }

  _updateCamera(a, dt, dt60) {
    const cam = this.cam; const f = this.fsm; const sc = this.sceneObj.cam;
    const tempoF = (this.beatConf > 0.4 && this.bpm) ? this.bpm / 120 : 1;
    const tspeed = (0.06 + a.energy * 0.42) * tempoF * sc.speedMul + f.dropSurge;

    // Continuous roll-spin for radial worlds (keeps particles + structure in sync).
    this.cam.spin += (sc.rollSpin || 0) * (1 + a.treble * 1.5) * dt60;

    const tn = this.t * 0.00035;
    const turnX = this.noise(tn, 11.3); const turnY = this.noise(tn + 50, 7.1) * 0.6;
    const swayX = (sc.swayX || 0) * this.W * Math.sin(this.t * 0.012);
    const swayY = (sc.swayY || 0) * this.H * Math.sin(this.t * 0.006);
    const tx = (turnX * 0.08 * this.W) * sc.turnGain + swayX;
    const ty = (turnY * 0.06 * this.H) * sc.turnGain + (sc.pyOff || 0) * this.H + swayY;
    const troll = (turnX * 0.15) * sc.turnGain;
    const tfocal = this.focalBase * sc.focalMul * (1 + this.kick * 0.16 * (0.4 + this.beatConf * 0.6));
    [cam.px, cam.vpx] = smoothDamp(cam.px, cam.vpx, tx, 0.4, dt);
    [cam.py, cam.vpy] = smoothDamp(cam.py, cam.vpy, ty, 0.5, dt);
    [cam.roll, cam.vroll] = smoothDamp(cam.roll, cam.vroll, troll, 0.5, dt);
    [cam.focal, cam.vfocal] = smoothDamp(cam.focal, cam.vfocal, tfocal, 0.12, dt);
    [cam.speed, cam.vspeed] = smoothDamp(cam.speed, cam.vspeed, Math.min(1.4, tspeed), 0.45, dt);
    if (this.beatThisFrame) cam.vspeed += 0.06 * (0.35 + this.beatConf * 0.65);
  }

  // ---- Conductor: evolve between distinct worlds ----------------------------

  /** Dissolve into a specific world (shared by the auto-conductor and manual nav). */
  _beginScene(next) {
    if (!next || next === this.sceneObj) return;
    this.sceneObj = next;
    this.sprites = next.colors.map((c) => makeGlowSprite(c[0], c[1], c[2]));
    this.sceneHist.push(next.id);
    if (this.sceneHist.length > 6) this.sceneHist.shift();
    this.sceneTime = 0; this.sceneLock = 6;
    this.cam.spin = 0;
    // Smooth dissolve: a soft bloom + gentle surge while the new world streams in
    // from the distance — reseed at FAR depth (not across all Z) so nothing pops
    // into the foreground; the formation glides toward the camera together.
    this.fsm.flash = 0.42; this.fsm.shake = 0.3; this.fsm.dropSurge = 0.32;
    this.cam.vspeed += 0.35;
    for (const p of this.particles) this._seedJ(p, J.ZFAR * 0.55, J.ZFAR);
  }

  _switchScene() {
    this._beginScene(pickNextScene(this.sceneObj.id, this.sceneHist.slice(-3)));
  }

  /** Manual scene navigation (← / → in the visualizer) — steps the scene list. */
  _stepScene(dir) {
    const n = SCENES.length;
    const i = Math.max(0, SCENES.indexOf(this.sceneObj));
    this._beginScene(SCENES[((i + dir) % n + n) % n]);
  }
  nextScene() { if (this.ride) { this._nextAct(1, true); return; } this._stepScene(1); }
  prevScene() { if (this.ride) { this._nextAct(-1, true); return; } this._stepScene(-1); }

  _updateConductor(a, dt) {
    this.sceneTime += dt;
    if (this.sceneLock > 0) this.sceneLock -= dt;
    const f = this.fsm;
    const justDropped = f.state === 'DROP' && f.timeInState < dt * 1000 * 2;
    const MIN_DWELL = 18; const MAX_DWELL = 78;
    if (this.sceneTime > MAX_DWELL) { this._switchScene(); return; }
    if (this.sceneTime < MIN_DWELL || this.sceneLock > 0) return;
    if (justDropped && this.beatConf > 0.45) this._switchScene();
  }

  _frameJourney() {
    this.t++;
    const now = this._now();
    const dt = Math.min((now - (this.lastMs || now)) / 1000, 1 / 30);
    this.lastMs = now;
    const dt60 = dt * 60;

    const a = this._analyze();
    this._updateFSM(a, dt);
    this._updateCamera(a, dt, dt60);
    this._updateConductor(a, dt);

    const ctx = this.ctx; const W = this.W; const H = this.H; const cam = this.cam; const f = this.fsm;
    const scene = this.sceneObj;
    const hue = scene.hue;

    // 1. Trail fade toward the scene background, with a beat-driven shake.
    ctx.globalCompositeOperation = 'source-over';
    const bg = scene.bg;
    ctx.fillStyle = `rgba(${bg[0]},${bg[1]},${bg[2]},${scene.cam.trailFade})`;
    ctx.fillRect(0, 0, W, H);
    const shk = f.shake * 9;
    const shx = shk ? (Math.random() * 2 - 1) * shk : 0;
    const shy = shk ? (Math.random() * 2 - 1) * shk : 0;
    const cx = W / 2 + cam.px + shx; const cy = H / 2 + cam.py + shy;

    // 2. Parallax starfield behind everything.
    for (const st of this.stars) {
      const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this.t * 0.05 + st.ph));
      ctx.fillStyle = `rgba(200,210,255,${st.a * tw * 0.4})`;
      ctx.fillRect((st.x - cam.px * 0.15 + W) % W, (st.y - cam.py * 0.15 + H) % H, 1.5, 1.5);
    }

    const F = cam.focal; const speed = cam.speed;
    const cr = Math.cos(cam.roll); const sr = Math.sin(cam.roll);
    const spin = cam.spin; const cs = Math.cos(spin); const sn = Math.sin(spin);
    const doSpin = (scene.cam.rollSpin || 0) > 0;
    const kpulse = 1 + this.kick * 0.28 * (0.5 + this.beatConf * 0.5); // motes bloom on the beat
    const shard = scene.style === 'shard';
    const isLine = scene.style === 'line';
    const cols = scene.colors;
    const tdrift = this.t * 0.004;
    // Each world uses only a fraction of the shared pool — ground worlds (synthwave,
    // city) want a sparse scatter of stars, not the full dense field.
    const activeN = Math.round(this.particles.length * (scene.density == null ? 1 : scene.density));
    // Per-scene mote brightness — dense/pale-toned worlds (galaxy, rain) would
    // otherwise stack additively toward a white blowout.
    const moteA = scene.moteAlpha == null ? 1 : scene.moteAlpha;
    // Per-scene max mote size (px). Keeps "star field" worlds (galaxy) as fine
    // points — without it, particles balloon into bright blobs as they approach.
    const sizeCap = scene.maxMote == null ? Infinity : scene.maxMote;

    // Perspective forward-flight pass. Radial worlds rotate the whole formation in
    // lockstep with the structural overlay (cam.spin).
    const drawParticles = () => {
      ctx.globalCompositeOperation = 'lighter';
      for (let idx = 0; idx < activeN; idx++) {
        const p = this.particles[idx];
        p.z -= speed * dt60;
        if (p.z < J.ZNEAR) { this._seedJ(p, J.ZFAR - 0.5, J.ZFAR); continue; }
        const nx = this.noise(p.seed, tdrift) * 0.012 * p.z;
        const ny = this.noise(p.seed + 50, tdrift) * 0.012 * p.z;
        let wx = p.x + nx; let wy = p.y + ny;
        if (doSpin) { const rx = wx * cs - wy * sn; const ry = wx * sn + wy * cs; wx = rx; wy = ry; }
        const inv = F / p.z;
        let sx = cx + wx * inv; let sy = cy + wy * inv;
        const ddx = sx - cx; const ddy = sy - cy;
        sx = cx + ddx * cr - ddy * sr; sy = cy + ddx * sr + ddy * cr;
        let size = p.baseSz * inv * kpulse;
        if (size < 0.5) continue;
        if (size > sizeCap) size = sizeCap;
        if (sx < -size || sx > W + size || sy < -size || sy > H + size) continue;
        const fog = Math.max(0, Math.min(1, (J.ZFAR - p.z) / (J.ZFAR - J.ZFOG0)));
        const alpha = Math.min(0.95, fog * Math.min(1, inv * 0.4));
        if (isLine) {
          const c = cols[p.sprite];
          ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha * 0.9 * moteA})`;
          ctx.lineWidth = Math.max(0.6, size * 0.16);
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - size * 0.35, sy - size * 2.6); ctx.stroke();
        } else if (shard) {
          const c = cols[p.sprite];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha * moteA})`;
          ctx.beginPath();
          ctx.moveTo(sx, sy - size); ctx.lineTo(sx + size * 0.7, sy); ctx.lineTo(sx, sy + size); ctx.lineTo(sx - size * 0.7, sy);
          ctx.closePath(); ctx.fill();
        } else {
          ctx.globalAlpha = alpha * moteA;
          const sp = this.sprites[p.sprite];
          ctx.drawImage(sp, sx - size / 2, sy - size / 2, size, size);
          if (alpha > 0.6) { ctx.globalAlpha = alpha * 0.3 * moteA; ctx.drawImage(sp, sx - size, sy - size, size * 2, size * 2); }
        }
      }
      ctx.globalAlpha = 1;
    };
    // Always hand the scene render a clean source-over baseline — particle passes
    // leave the context in 'lighter', which would blow opaque structure (the
    // synthwave sun's colored disc + dark bands) out to white.
    const drawStructure = () => {
      ctx.globalCompositeOperation = 'source-over';
      scene.render.call(this, ctx, cx, cy, F, a, this.t, speed, hue);
    };

    // 3 + 4. Draw order: opaque-background worlds (sunset/forest/rainy) paint first
    //    with particles glowing ON TOP; additive worlds (synthwave/city/space) draw
    //    their structure OVER the particle field so motes sit behind the neon/sun.
    if (scene.over) { drawStructure(); drawParticles(); }
    else { drawParticles(); drawStructure(); }

    // 5. Drop / transition bloom flash.
    if (f.flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.6, f.flash * 0.6)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // 6. Atmosphere + readout.
    ctx.globalCompositeOperation = 'source-over';
    if (this.vignette) { ctx.globalAlpha = 0.7 + (1 - a.energy) * 0.3; ctx.drawImage(this.vignette, 0, 0, W, H); ctx.globalAlpha = 1; }
    ctx.font = '600 12px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const showBpm = this.beatConf > 0.4 && this.bpm;
    ctx.fillText((showBpm ? `${Math.round(this.bpm)} BPM · ` : '') + `${scene.name}`, 24, H - 24);
  }

  // ---- Ride mode: a continuous generative rollercoaster --------------------

  /** Warp into the next/prev act (manual ← / → or the auto-timeline). */
  _nextAct(dir, warp) {
    this.prevActObj = this.actObj;
    this.actIdx = (this.actIdx + dir + RIDE_ACTS.length) % RIDE_ACTS.length;
    this.actObj = RIDE_ACTS[this.actIdx];
    this.sprites = this.actObj.colors.map((c) => makeGlowSprite(c[0], c[1], c[2]));
    this.actT = 0;
    this.actBlend = warp ? 0 : 1;
    this.actDur = 20 + Math.random() * 14;
    if (warp) { this.rideSurge += 0.6; this.rideFlash = Math.max(this.rideFlash, 0.55); }
  }

  /** Advance the generative track: winding curvature, banking, speed, act timeline. */
  _updateRide(a, dt, dt60) {
    const tempoF = (this.beatConf > 0.4 && this.bpm) ? this.bpm / 120 : 1;
    this.rideIntensity += (a.energy - this.rideIntensity) * 0.04;

    // Speed: rolls with energy/tempo; drops add a surge + a dive on the track.
    const now = this._now();
    if (this.beatThisFrame && this.kick > 0.82 && a.energy > 0.45 && this.beatConf > 0.42 && now - this._lastRideDrop > 2600) {
      this._lastRideDrop = now;
      this.rideSurge += 0.55;
      this.bendYDrop = 0.7;
      this.rideFlash = Math.max(this.rideFlash, Math.min(0.5, 0.3 + a.energy * 0.4));
      if (this.rideRings.length < 12) this.rideRings.push({ z: RIDE.ZFOG, life: 1 });
    }
    this.rideSurge *= 0.94; this.bendYDrop *= 0.92;
    const tspeed = 0.16 * (0.6 + a.energy * 1.8) * tempoF + this.rideSurge;
    [this.rideSpeed, this.vrideSpeed] = smoothDamp(this.rideSpeed, this.vrideSpeed, Math.min(1.7, tspeed), 0.5, dt);
    this.rideS += this.rideSpeed * dt60 * 0.5;

    // Generative winding path from layered noise of distance travelled.
    const s = this.rideS;
    this.bendXT = this.noise(s * 0.018, 3.1) * 0.8 + this.noise(s * 0.05, 9.7) * 0.3;
    this.bendYT = this.noise(s * 0.02, 17.4) * 0.5 + this.bendYDrop;
    [this.bendX, this.vbendX] = smoothDamp(this.bendX, this.vbendX, this.bendXT, 0.7, dt);
    [this.bendY, this.vbendY] = smoothDamp(this.bendY, this.vbendY, this.bendYT, 0.8, dt);

    // Bank into the turn — roll proportional to curvature + its rate of change.
    let rollT = -this.bendX * 0.5 - this.vbendX * 0.16;
    rollT = Math.max(-0.6, Math.min(0.6, rollT));
    [this.rideRoll, this.vrideRoll] = smoothDamp(this.rideRoll, this.vrideRoll, rollT, 0.35, dt);

    // Beat rings (gentle, all acts).
    if (this.beatThisFrame && this.kick > 0.5 && this.rideRings.length < 12) this.rideRings.push({ z: RIDE.ZFOG, life: 1 });

    // Act timeline (auto-advance once the cross-fade has settled).
    this.actT += dt;
    if (this.actBlend < 1) this.actBlend = Math.min(1, this.actBlend + dt / 1.4);
    if (this.actT > this.actDur && this.actBlend >= 1) this._nextAct(1, true);
    this.rideFlash *= 0.92;
  }

  _frameRide() {
    this.t++;
    const now = this._now();
    const dt = Math.min((now - (this.lastMs || now)) / 1000, 1 / 30);
    this.lastMs = now;
    const dt60 = dt * 60;

    const a = this._analyze();
    this._updateRide(a, dt, dt60);

    const ctx = this.ctx; const W = this.W; const H = this.H;
    const cur = this.actObj; const prev = this.prevActObj; const blend = this.actBlend;

    // Trail-fade toward the (blended) act background — light motion blur.
    const lb = (i) => ((prev && blend < 1) ? Math.round(prev.bg[i] * (1 - blend) + cur.bg[i] * blend) : cur.bg[i]);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${lb(0)},${lb(1)},${lb(2)},0.22)`;
    ctx.fillRect(0, 0, W, H);

    // Camera rig: perspective + path curvature (curve grows with depth) + bank roll.
    const kick = this.kick;
    const F = this.focalBase * (1 + kick * 0.05);
    const cx = W / 2; const cy = H / 2;
    const cosR = Math.cos(this.rideRoll); const sinR = Math.sin(this.rideRoll);
    const CX = 0.011 * W; const CY = 0.010 * H; const bendX = this.bendX; const bendY = this.bendY;
    const project = (wx, wy, z) => {
      const inv = F / z;
      const ox = bendX * z * CX; const oy = bendY * z * CY;
      const px = cx + wx * inv + ox; const py = cy + wy * inv + oy;
      const dx = px - cx; const dy = py - cy;
      return [cx + dx * cosR - dy * sinR, cy + dx * sinR + dy * cosR, inv];
    };
    // Pre-roll vanishing point — acts (terrain) draw a banked sky around it so the
    // horizon tilts WITH the projected ground instead of staying level.
    const horizonX = cx + bendX * RIDE.ZF * CX;
    const horizonY = cy + bendY * RIDE.ZF * CY;
    const mkR = (act, alpha) => ({
      ctx, W, H, cx, cy, F, t: this.t, rideS: this.rideS, speed: this.rideSpeed,
      kick, beat: this.beatThisFrame, beatConf: this.beatConf,
      energy: a.energy, bass: a.bass, mid: a.mid, treble: a.treble,
      hue: act.hue, colors: act.colors, znear: RIDE.ZN, zfar: RIDE.ZF, zfog0: RIDE.ZFOG,
      alpha, roll: this.rideRoll, bendX, bendY, horizonX, horizonY,
      center: (z) => project(0, 0, z), project,
    });

    // Draw the world (cross-fade the outgoing act during a warp).
    if (prev && blend < 1) prev.draw(mkR(prev, 1 - blend));
    cur.draw(mkR(cur, blend >= 1 ? 1 : blend));

    // Sound rings rushing toward the camera along the track.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.rideRings.length - 1; i >= 0; i--) {
      const rg = this.rideRings[i];
      rg.z -= this.rideSpeed * dt60 * 1.1; rg.life -= 0.012;
      if (rg.z < RIDE.ZN || rg.life <= 0) { this.rideRings.splice(i, 1); continue; }
      const c = project(0, 0, rg.z); const rad = 0.34 * c[2];
      ctx.strokeStyle = `hsla(${cur.hue},90%,68%,${(rg.life * 0.4).toFixed(3)})`;
      ctx.lineWidth = 1.4 + 2 * (1 - Math.min(1, rg.z / RIDE.ZFOG));
      ctx.beginPath(); ctx.ellipse(c[0], c[1], rad, rad * 0.9, this.rideRoll, 0, 6.2832); ctx.stroke();
    }

    // Tube-dust particles streaming past, on top of everything.
    const kpulse = 1 + kick * 0.25 * (0.5 + this.beatConf * 0.5);
    for (let idx = 0; idx < this.particles.length; idx++) {
      const p = this.particles[idx];
      p.z -= this.rideSpeed * dt60;
      if (p.z < RIDE.ZN) { this._seedRide(p, RIDE.ZF - 2, RIDE.ZF); continue; }
      const pr = project(p.x, p.y, p.z); const inv = pr[2];
      let size = p.baseSz * inv * kpulse;
      if (size < 0.5) continue;
      if (size > 3.5) size = 3.5;
      if (pr[0] < -size || pr[0] > W + size || pr[1] < -size || pr[1] > H + size) continue;
      const fog = Math.max(0, Math.min(1, (RIDE.ZF - p.z) / (RIDE.ZF - RIDE.ZFOG)));
      ctx.globalAlpha = Math.min(0.92, fog * Math.min(1, inv * 0.4)) * 0.85;
      ctx.drawImage(this.sprites[p.sprite], pr[0] - size / 2, pr[1] - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    // Warp / drop bloom.
    if (this.rideFlash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.5, this.rideFlash * 0.5)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Atmosphere + readout.
    ctx.globalCompositeOperation = 'source-over';
    if (this.vignette) { ctx.globalAlpha = 0.7 + (1 - a.energy) * 0.3; ctx.drawImage(this.vignette, 0, 0, W, H); ctx.globalAlpha = 1; }
    ctx.font = '600 12px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    const showBpm = this.beatConf > 0.4 && this.bpm;
    ctx.fillText((showBpm ? `${Math.round(this.bpm)} BPM · ` : '') + `RIDE · ${cur.name}`, 24, H - 24);
  }
}
