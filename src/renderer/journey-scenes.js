'use strict';

/**
 * Journey scenes — distinct worlds the cinematic visualizer flies through.
 * Consecutive scenes never share a form-family, so the ride never feels repetitive.
 *
 * place(p)  : sculpts the particle formation (this = Visualizer).
 * render(...): structural drawing, called BEFORE the particles so a scene may paint
 *             a full background (sunset sky, forest canopy) with particles glowing
 *             on top. (this = Visualizer; reads this.kick/beatThisFrame/cam.spin.)
 * cam       : per-scene camera character (calm, musical).
 * family    : ground | radial | mandala | flow | nature (forbids back-to-back repeats).
 */

export const SCENES = [
  // ---- GROUND ---------------------------------------------------------------
  {
    id: 'synthgrid', name: 'Synthwave Grid', family: 'ground', style: 'glow', density: 0.16,
    hue: 190, bg: [14, 7, 28], colors: [[205, 230, 255], [125, 255, 240], [255, 150, 220]],
    cam: { speedMul: 0.7, trailFade: 0.26, turnGain: 0.04, focalMul: 1.0, pyOff: 0.04, swayX: 0.02, swayY: 0.01, rollSpin: 0 },
    place(p) {
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      p.x = (Math.random() * 2 - 1) * rW;
      p.y = -(0.12 + Math.random() * 0.92) * rH;
      p.baseSz = 0.5 + Math.random() * 1.2;
    },
    render(ctx, cx, cy, F, a, t, speed) {
      const W = this.W; const H = this.H; const hy = cy + H * 0.06;
      if (this._sp === undefined) { this._sp = 0; this._flash = 0; }
      this._sp += 0.014 + speed * 0.85 + this.kick * 0.17;
      if (this.beatThisFrame) this._flash = 1;
      this._flash *= 0.90;
      const frac = this._sp - Math.floor(this._sp);
      const bass = a.bass || 0;
      const sunR = Math.min(W, H) * 0.155 * (1 + bass * 0.09 + this.kick * 0.035);
      const sxp = cx; const syc = hy - sunR * 0.55;
      ctx.save();
      ctx.beginPath(); ctx.arc(sxp, syc, sunR, 0, 6.283); ctx.clip();
      const g = ctx.createLinearGradient(sxp, syc - sunR, sxp, syc + sunR);
      g.addColorStop(0, '#ffe879'); g.addColorStop(0.45, '#ff8a3d'); g.addColorStop(0.72, '#ff4d8d'); g.addColorStop(1, '#b81fae');
      ctx.fillStyle = g; ctx.fillRect(sxp - sunR, syc - sunR, sunR * 2, sunR * 2);
      ctx.fillStyle = 'rgba(18,5,28,0.85)';
      for (let b = 0; b < 7; b++) { const bf = b / 7; const by = syc + sunR * 0.12 + bf * sunR * 0.96; const bh = sunR * 0.085 * (0.5 + bf); ctx.fillRect(sxp - sunR, by, sunR * 2, bh); }
      ctx.restore();
      ctx.globalCompositeOperation = 'lighter';
      const gg = ctx.createRadialGradient(sxp, syc, sunR * 0.6, sxp, syc, sunR * 2.3);
      gg.addColorStop(0, 'rgba(255,120,160,' + (0.16 + bass * 0.10) + ')'); gg.addColorStop(1, 'rgba(255,120,160,0)');
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(sxp, syc, sunR * 2.3, 0, 6.283); ctx.fill();
      const hg = ctx.createLinearGradient(0, hy - H * 0.10, 0, hy + H * 0.04);
      const hb = 0.20 + this.kick * 0.16;
      hg.addColorStop(0, 'rgba(255,60,180,0)'); hg.addColorStop(0.6, 'rgba(255,70,170,' + hb + ')'); hg.addColorStop(1, 'rgba(120,40,255,0)');
      ctx.fillStyle = hg; ctx.fillRect(0, hy - H * 0.10, W, H * 0.14);
      ctx.strokeStyle = 'rgba(255,185,230,' + (0.5 + this._flash * 0.4) + ')';
      ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();
      const floorH = H - hy; const lineA = 0.45 + this._flash * 0.45;
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 14; i++) { const t2 = (i + frac) / 14; const yy = hy + floorH * t2 * t2; const fade = Math.min(1, t2 * 2.2); ctx.strokeStyle = 'rgba(0,238,255,' + (lineA * fade) + ')'; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke(); }
      for (let c = -12; c <= 12; c++) { const xb = cx + (c / 12) * W * 1.6; ctx.strokeStyle = 'rgba(255,45,205,' + (lineA * 0.85) + ')'; ctx.beginPath(); ctx.moveTo(cx, hy); ctx.lineTo(xb, H); ctx.stroke(); }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    id: 'lightcity', name: 'Light City', family: 'ground', style: 'glow', density: 0.32,
    hue: 295, bg: [6, 7, 16], colors: [[255, 120, 220], [120, 220, 255], [230, 210, 255]],
    cam: { speedMul: 0.45, trailFade: 0.30, turnGain: 0.05, focalMul: 1.0, pyOff: 0.04, swayX: 0.035, swayY: 0.02, rollSpin: 0 },
    place(p) {
      const hw = this.W * 0.5; const hh = this.H * 0.5; const fb = this.focalBase;
      const r = Math.random(); let u; let v; let sz;
      if (r < 0.55) { u = Math.random() * 2 - 1; v = -1.0 + Math.random() * 0.42; sz = 0.035 + Math.random() * 0.05; }
      else if (r < 0.80) { u = (Math.random() * 2 - 1) * 0.16; v = -0.12 + Math.random() * 0.34; sz = 0.05 + Math.random() * 0.07; }
      else { const sd = Math.random() < 0.5 ? -1 : 1; u = sd * (0.33 + Math.random() * 0.68); v = -0.40 + Math.random() * 1.10; sz = 0.04 + Math.random() * 0.05; }
      p.x = u * hw * (p.z / fb); p.y = v * hh * (p.z / fb); p.baseSz = sz;
    },
    render(ctx, cx, cy, F, a, t, speed, hue) {
      const W = this.W; const H = this.H; const hw = W * 0.5; const hh = H * 0.5;
      const k = this.kick || 0; const tre = a.treble || 0; const en = a.energy || 0;
      if (this.beatThisFrame) { this._sweep = 0; this._fS = (Math.random() < 0.5 ? -1 : 1); this._fC = Math.floor(Math.random() * 5); }
      if (this._sweep == null) this._sweep = 1;
      this._sweep = Math.min(1, this._sweep + (this.bpm || 120) / 3600);
      if (this._fS == null) this._fS = -1;
      if (this._fC == null) this._fC = 0;
      const cols = 5; const edge = 0.30; const outer = 1.08;
      const floorV = 0.86; const floorY = cy + floorV * hh;
      const hueA = hue; const hueB = (hue + 160) % 360;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const vy = cy + H * 0.015; const botY = cy + hh * 1.02; const nh = W * 0.46;
      ctx.lineWidth = 1.3; ctx.strokeStyle = 'hsla(' + hueB + ',92%,58%,0.42)';
      ctx.beginPath(); ctx.moveTo(cx - nh, botY); ctx.lineTo(cx, vy); ctx.moveTo(cx + nh, botY); ctx.lineTo(cx, vy); ctx.stroke();
      for (let L = -2; L <= 2; L++) { if (L === 0) continue; ctx.strokeStyle = 'hsla(' + hueB + ',90%,60%,0.14)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx + (L / 3) * nh, botY); ctx.lineTo(cx, vy); ctx.stroke(); }
      const scr = (t * (0.05 + speed * 0.04)) % 1;
      for (let i = 0; i < 13; i++) { const dd = (i + scr) / 13; const pe = dd * dd; const ry = vy + (botY - vy) * pe; const rhw = nh * pe; ctx.strokeStyle = 'hsla(' + hueB + ',90%,' + (55 + 12 * pe) + '%,' + (0.08 + 0.22 * pe) + ')'; ctx.lineWidth = 0.7 + 1.5 * pe; ctx.beginPath(); ctx.moveTo(cx - rhw, ry); ctx.lineTo(cx + rhw, ry); ctx.stroke(); }
      if (this._sweep < 1) { const sp = this._sweep; const pe2 = sp * sp; const sy = vy + (botY - vy) * pe2; const shw = nh * pe2; ctx.strokeStyle = 'hsla(' + hueB + ',100%,78%,' + ((1 - sp) * 0.5 + 0.25) + ')'; ctx.lineWidth = 1.5 + 3 * (1 - sp) + k * 2; ctx.beginPath(); ctx.moveTo(cx - shw, sy); ctx.lineTo(cx + shw, sy); ctx.stroke(); }
      for (let side = -1; side <= 1; side += 2) {
        for (let c = 0; c < cols; c++) {
          let ns = Math.sin(c * 12.9 + side * 7.3) * 43758.5453; ns = ns - Math.floor(ns);
          const topV = -0.92 + ns * 0.46; const roofY = cy + topV * hh;
          const u0 = edge + (outer - edge) * c / cols; const u1 = edge + (outer - edge) * (c + 1) / cols;
          const x0 = cx + side * u0 * hw; const x1 = cx + side * u1 * hw;
          const fl = (this._fS === side && this._fC === c) ? k : 0;
          ctx.strokeStyle = 'hsla(' + hueA + ',88%,' + (58 + 18 * fl) + '%,' + (0.16 + 0.5 * fl) + ')'; ctx.lineWidth = 1 + 2 * fl;
          ctx.beginPath(); ctx.moveTo(x0, floorY); ctx.lineTo(x0, roofY); ctx.lineTo(x1, roofY); ctx.lineTo(x1, floorY); ctx.stroke();
          const wc = 2; const wr = 6;
          for (let wi2 = 0; wi2 < wc; wi2++) for (let wj = 0; wj < wr; wj++) {
            const wx = x0 + (x1 - x0) * ((wi2 + 0.5) / wc);
            const wv = topV + (floorV - topV) * ((wj + 0.6) / (wr + 0.3));
            const wy = cy + wv * hh;
            const ph = c * 3.7 + side * 1.3 + wi2 * 2.1 + wj * 0.9;
            const tw = 0.5 + 0.5 * Math.sin(t * 0.08 + ph);
            const br = (0.10 + 0.30 * tw) + tre * 0.45 * tw + fl * 0.4;
            if (br < 0.04) continue;
            const ww = (x1 - x0) / wc * 0.42; const wh = (floorY - roofY) / wr * 0.40;
            ctx.fillStyle = 'hsla(' + (hueA + (tw > 0.7 ? 6 : -4)) + ',95%,' + (60 + 18 * tw) + '%,' + Math.min(0.9, br) + ')';
            ctx.fillRect(wx - ww * 0.5, wy - wh * 0.5, ww, wh);
          }
        }
      }
      const hg = ctx.createLinearGradient(0, vy - H * 0.04, 0, vy + H * 0.04);
      hg.addColorStop(0, 'hsla(' + hueB + ',90%,60%,0)'); hg.addColorStop(0.5, 'hsla(' + hueB + ',95%,65%,' + (0.10 + en * 0.12) + ')'); hg.addColorStop(1, 'hsla(' + hueB + ',90%,60%,0)');
      ctx.fillStyle = hg; ctx.fillRect(cx - nh, vy - H * 0.04, nh * 2, H * 0.08);
      ctx.restore();
    },
  },

  // ---- RADIAL ---------------------------------------------------------------
  {
    id: 'wormhole', name: 'Wormhole Throat', family: 'radial', style: 'glow',
    hue: 265, bg: [8, 7, 18], colors: [[80, 120, 255], [120, 240, 255], [200, 90, 255]],
    cam: { speedMul: 1.0, trailFade: 0.12, turnGain: 0.4, focalMul: 1.0, pyOff: 0, swayX: 0, swayY: 0, rollSpin: 0.006 },
    place(p) {
      const ang = Math.random() * 6.2831853; const r = Math.random(); let wall;
      if (r < 0.60) { wall = 0.87 + (Math.random() - 0.5) * 0.05; p.shell = 0; }
      else if (r < 0.84) { wall = 0.66 + (Math.random() - 0.5) * 0.05; p.shell = 1; }
      else { wall = 0.30 + Math.random() * 0.28; p.shell = 2; }
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      p.x = Math.cos(ang) * wall * rW; p.y = Math.sin(ang) * wall * rH;
      p.baseSz = (p.shell === 2 ? 0.05 : 0.07) + Math.random() * 0.08;
    },
    render(ctx, cx, cy, F, a, t, speed, hue) {
      const cv = ctx.canvas; let S = cv._wh; if (!S) { S = { rings: [], pb: 0 }; cv._wh = S; }
      const W = this.W; const H = this.H; const asp = H / W; const rot = this.cam.spin;
      const hu = (hue + 18) % 360; const hu2 = (hue + 55) % 360; const hu3 = (hue + 80) % 360;
      ctx.globalCompositeOperation = 'lighter';
      const coreR = Math.min(W, H) * (0.11 + a.bass * 0.07);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3);
      g.addColorStop(0, 'hsla(' + hu + ',92%,72%,' + (0.16 + a.bass * 0.26) + ')'); g.addColorStop(0.5, 'hsla(' + hu2 + ',90%,55%,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, coreR * 3, 0, 6.2831853); ctx.fill();
      const rxO = W * 0.5 * 0.87; const ryO = H * 0.5 * 0.87; const rxI = coreR * 0.9; const ryI = coreR * 0.9 * asp;
      ctx.lineWidth = 1;
      for (let i = 0; i < 16; i++) {
        const th = rot + i * 0.392699; const c = Math.cos(th); const s = Math.sin(th);
        const x1 = cx + c * rxI; const y1 = cy + s * ryI; const x2 = cx + c * rxO; const y2 = cy + s * ryO;
        const lg = ctx.createLinearGradient(x1, y1, x2, y2);
        lg.addColorStop(0, 'hsla(' + hu + ',82%,66%,' + (0.08 + a.mid * 0.14) + ')'); lg.addColorStop(1, 'hsla(' + hu2 + ',82%,60%,0.02)');
        ctx.strokeStyle = lg; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      const onset = a.bass > S.pb * 1.25 + 0.06; S.pb = a.bass * 0.6 + S.pb * 0.4;
      if (onset && S.rings.length < 9) S.rings.push({ z: 24, e: Math.min(1.2, 0.5 + a.energy) });
      if (S.rings.length === 0 && (t % 46) === 0) S.rings.push({ z: 24, e: 0.6 });
      const zref = 7.5;
      for (let k = S.rings.length - 1; k >= 0; k--) {
        const R = S.rings[k]; R.z -= (speed * 60 * 0.9 + 0.25);
        if (R.z < 0.45) { S.rings.splice(k, 1); continue; }
        const sr = 0.87 * (zref / R.z); let fade = R.z > zref ? (24 - R.z) / (24 - zref) : Math.max(0, R.z / zref); fade = Math.max(0, Math.min(1, fade));
        ctx.lineWidth = 2 + 7 * (1 - Math.min(1, R.z / zref));
        ctx.strokeStyle = 'hsla(' + hu3 + ',96%,' + (58 + fade * 22) + '%,' + (fade * 0.8 * R.e) + ')';
        ctx.beginPath(); ctx.ellipse(cx, cy, W * 0.5 * sr, H * 0.5 * sr, 0, 0, 6.2831853); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    id: 'spiral', name: 'Spiral Galaxy', family: 'radial', style: 'glow', density: 0.55, moteAlpha: 0.55, maxMote: 2.4,
    hue: 212, bg: [5, 7, 16], colors: [[150, 180, 230], [230, 205, 150], [180, 140, 210]],
    cam: { speedMul: 0.32, trailFade: 0.18, turnGain: 0.14, focalMul: 1.02, pyOff: -0.04, swayX: 0.03, swayY: 0.02, rollSpin: 0.004 },
    place(p) {
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      const arm = Math.floor(Math.random() * 2);
      const rr = 0.10 + 0.90 * Math.pow(Math.random(), 0.65);
      let theta = (arm / 2) * Math.PI * 2 + 3.4 * rr;
      theta += (Math.random() - 0.5) * (0.10 + 0.22 * rr);
      p.rr = rr;
      p.x = Math.cos(theta) * rr * rW;
      p.y = Math.sin(theta) * rr * 0.42 * rH;
      // Fine star points (capped by maxMote) — the bright bulge is the core glow,
      // not giant overlapping blobs.
      p.baseSz = 0.10 + 0.16 * (1.0 - rr) + Math.random() * 0.07;
    },
    render(ctx, cx, cy, F, a, t, speed, hue) {
      const R = Math.min(this.W, this.H); const h = hue; const bass = a.bass || 0;
      ctx.globalCompositeOperation = 'lighter';
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(this.cam ? this.cam.spin : 0); ctx.scale(1, 0.42);
      const diskR = R * 0.55; const hazeA = 0.05 + 0.05 * bass + 0.05 * this.kick;
      const gd = ctx.createRadialGradient(0, 0, R * 0.05, 0, 0, diskR);
      gd.addColorStop(0, 'hsla(' + (h + 12) + ',55%,42%,' + hazeA + ')'); gd.addColorStop(0.6, 'hsla(' + (h + 30) + ',55%,30%,' + (hazeA * 0.5) + ')'); gd.addColorStop(1, 'hsla(' + (h + 45) + ',55%,20%,0)');
      ctx.fillStyle = gd; ctx.beginPath(); ctx.arc(0, 0, diskR, 0, 6.2832); ctx.fill(); ctx.restore();
      let core = 0.50 + 0.30 * bass + 0.16 * this.kick; if (core > 1) core = 1;
      const coreR = R * (0.15 + 0.045 * bass + 0.03 * this.kick);
      const gc = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      gc.addColorStop(0, 'hsla(' + (h + 30) + ',45%,' + (78 * core) + '%,' + (0.55 * core) + ')'); gc.addColorStop(0.35, 'hsla(' + (h + 15) + ',60%,' + (55 * core) + '%,' + (0.26 * core) + ')'); gc.addColorStop(1, 'hsla(' + h + ',65%,35%,0)');
      ctx.fillStyle = gc; ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    },
  },

  // ---- MANDALA --------------------------------------------------------------
  {
    id: 'kaleidoscope', name: 'Kaleidoscope', family: 'mandala', style: 'shard',
    hue: 290, bg: [8, 4, 16], colors: [[255, 64, 200], [64, 230, 255], [255, 210, 90]],
    cam: { speedMul: 0.6, trailFade: 0.14, turnGain: 0.0, focalMul: 1.0, pyOff: 0, swayX: 0, swayY: 0, rollSpin: 0.005 },
    place(p) {
      const N = (this.kaleoN | 0) || 6; const nRings = 5; const slots = 3;
      const ring = Math.floor(Math.random() * nRings); const slot = Math.floor(Math.random() * slots);
      const side = Math.random() < 0.5 ? -1 : 1; const sector = Math.floor(Math.random() * N);
      const wedge = Math.PI / N; const a0 = (slot + 0.5) / slots * wedge;
      const ang = sector * (2 * Math.PI / N) + side * a0;
      let radial = 0.12 + (ring + 1) / (nRings + 1) * 0.9; if (slot === 1) radial += 0.04;
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      p.x = radial * Math.cos(ang) * rW; p.y = radial * Math.sin(ang) * rH;
      p.baseSz = 0.08 + (1 - radial) * 0.10 + (slot === 1 ? 0.03 : 0);
    },
    render(ctx, cx, cy, F, a, t, speed, hue) {
      if (this.kaleoN == null) this.kaleoN = 6;
      if (this.beatThisFrame && (this.kick || 0) > 0.6 && a.energy > 0.55) { const opts = [5, 6, 8, 10, 12]; this.kaleoN = opts[(Math.random() * opts.length) | 0]; }
      const N = (this.kaleoN | 0) || 6; const R = Math.min(cx, cy);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(this.cam.spin); ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = 1;
      for (let i = 0; i < N; i++) { const sa = i * (2 * Math.PI / N); const glow = 0.08 + a.mid * 0.22; ctx.strokeStyle = 'hsla(' + (((hue + i * 8) % 360 + 360) % 360) + ',90%,62%,' + glow.toFixed(3) + ')'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(sa) * R * 1.3, Math.sin(sa) * R * 1.3); ctx.stroke(); }
      const rings = 5;
      for (let r = 1; r <= rings; r++) { const rr = (r / rings) * R * 0.9 * (1 + a.bass * 0.08 * Math.sin(t * 0.05 + r)); const rg = 0.05 + (this.kick || 0) * 0.18 * (1 - r / rings); ctx.strokeStyle = 'hsla(' + (((hue + 40 + r * 12) % 360 + 360) % 360) + ',80%,66%,' + rg.toFixed(3) + ')'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    },
  },

  // ---- FLOW -----------------------------------------------------------------
  {
    id: 'aurora_ribbons', name: 'Aurora Ribbons', family: 'flow', style: 'glow',
    hue: 152, bg: [4, 9, 18], colors: [[80, 255, 170], [120, 200, 255], [200, 130, 255]],
    cam: { speedMul: 0.6, trailFade: 0.20, turnGain: 0.2, focalMul: 1.08, pyOff: 0.12, swayX: 0.03, swayY: 0, rollSpin: 0 },
    place(p) {
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      const NB = 5; const band = (Math.random() * NB) | 0; const u = Math.random() * 2 - 1;
      const amp = 0.15 + band * 0.012; const freq = 2.0 + band * 0.35; const phase = band * 1.3;
      const vBase = (band - (NB - 1) / 2) * 0.34;
      const v = vBase + amp * Math.sin(freq * u * Math.PI + phase) + (Math.random() - 0.5) * 0.05;
      p.x = u * rW; p.y = v * rH; p.sprite = band % 3; p.baseSz = 0.07 + Math.random() * 0.07;
    },
    render(ctx, cx, cy, F, a, t, speed, hue) {
      const W = this.W; const H = this.H; const NB = 5; const drift = t * 0.006;
      const sway = ((a.mid || 0) * 0.18 + (a.bass || 0) * 0.12);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let b = 0; b < NB; b++) {
        const cyB = cy + (b - (NB - 1) / 2) * H * 0.155;
        const amp = H * 0.05 * (1 + (a.energy || 0) * 0.9) + (a.bass || 0) * H * 0.045;
        const phase = b * 1.3 + drift; const bh = (hue + b * 24 + (a.centroid || 0) * 70) % 360;
        const aMain = 0.07 + 0.13 * (a.energy || 0) + this.kick * 0.10;
        const g = ctx.createLinearGradient(0, cyB - amp * 2.2, 0, cyB + amp * 2.2);
        g.addColorStop(0.0, 'hsla(' + bh + ',92%,62%,0)'); g.addColorStop(0.5, 'hsla(' + bh + ',92%,66%,' + aMain.toFixed(3) + ')'); g.addColorStop(1.0, 'hsla(' + ((bh + 45) % 360) + ',92%,55%,0)');
        ctx.fillStyle = g; ctx.beginPath();
        const Nn = 24; const swayY = sway * Math.sin(drift + b) * H * 0.05;
        for (let i = 0; i <= Nn; i++) { const u = (i / Nn) * 2 - 1; const x = (i / Nn) * W; const yE = cyB - amp + Math.sin(u * Math.PI * 2.2 + phase) * amp * 0.95 + Math.sin(u * 5 + drift * 1.7) * amp * 0.28 + swayY; if (i === 0) ctx.moveTo(x, yE); else ctx.lineTo(x, yE); }
        for (let i = Nn; i >= 0; i--) { const u = (i / Nn) * 2 - 1; const x = (i / Nn) * W; const yE = cyB + amp + Math.sin(u * Math.PI * 2.2 + phase) * amp * 0.95 + swayY; ctx.lineTo(x, yE); }
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    id: 'plasma', name: 'Plasma Flow', family: 'flow', style: 'glow',
    hue: 24, bg: [14, 7, 4], colors: [[255, 140, 40], [255, 88, 32], [232, 184, 78]],
    cam: { speedMul: 0.3, trailFade: 0.30, turnGain: 0.5, focalMul: 1.1, pyOff: 0, swayX: 0.03, swayY: 0.03, rollSpin: 0 },
    place(p) {
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      const nb = 6; const b = (Math.random() * nb) | 0;
      const la = (b / nb) * 6.2832 + (Math.random() - 0.5) * 0.7; const lr = 0.30 + 0.48 * Math.random();
      const g1 = (Math.random() + Math.random() + Math.random() - 1.5) * 0.36; const g2 = (Math.random() + Math.random() + Math.random() - 1.5) * 0.36;
      p.x = (Math.cos(la) * lr + g1) * rW; p.y = (Math.sin(la) * lr * 1.28 + g2) * rH;
      p.baseSz = 0.26 + Math.random() * 0.34;
    },
    render(ctx, cx, cy, F, a, t, speed, hue) {
      ctx.globalCompositeOperation = 'lighter';
      const n = 6; const bass = a.bass || 0; const energy = a.energy || 0;
      for (let i = 0; i < n; i++) {
        const ph = i * 1.7 + t * 0.006 * (1 + (i % 2) * 0.4);
        const bx = cx + Math.sin(ph * 0.7 + i) * (F * 0.50) * (0.5 + 0.4 * Math.sin(t * 0.003 + i));
        const by = cy + Math.cos(ph * 0.5 + i * 1.3) * (F * 0.42) - Math.sin(t * 0.004 + i) * F * 0.10;
        const rad = (F * 0.30) * (0.7 + 0.5 * Math.sin(t * 0.010 + i * 2)) * (1 + bass * 0.55);
        const h = ((hue + i * 14 + energy * 28) % 360 + 360) % 360;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
        g.addColorStop(0, 'hsla(' + h + ',92%,60%,' + (0.10 + bass * 0.11) + ')'); g.addColorStop(0.5, 'hsla(' + ((h + 22) % 360) + ',96%,50%,' + (0.05 + bass * 0.05) + ')'); g.addColorStop(1, 'hsla(' + h + ',90%,44%,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, rad, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },

  // ---- NATURE ---------------------------------------------------------------
  {
    id: 'forest', name: 'Forest', family: 'nature', style: 'glow', density: 0.5, over: true,
    hue: 110, bg: [6, 14, 10], colors: [[255, 196, 92], [120, 210, 120], [200, 235, 150]],
    cam: { speedMul: 0.72, trailFade: 0.16, turnGain: 0.1, focalMul: 1.0, pyOff: -0.03, swayX: 0.04, swayY: 0.025, rollSpin: 0 },
    place(p) {
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      let u = Math.random() * 2 - 1; const v = Math.random() * 2 - 1;
      u = u * (0.55 + 0.5 * Math.abs(u));
      p.x = u * rW * 1.12; p.y = v * rH * 1.05;
      p.baseSz = Math.random() < 0.6 ? (1.2 + Math.random() * 1.5) : (Math.random() < 0.6 ? (0.7 + Math.random() * 0.9) : (1.7 + Math.random() * 1.4));
    },
    render(ctx, cx, cy, F, a, t) {
      const W = this.W; const H = this.H; const k = this.kick || 0;
      const fr = (x) => x - Math.floor(x);
      const cg = ctx.createLinearGradient(0, 0, 0, H * 0.55);
      cg.addColorStop(0, 'rgba(26,70,40,' + (0.50 + k * 0.16).toFixed(3) + ')'); cg.addColorStop(1, 'rgba(10,26,16,0)');
      ctx.fillStyle = cg; ctx.fillRect(0, 0, W, H * 0.55);
      const fg = ctx.createLinearGradient(0, H, 0, H * 0.62);
      fg.addColorStop(0, 'rgba(8,20,12,0.55)'); fg.addColorStop(1, 'rgba(8,20,12,0)');
      ctx.fillStyle = fg; ctx.fillRect(0, H * 0.62, W, H * 0.38);
      ctx.globalCompositeOperation = 'lighter';
      const sh = 0.035 + k * 0.15 + (a ? a.treble * 0.025 : 0);
      for (let r = 0; r < 3; r++) {
        const sx = cx + (r - 1) * W * 0.24 + Math.sin(t * 0.07 + r) * W * 0.03;
        const rg = ctx.createLinearGradient(sx, 0, sx - W * 0.10, H);
        rg.addColorStop(0, 'rgba(190,230,150,' + sh.toFixed(3) + ')'); rg.addColorStop(1, 'rgba(120,180,90,0)');
        ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(sx - W * 0.05, 0); ctx.lineTo(sx + W * 0.05, 0); ctx.lineTo(sx - W * 0.12, H); ctx.lineTo(sx - W * 0.22, H); ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      const NT = 12;
      for (let i = 0; i < NT; i++) {
        const sd = fr(Math.sin(i * 12.9898) * 43758.5453); const side = sd < 0.5 ? -1 : 1;
        const lane = 0.30 + fr(sd * 7.3) * 0.55; const sp = 0.5 + sd * 0.8;
        const zz = 0.05 + (1.0 - fr(t * 0.05 * sp + i / NT + sd)) * 0.95; const grow = 0.42 / zz;
        const tx = cx + side * W * (0.16 + lane * 0.5) * grow; const tw = Math.max(3, W * 0.045 * grow);
        const a1 = Math.min(1, (1 - zz) * 1.8) * Math.min(1, zz * 6);
        if (tx < -tw || tx > W + tw || a1 <= 0.01) continue;
        const tg = ctx.createLinearGradient(tx - tw, 0, tx + tw, 0);
        tg.addColorStop(0, 'rgba(4,12,8,0)'); tg.addColorStop(0.5, 'rgba(7,20,13,' + (0.92 * a1).toFixed(3) + ')'); tg.addColorStop(1, 'rgba(3,9,6,0)');
        ctx.fillStyle = tg; ctx.fillRect(tx - tw, 0, tw * 2, H);
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(90,150,80,' + ((0.05 + k * 0.05) * a1).toFixed(3) + ')';
        ctx.fillRect(tx - (side > 0 ? tw : tw * 0.6), 0, tw * 0.5, H);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalCompositeOperation = 'lighter';
      const NF = 16;
      for (let f = 0; f < NF; f++) {
        const fa = fr(Math.sin(f * 78.233) * 12543.13); const fb = fr(fa * 91.7);
        const fx = cx + (fa - 0.5) * W * 0.62 + Math.sin(t * (0.18 + fa * 0.3) + fa * 6.283) * W * (0.16 + fa * 0.26);
        const fy = H * (0.30 + fb * 0.55) + Math.cos(t * (0.22 + fb * 0.25) + fb * 6.283) * H * 0.06;
        const tw = 0.55 + 0.45 * Math.sin(t * (0.06 + fa * 0.10) + fb * 6.283);
        const br = (0.35 + tw * 0.45) * (1 + k * 0.9); const rad = (2.0 + fa * 3.0) * (1 + k * 0.7);
        const gg = ctx.createRadialGradient(fx, fy, 0, fx, fy, rad * 4);
        gg.addColorStop(0, 'rgba(255,210,120,' + (0.50 * br).toFixed(3) + ')'); gg.addColorStop(0.4, 'rgba(255,170,70,' + (0.22 * br).toFixed(3) + ')'); gg.addColorStop(1, 'rgba(255,150,50,0)');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(fx, fy, rad * 4, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,200,' + (0.55 * br).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(fx, fy, rad * 0.5, 0, 6.283); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    id: 'rainy', name: 'Rainy Night', family: 'nature', style: 'line', density: 0.32, moteAlpha: 0.6, over: true,
    hue: 200, bg: [8, 14, 20], colors: [[150, 180, 200], [120, 160, 190], [90, 130, 155]],
    cam: { speedMul: 0.7, trailFade: 0.30, turnGain: 0.05, focalMul: 1.0, pyOff: 0.06, swayX: 0.025, swayY: 0.015, rollSpin: 0 },
    place(p) {
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      const u = (Math.random() * 2 - 1); const v = (Math.random() * 2 - 1);
      p.x = u * rW + v * rW * 0.14; p.y = v * rH; p.baseSz = 0.55 + Math.random() * 1.05;
    },
    render(ctx, cx, cy, F, a, t, speed) {
      const W = this.W; const H = this.H;
      if (!this._rd) this._rd = { flash: 0, rip: [] };
      const S = this._rd;
      if (this.beatThisFrame && this.kick > 0.55) { S.flash = Math.max(S.flash, Math.min(0.85, this.kick)); S.rip.push({ x: cx + (Math.random() * 2 - 1) * W * 0.28, y: cy + H * 0.16, r: 0, life: 1 }); }
      S.flash *= 0.90;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 22; i++) {
        const s = i * 127.1;
        const bx = (Math.sin(s) * 0.5 + 0.5) * W + Math.sin(t * 0.18 + i) * 6;
        const by = (Math.sin(s * 1.7 + 1.3) * 0.5 + 0.5) * 0.60 * H + 0.10 * H;
        const br = 20 + (Math.sin(s * 2.3) * 0.5 + 0.5) * 42; const hh = 188 + (Math.sin(s * 3.1) * 0.5 + 0.5) * 44;
        const pul = 0.09 + 0.05 * Math.sin(t * 0.6 + i * 1.3) + this.kick * 0.05 + S.flash * 0.25;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, 'hsla(' + hh + ',60%,72%,' + pul + ')'); g.addColorStop(1, 'hsla(' + hh + ',60%,50%,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.283); ctx.fill();
      }
      const rain = 45 + Math.floor(a.energy * 75); const wind = 0.20 + a.mid * 0.20 + Math.sin(t * 0.3) * 0.04;
      const fall = H * (0.55 + speed * 0.5 + a.energy * 0.55);
      ctx.lineCap = 'round';
      for (let k = 0; k < rain; k++) {
        let r1 = Math.sin(k * 12.9898) * 43758.5; r1 -= Math.floor(r1);
        let r2 = Math.sin(k * 78.233) * 43758.5; r2 -= Math.floor(r2);
        const len = 14 + r2 * 28; const sp = fall * (0.6 + r2 * 0.8); const py = ((t * sp + r2 * 1000) % (H + 60));
        const bx = r1 * 1.3 * W - 0.15 * W; const px = bx + py * wind + Math.sin(t * 0.2) * W * 0.02;
        const al = 0.09 + r2 * 0.11 + S.flash * 0.18;
        ctx.strokeStyle = 'hsla(200,40%,' + (70 + r2 * 16) + '%,' + al + ')'; ctx.lineWidth = 0.8 + r2 * 1.0;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - wind * len, py - len); ctx.stroke();
      }
      for (let j = S.rip.length - 1; j >= 0; j--) {
        const rp = S.rip[j]; rp.r += 4 + speed * 2; rp.life -= 0.02;
        if (rp.life <= 0) { S.rip.splice(j, 1); continue; }
        ctx.strokeStyle = 'hsla(195,55%,72%,' + (rp.life * 0.22) + ')'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(rp.x, rp.y, rp.r, rp.r * 0.34, 0, 0, 6.283); ctx.stroke();
      }
      if (S.flash > 0.01) { const lg = ctx.createLinearGradient(0, 0, 0, H); lg.addColorStop(0, 'hsla(210,40%,82%,' + (S.flash * 0.11) + ')'); lg.addColorStop(1, 'hsla(210,40%,60%,0)'); ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H); }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    id: 'sunset', name: 'Sunset', family: 'nature', style: 'glow', density: 0.25, over: true,
    hue: 34, bg: [40, 22, 56], colors: [[255, 214, 146], [255, 168, 112], [255, 126, 138]],
    cam: { speedMul: 0.45, trailFade: 0.18, turnGain: 0.1, focalMul: 1.0, pyOff: 0.06, swayX: 0.03, swayY: 0.02, rollSpin: 0 },
    place(p) {
      const rW = (this.W * 0.5) * (p.z / this.focalBase); const rH = (this.H * 0.5) * (p.z / this.focalBase);
      const u = (Math.random() * 2 - 1); let v = (Math.random() * 2 - 1); v = v * 0.78 + 0.06;
      p.x = u * rW; p.y = v * rH; p.baseSz = 0.8 + Math.random() * 1.8;
    },
    render(ctx, cx, cy, F, a, t) {
      const W = this.W; const H = this.H; const kick = this.kick || 0;
      const horizon = cy + H * 0.16; const sunR = Math.min(W, H) * 0.155; const sunY = horizon - H * 0.05; const bloom = 1 + kick * 0.10;
      const sky = ctx.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, 'rgb(44,24,66)'); sky.addColorStop(0.45, 'rgb(142,62,80)'); sky.addColorStop(0.8, 'rgb(198,112,66)'); sky.addColorStop(1, 'rgb(224,156,96)');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, horizon);
      const wat = ctx.createLinearGradient(0, horizon, 0, H);
      wat.addColorStop(0, 'rgb(184,128,86)'); wat.addColorStop(0.5, 'rgb(128,64,82)'); wat.addColorStop(1, 'rgb(48,28,62)');
      ctx.fillStyle = wat; ctx.fillRect(0, horizon, W, H - horizon);
      const rim = 0.4 + kick * 0.15;
      const cl = [[0.30, 0.00, 1.0], [0.62, 0.05, 0.8], [0.14, 0.10, 0.7], [0.82, 0.13, 0.9], [0.48, 0.17, 0.6]];
      for (let c = 0; c < cl.length; c++) {
        const cc = cl[c]; const ly = cc[2];
        const bx = ((cc[0] * W + t * (0.05 + ly * 0.09) + c * 210) % (W + 300)) - 150; const by = horizon - H * (0.12 + cc[1] * 1.0);
        const cw = W * (0.17 + 0.10 * ly); const ch = cw * 0.34;
        ctx.globalCompositeOperation = 'source-over';
        ctx.save(); ctx.translate(bx, by); ctx.scale(1, 0.4);
        const gb = ctx.createRadialGradient(0, 0, 0, 0, 0, cw);
        gb.addColorStop(0, 'rgba(116,58,82,' + (0.42 * ly) + ')'); gb.addColorStop(0.6, 'rgba(86,44,70,' + (0.22 * ly) + ')'); gb.addColorStop(1, 'rgba(58,30,60,0)');
        ctx.fillStyle = gb; ctx.beginPath(); ctx.arc(0, 0, cw, 0, 6.283); ctx.fill(); ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
        ctx.save(); ctx.translate(bx, by + ch * 0.4); ctx.scale(1, 0.34);
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, cw * 0.8);
        gr.addColorStop(0, 'rgba(255,200,132,' + (0.30 * ly * rim) + ')'); gr.addColorStop(1, 'rgba(255,180,120,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, cw * 0.8, 0, 6.283); ctx.fill(); ctx.restore();
      }
      // Soft additive corona (gentle bass swell, not a beat strobe)…
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(cx, sunY, sunR * 0.2, cx, sunY, sunR * 2.1 * bloom);
      g.addColorStop(0, 'rgba(255,210,140,' + (0.26 + kick * 0.05).toFixed(3) + ')'); g.addColorStop(0.4, 'rgba(255,150,92,0.15)'); g.addColorStop(1, 'rgba(255,120,80,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, sunY, sunR * 2.1 * bloom, 0, 6.283); ctx.fill();
      // …and a SOLID (non-additive) disc so the sun reads as a sun, not a white blowout.
      ctx.globalCompositeOperation = 'source-over';
      const d = ctx.createRadialGradient(cx, sunY, 0, cx, sunY, sunR * bloom);
      d.addColorStop(0, 'rgb(255,238,202)'); d.addColorStop(0.7, 'rgb(255,198,120)'); d.addColorStop(1, 'rgba(255,168,96,0.92)');
      ctx.fillStyle = d; ctx.beginPath(); ctx.arc(cx, sunY, sunR * bloom, 0, 6.283); ctx.fill();
      // Water shimmer — SLOW (t is a frame counter, so the old t*2.2 was a ~21 Hz strobe).
      ctx.globalCompositeOperation = 'lighter';
      const rows = 12;
      for (let i = 0; i < rows; i++) {
        const ry = horizon + (i / rows) * (H - horizon); const ph = t * 0.08 + i * 0.6;
        const wob = Math.sin(ph) * (4 + i * 1.1) * (1 + kick * 0.2); const w = sunR * (0.5 + i * 0.13);
        let al = (0.14 - i * 0.009) * (0.72 + 0.28 * Math.sin(ph * 0.7)); if (al < 0) al = 0;
        ctx.fillStyle = 'rgba(255,' + (202 - i * 4) + ',122,' + al.toFixed(3) + ')'; ctx.fillRect(cx - w * 0.5 + wob, ry, w, (H - horizon) / rows * 0.7);
      }
      const hl = ctx.createLinearGradient(0, horizon - 7, 0, horizon + 7);
      hl.addColorStop(0, 'rgba(255,200,120,0)'); hl.addColorStop(0.5, 'rgba(255,226,160,' + (0.24 + kick * 0.10).toFixed(3) + ')'); hl.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = hl; ctx.fillRect(0, horizon - 7 - kick * 1.5, W, 14 + kick * 3);
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(58,30,52,0.5)'; ctx.lineWidth = 1.5;
      for (let b = 0; b < 6; b++) {
        const bx2 = ((t * 0.5 + b * 150) % (W + 100)) - 50; const by2 = horizon - H * 0.2 - (b % 3) * 16 + Math.sin(t * 0.02 + b) * 6;
        const fl = Math.sin(t * 0.16 + b) * 4 * (1 + kick * 0.3);
        ctx.beginPath(); ctx.moveTo(bx2 - 7, by2 + 3); ctx.quadraticCurveTo(bx2 - 3, by2 - 2 - fl, bx2, by2 + 1); ctx.quadraticCurveTo(bx2 + 3, by2 - 2 - fl, bx2 + 7, by2 + 3); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
];

// Default journey order — alternates families so adjacent worlds always contrast.
const ARC = ['synthgrid', 'wormhole', 'aurora_ribbons', 'forest', 'spiral', 'lightcity', 'rainy', 'kaleidoscope', 'plasma', 'sunset'];

export function pickNextScene(currentId, history) {
  const cur = SCENES.find((s) => s.id === currentId);
  const banned = new Set(history);
  let cands = SCENES.filter((s) => s.id !== currentId && s.family !== cur.family && !banned.has(s.id));
  if (!cands.length) cands = SCENES.filter((s) => s.id !== currentId && s.family !== cur.family);
  if (!cands.length) cands = SCENES.filter((s) => s.id !== currentId);
  const arcNext = ARC[(ARC.indexOf(currentId) + 1) % ARC.length];
  const arcCand = cands.find((s) => s.id === arcNext);
  if (arcCand && Math.random() < 0.45) return arcCand;
  return cands[(Math.random() * cands.length) | 0];
}

export const FIRST_SCENE = 'synthgrid';
