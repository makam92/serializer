'use strict';

/**
 * RIDE acts — the environments the generative rollercoaster flies through.
 *
 * Unlike the standalone scenes, every act draws RELATIVE TO THE TRACK via the rig R:
 *   R.center(z)        -> [sx, sy, inv]  screen position of the track centerline at depth z
 *   R.project(wx,wy,z) -> [sx, sy, inv]  a world point offset (wx,wy) from the centerline
 * Both already fold in the path curvature (R.bendX/bendY) and the bank roll (R.roll), so
 * geometry sampled across depth automatically snakes and tilts with the ride.
 *
 * R also carries: ctx, W, H, cx, cy, F, t (frame counter), rideS (distance travelled),
 * speed, kick (smooth beat impulse), beat, beatConf, energy/bass/mid/treble, hue, colors,
 * znear/zfar/zfog0, alpha (act cross-fade), bendX, bendY.
 *
 * STROBE RULES (learned the hard way): t is a FRAME counter — any sin(t*K) on brightness
 * keeps K<=0.08; beat reactivity comes only from R.kick; no additive white blowout.
 */

// A glowing line that follows the track at a fixed world offset (side, vert) — it
// converges toward the vanishing point with depth, so it reads as a rail.
export function rail(R, side, vert, hue, baseA, lw) {
  const ctx = R.ctx;
  ctx.beginPath();
  let started = false;
  for (let z = R.znear + 0.15; z <= R.zfar; z *= 1.10) {
    const pr = R.project(side, vert, z);
    if (!started) { ctx.moveTo(pr[0], pr[1]); started = true; } else ctx.lineTo(pr[0], pr[1]);
  }
  ctx.strokeStyle = `hsla(${hue},95%,62%,${(baseA * R.alpha).toFixed(3)})`;
  ctx.lineWidth = lw || 2;
  ctx.stroke();
}

// Scrolling "gates" along the track (rings/rungs spaced by world arc-length).
function gates(R, cb) {
  const spacing = R.gateSpacing || 2.4;
  const off = ((R.rideS % spacing) + spacing) % spacing;
  for (let i = 0; i < 18; i++) {
    const z = R.znear + (i * spacing - off);
    if (z < R.znear + 0.2 || z > R.zfar) continue;
    const fade = Math.max(0, Math.min(1, (R.zfar - z) / (R.zfar - R.zfog0)));
    const near = 1 - Math.min(1, z / R.zfog0);
    cb(z, fade, near);
  }
}

export const RIDE_ACTS = [
  {
    id: 'tunnel', name: 'Neon Tunnel', hue: 300, bg: [8, 5, 18],
    colors: [[255, 90, 210], [120, 220, 255], [180, 140, 255]],
    draw(R) {
      const ctx = R.ctx; R.gateSpacing = 1.8;
      ctx.globalCompositeOperation = 'lighter';
      // a cylinder of longitudinal neon lines (the tube wall you fly through)
      const Rt = 0.42; const NL = 16;
      for (let i = 0; i < NL; i++) {
        const th = (i / NL) * 6.2832;
        rail(R, Math.cos(th) * Rt, Math.sin(th) * Rt, (R.hue + i * 6) % 360, 0.12, 1.1);
      }
      // bright glowing floor rails
      rail(R, -0.30, 0.40, R.hue, 0.5, 2.4);
      rail(R, 0.30, 0.40, R.hue, 0.5, 2.4);
      // gates rushing toward you — bright, with a hot leading edge
      const tubeR = 0.44;
      gates(R, (z, fade, near) => {
        const c = R.center(z); const inv = c[2];
        const a = (0.07 + 0.22 * fade) * R.alpha * (1 + R.kick * 0.6);
        ctx.strokeStyle = `hsla(${(R.hue + near * 40) % 360},95%,${(60 + near * 18).toFixed(0)}%,${a.toFixed(3)})`;
        ctx.lineWidth = 0.8 + 3.6 * near;
        ctx.beginPath(); ctx.ellipse(c[0], c[1], tubeR * inv, tubeR * inv * 0.92, R.roll, 0, 6.2832); ctx.stroke();
      });
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    id: 'terrain', name: 'Neon Country', hue: 30, bg: [10, 6, 16],
    colors: [[255, 170, 80], [255, 100, 150], [150, 230, 255]],
    draw(R) {
      const ctx = R.ctx; const W = R.W; const H = R.H; const A = R.alpha;
      const hy = Math.max(H * 0.22, Math.min(H * 0.74, R.horizonY)); const hx = R.horizonX;
      // ---- sky + sun + hills, banked around screen centre to match the ground ----
      ctx.save();
      ctx.translate(R.cx, R.cy); ctx.rotate(R.roll); ctx.translate(-R.cx, -R.cy);
      ctx.globalCompositeOperation = 'source-over';
      // warm sky (drawn FIRST so the sun sits in front of it)
      const sky = ctx.createLinearGradient(0, hy - H * 1.3, 0, hy);
      sky.addColorStop(0, `rgba(26,12,48,${A})`);
      sky.addColorStop(0.65, `rgba(120,44,84,${A})`);
      sky.addColorStop(1, `rgba(220,112,88,${A})`);
      ctx.fillStyle = sky; ctx.fillRect(-W, hy - H * 1.4, W * 3, H * 1.4);
      // iconic banded synth sun — drawn BEFORE the ground + hills so it sets behind them
      const sunR = Math.min(W, H) * 0.15; const sy = hy - sunR * 0.5;
      ctx.globalCompositeOperation = 'lighter';
      const corona = ctx.createRadialGradient(hx, sy, sunR * 0.3, hx, sy, sunR * 2.1);
      corona.addColorStop(0, `rgba(255,182,112,${(0.34 * A).toFixed(3)})`);
      corona.addColorStop(1, 'rgba(255,120,90,0)');
      ctx.fillStyle = corona; ctx.beginPath(); ctx.arc(hx, sy, sunR * 2.1, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.beginPath(); ctx.arc(hx, sy, sunR, 0, 6.2832); ctx.clip();
      const disc = ctx.createLinearGradient(hx, sy - sunR, hx, sy + sunR);
      disc.addColorStop(0, '#ffe487'); disc.addColorStop(0.5, '#ff9d5c'); disc.addColorStop(1, '#ff5f86');
      ctx.fillStyle = disc; ctx.fillRect(hx - sunR, sy - sunR, sunR * 2, sunR * 2);
      ctx.fillStyle = 'rgba(18,7,24,0.92)';
      for (let b = 0; b < 6; b++) { const by = sy + sunR * 0.08 + b * sunR * 0.16; ctx.fillRect(hx - sunR, by, sunR * 2, sunR * 0.06 * (0.6 + b)); }
      ctx.restore();
      // dark ground plane — AFTER the sun so it occludes everything below the horizon
      ctx.fillStyle = `rgba(7,4,12,${A})`; ctx.fillRect(-W, hy, W * 3, H * 2);
      // rolling hills — OPAQUE silhouettes so they clearly sit IN FRONT of the sun (they were
      // semi-transparent, so the bright sun bled through and they read as "behind"). Far ridge
      // first (lighter/taller, atmospheric), near ridge on top (darker) so it solidly occludes.
      for (let layer = 1; layer >= 0; layer--) {
        const amp = 30 + layer * 16;
        ctx.fillStyle = `rgba(${10 + layer * 14},${5 + layer * 9},${18 + layer * 18},${A.toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(-W, hy + 2);
        for (let x = -W; x <= W * 2; x += 34) {
          const y = hy - amp * (0.5 + 0.5 * Math.sin(x * 0.011 + R.rideS * 0.15 + layer * 2.3)) - 6 * Math.sin(x * 0.03 + layer);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W * 2, hy + 2); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // ---- neon grid floor (projected — already banked, so it aligns) ----
      ctx.globalCompositeOperation = 'lighter';
      const gh = (R.hue + 200) % 360;
      for (let lx = -6; lx <= 6; lx++) rail(R, lx * 0.10, 0.34, gh, 0.10 + 0.015 * (6 - Math.abs(lx)), 1.1);
      R.gateSpacing = 1.7;
      gates(R, (z, fade) => {
        const l = R.project(-0.66, 0.34, z); const r = R.project(0.66, 0.34, z);
        ctx.strokeStyle = `hsla(${gh},92%,62%,${((0.06 + 0.24 * fade) * A).toFixed(3)})`;
        ctx.lineWidth = 1 + fade * 0.7;
        ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(r[0], r[1]); ctx.stroke();
      });
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    // Atmospheric biome (audited misty-depth forest), adapted to the ride rig.
    id: 'forest', name: 'Forest', hue: 112, bg: [7, 18, 16],
    colors: [[255, 198, 104], [255, 162, 86], [196, 232, 150]],
    draw(R) {
      var ctx = R.ctx, cx = R.cx, cy = R.cy, t = R.t, speed = R.speed, a = R;
      var W = R.W, H = R.H;
      var k = R.kick || 0; if (k < 0) k = 0; if (k > 1) k = 1;
      ctx.save(); ctx.globalAlpha = R.alpha;
      var bass = a ? (a.bass || 0) : 0; if (bass < 0) bass = 0; if (bass > 1) bass = 1;
      var mid = a ? (a.mid || 0) : 0; if (mid < 0) mid = 0; if (mid > 1) mid = 1;
      var treble = a ? (a.treble || 0) : 0; if (treble < 0) treble = 0; if (treble > 1) treble = 1;
      var fr = function (x) { return x - Math.floor(x); };
      var hy = cy - H * 0.02;
      if (this._fpan === undefined) this._fpan = 0;
      this._fpan += 0.0007 + speed * 0.0012;
      if (this._fpan > 4096) this._fpan -= 4096;
      var pan = this._fpan;
      ctx.globalCompositeOperation = 'source-over';
      var bgGrad = ctx.createLinearGradient(0, 0, 0, H);
      bgGrad.addColorStop(0.00, 'rgb(7,18,16)');
      bgGrad.addColorStop(0.42, 'rgb(13,32,28)');
      bgGrad.addColorStop(0.62, 'rgb(19,44,40)');
      bgGrad.addColorStop(1.00, 'rgb(6,16,14)');
      ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      var glowR = Math.min(W, H) * 0.62;
      var glowA = 0.045 + mid * 0.03 + k * 0.025; if (glowA > 0.11) glowA = 0.11;
      var gyc = hy + H * 0.03;
      var dg = ctx.createRadialGradient(cx, gyc, 0, cx, gyc, glowR);
      dg.addColorStop(0, 'rgba(120,178,156,' + glowA.toFixed(3) + ')');
      dg.addColorStop(0.45, 'rgba(64,116,102,' + (glowA * 0.42).toFixed(3) + ')');
      dg.addColorStop(1, 'rgba(24,52,46,0)');
      ctx.fillStyle = dg; ctx.beginPath(); ctx.arc(cx, gyc, glowR, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      var cpH = H * 0.36;
      var cnp = ctx.createLinearGradient(0, 0, 0, cpH);
      cnp.addColorStop(0, 'rgba(4,12,10,0.66)');
      cnp.addColorStop(0.6, 'rgba(6,15,12,0.30)');
      cnp.addColorStop(1, 'rgba(6,15,12,0)');
      ctx.fillStyle = cnp; ctx.fillRect(0, 0, W, cpH);
      var NL = 5;
      for (var L = 0; L < NL; L++) {
        var df = L / (NL - 1);
        var C = 7 - L;
        var crc = Math.round(44 + (5 - 44) * df);
        var cgc = Math.round(72 + (11 - 72) * df);
        var cbc = Math.round(66 + (9 - 66) * df);
        var twHalf = W * (0.012 + df * 0.05);
        var thHalf = H * (0.12 + df * 0.56);
        var baseA = 0.20 + df * 0.64;
        var gap = W * (0.05 + df * 0.12);
        var driftMul = 0.4 + df * 1.9;
        var span = W * 1.26;
        var swayL = Math.sin(t * 0.04 + L * 1.7) * W * 0.011;
        var cyT = hy + thHalf * 0.22;
        for (var j = 0; j < C; j++) {
          var slot = (j + 0.5) / C;
          var ph = fr(slot + pan * driftMul);
          var x = ph * span - W * 0.13 + swayL;
          var distEdge = Math.min(x + W * 0.13, (W * 1.13) - x);
          var ef = distEdge / (W * 0.18); if (ef > 1) ef = 1; if (ef < 0) ef = 0;
          var dxc = Math.abs(x - cx);
          var cgap = (dxc - gap) / (W * 0.12); if (cgap > 1) cgap = 1; if (cgap < 0) cgap = 0;
          var aTrunk = baseA * ef * cgap;
          if (aTrunk < 0.004) continue;
          ctx.save();
          ctx.translate(x, cyT);
          ctx.scale(twHalf, thHalf);
          var rg = ctx.createRadialGradient(0, -0.15, 0, 0, 0, 1);
          rg.addColorStop(0, 'rgba(' + crc + ',' + cgc + ',' + cbc + ',' + aTrunk.toFixed(3) + ')');
          rg.addColorStop(0.55, 'rgba(' + crc + ',' + cgc + ',' + cbc + ',' + (aTrunk * 0.62).toFixed(3) + ')');
          rg.addColorStop(1, 'rgba(' + crc + ',' + cgc + ',' + cbc + ',0)');
          ctx.fillStyle = rg;
          ctx.beginPath(); ctx.arc(0, 0, 1, 0, 6.2832); ctx.fill();
          ctx.restore();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      var mh = H * 0.44;
      var mg2 = ctx.createLinearGradient(0, H, 0, H - mh);
      mg2.addColorStop(0, 'rgba(24,50,45,0.66)');
      mg2.addColorStop(0.5, 'rgba(20,44,40,0.30)');
      mg2.addColorStop(1, 'rgba(18,40,36,0)');
      ctx.fillStyle = mg2; ctx.fillRect(0, H - mh, W, mh);
      ctx.globalCompositeOperation = 'lighter';
      var mistA = 0.04 + bass * 0.025 + k * 0.015; if (mistA > 0.085) mistA = 0.085;
      var my = H * 0.8 + Math.sin(t * 0.03) * H * 0.012;
      var mr = ctx.createLinearGradient(0, my - H * 0.14, 0, my + H * 0.14);
      mr.addColorStop(0, 'rgba(92,152,136,0)');
      mr.addColorStop(0.5, 'rgba(92,152,136,' + mistA.toFixed(3) + ')');
      mr.addColorStop(1, 'rgba(92,152,136,0)');
      ctx.fillStyle = mr; ctx.fillRect(0, my - H * 0.14, W, H * 0.28);
      ctx.globalCompositeOperation = 'lighter';
      var nray = 3;
      for (var r = 0; r < nray; r++) {
        var rx = cx + (r - 1) * W * 0.27 + Math.sin(t * 0.02 + r * 1.7) * W * 0.04;
        var rw = W * 0.085;
        var slant = W * 0.17;
        var breath = 0.5 + 0.5 * Math.sin(t * 0.05 + r);
        var ra = 0.034 + 0.018 * breath + k * 0.02 + treble * 0.012; if (ra > 0.09) ra = 0.09;
        var rgr = ctx.createLinearGradient(rx, 0, rx - slant, H);
        rgr.addColorStop(0, 'rgba(208,234,170,' + ra.toFixed(3) + ')');
        rgr.addColorStop(0.5, 'rgba(178,216,152,' + (ra * 0.5).toFixed(3) + ')');
        rgr.addColorStop(1, 'rgba(150,200,134,0)');
        ctx.fillStyle = rgr;
        ctx.beginPath();
        ctx.moveTo(rx - rw, 0); ctx.lineTo(rx + rw, 0); ctx.lineTo(rx + rw - slant, H); ctx.lineTo(rx - rw - slant, H);
        ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation = 'lighter';
      var NF = 12;
      for (var fi = 0; fi < NF; fi++) {
        var s1 = fr(Math.sin(fi * 12.9898) * 43758.5453);
        var s2 = fr(Math.sin(fi * 78.233) * 12543.13);
        var fx = cx + (s1 - 0.5) * W * 0.9 + Math.sin(t * (0.09 + s1 * 0.05) + s1 * 6.283) * W * (0.05 + s1 * 0.05);
        var fy = H * (0.34 + s2 * 0.5) + Math.cos(t * (0.07 + s2 * 0.04) + s2 * 6.283) * H * 0.035;
        var tw = 0.5 + 0.5 * Math.sin(t * 0.06 + s1 * 6.283);
        var fa = 0.06 + 0.07 * tw + k * 0.03; if (fa > 0.16) fa = 0.16;
        var frad = 2.2 + s2 * 3.0;
        var gg = ctx.createRadialGradient(fx, fy, 0, fx, fy, frad * 3.2);
        gg.addColorStop(0, 'rgba(255,208,124,' + fa.toFixed(3) + ')');
        gg.addColorStop(0.4, 'rgba(255,174,88,' + (fa * 0.4).toFixed(3) + ')');
        gg.addColorStop(1, 'rgba(255,160,70,0)');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(fx, fy, frad * 3.2, 0, 6.2832); ctx.fill();
        ctx.fillStyle = 'rgba(255,242,210,' + (fa * 0.6).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(fx, fy, frad * 0.5, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      var vg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.30, cx, cy, Math.max(W, H) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    },
  },
  {
    id: 'city', name: 'Neon Canyon', hue: 284, bg: [6, 6, 16],
    colors: [[255, 80, 200], [90, 210, 255], [200, 150, 255]],
    draw(R) {
      const ctx = R.ctx; R.gateSpacing = 2.7;
      // glowing street rails first
      ctx.globalCompositeOperation = 'lighter';
      rail(R, -0.16, 0.34, R.hue, 0.34, 1.8);
      rail(R, 0.16, 0.34, R.hue, 0.34, 1.8);
      gates(R, (z, fade) => {
        for (let s = -1; s <= 1; s += 2) {
          const dist = 0.32; const baseW = 0.13;
          const b0 = R.project(s * dist, 0.5, z);
          const t0 = R.project(s * dist, -0.78, z);
          const b1 = R.project(s * (dist + baseW), 0.5, z);
          const w = Math.abs(b1[0] - b0[0]) * 1.7 + 2;
          const hh = b0[1] - t0[1];
          if (hh <= 1) continue;
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = `rgba(9,8,20,${(0.85 * fade * R.alpha).toFixed(3)})`;
          ctx.fillRect(b0[0] - w * 0.5, t0[1], w, hh);
          // window lights (slow twinkle — t*0.05 is < 1 Hz, no strobe)
          ctx.globalCompositeOperation = 'lighter';
          const rows = 6; const colN = 2;
          for (let wr = 0; wr < rows; wr++) for (let wc = 0; wc < colN; wc++) {
            const tw = 0.5 + 0.5 * Math.sin(R.t * 0.05 + z * 1.3 + wr * 0.9 + s * 2.1 + wc);
            const br = (0.10 + 0.42 * tw) * fade;
            const wx = b0[0] - w * 0.5 + w * ((wc + 0.5) / colN);
            const wy = t0[1] + hh * ((wr + 0.5) / rows);
            ctx.fillStyle = `hsla(${(R.hue + (tw > 0.6 ? 22 : -12) + 360) % 360},95%,66%,${(br * R.alpha).toFixed(3)})`;
            ctx.fillRect(wx - w * 0.13, wy - 2.5, w * 0.26, 3.5);
          }
        }
      });
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    // Atmospheric biome (audited neon-noir rainy street), adapted to the ride rig.
    id: 'rainy', name: 'Rainy Night', hue: 205, bg: [7, 13, 20],
    colors: [[160, 190, 205], [120, 155, 185], [185, 205, 215]],
    draw(R) {
      var ctx = R.ctx, cx = R.cx, cy = R.cy, t = R.t, speed = R.speed, a = R;
      var W = R.W, H = R.H;
      var k = R.kick || 0;
      ctx.save(); ctx.globalAlpha = R.alpha;
      var bass = a.bass || 0, mid = a.mid || 0, en = a.energy || 0;
      var horizon = cy + H * 0.05;
      if (!this._rn) this._rn = { flash: 0 };
      var S = this._rn;
      if (R.beat && k > 0.6) { var f = k * 0.25; if (f > 0.25) f = 0.25; if (f > S.flash) S.flash = f; }
      S.flash *= 0.9;
      ctx.globalCompositeOperation = 'source-over';
      var sky = ctx.createLinearGradient(0, 0, 0, horizon);
      sky.addColorStop(0, 'rgb(6,11,19)'); sky.addColorStop(0.55, 'rgb(9,18,28)'); sky.addColorStop(1, 'rgb(15,30,40)');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, horizon);
      var glowR = W * 0.46;
      var vg2 = ctx.createRadialGradient(cx, horizon, 0, cx, horizon, glowR);
      vg2.addColorStop(0, 'rgba(46,82,92,' + (0.15 + bass * 0.05).toFixed(3) + ')');
      vg2.addColorStop(0.5, 'rgba(30,54,66,0.06)'); vg2.addColorStop(1, 'rgba(18,34,44,0)');
      ctx.fillStyle = vg2; ctx.beginPath(); ctx.arc(cx, horizon, glowR, 0, 6.283); ctx.fill();
      var skg = ctx.createLinearGradient(0, horizon - H * 0.10, 0, horizon);
      skg.addColorStop(0, 'rgba(34,64,76,0)'); skg.addColorStop(1, 'rgba(40,74,86,' + (0.09 + bass * 0.03).toFixed(3) + ')');
      ctx.fillStyle = skg; ctx.fillRect(0, horizon - H * 0.10, W, H * 0.10);
      var street = ctx.createLinearGradient(0, horizon, 0, H);
      street.addColorStop(0, 'rgb(13,24,30)'); street.addColorStop(0.5, 'rgb(8,15,21)'); street.addColorStop(1, 'rgb(11,19,25)');
      ctx.fillStyle = street; ctx.fillRect(0, horizon, W, H - horizon);
      var scr = (t * (0.004 + speed * 0.016)) % 1;
      for (var ri = 0; ri < 8; ri++) {
        var dd = (ri + scr) / 8; var pe = dd * dd;
        var ry = horizon + (H - horizon) * pe;
        var rfade = Math.min(1, dd * 6) * Math.min(1, (1 - dd) * 6);
        var ra0 = (0.025 + 0.05 * pe) * rfade;
        if (ra0 <= 0.002) continue;
        ctx.strokeStyle = 'rgba(58,108,120,' + ra0.toFixed(3) + ')';
        ctx.lineWidth = 0.5 + pe * 1.1;
        ctx.beginPath(); ctx.moveTo(0, ry); ctx.lineTo(W, ry); ctx.stroke();
      }
      var lanes = [-0.92, -0.46, 0.0, 0.46, 0.92];
      for (var lj = 0; lj < lanes.length; lj++) {
        var lx = cx + lanes[lj] * W * 0.9;
        ctx.strokeStyle = 'rgba(72,124,134,' + (lj === 2 ? 0.10 : 0.05) + ')';
        ctx.lineWidth = lj === 2 ? 1.3 : 1.0;
        ctx.beginPath(); ctx.moveTo(cx, horizon); ctx.lineTo(lx, H); ctx.stroke();
      }
      var orbs = [
        [-0.74, 0.30, 0.95, 186, 70, 0.0], [-0.40, 0.15, 0.60, 190, 64, 1.7], [-0.16, 0.46, 0.70, 330, 76, 3.1],
        [0.13, 0.22, 0.55, 184, 66, 4.6], [0.46, 0.36, 0.90, 38, 88, 2.2], [0.76, 0.18, 0.66, 188, 64, 5.3], [0.05, 0.57, 0.46, 192, 58, 0.9],
      ];
      var baseR = Math.min(W, H) * 0.07;
      for (var oi = 0; oi < orbs.length; oi++) {
        var o = orbs[oi]; var ox = cx + o[0] * W * 0.5;
        var tw = 0.62 + 0.38 * Math.sin(t * 0.05 + o[5]);
        var orad = baseR * o[2] * (1 + k * 0.12 + bass * 0.05);
        var rx = ox + Math.sin(t * 0.06 + o[5]) * W * 0.008;
        var rBot = horizon + (H - horizon) * (0.40 + o[2] * 0.40);
        var rw = orad * 0.55; var ra = 0.08 + 0.045 * tw;
        var rgw = ctx.createLinearGradient(rx, horizon, rx, rBot);
        rgw.addColorStop(0, 'hsla(' + o[3] + ',' + o[4] + '%,58%,' + (ra * 0.5).toFixed(3) + ')');
        rgw.addColorStop(0.5, 'hsla(' + o[3] + ',' + o[4] + '%,52%,' + (ra * 0.22).toFixed(3) + ')');
        rgw.addColorStop(1, 'hsla(' + o[3] + ',' + o[4] + '%,48%,0)');
        ctx.fillStyle = rgw; ctx.fillRect(rx - rw, horizon, rw * 2, rBot - horizon);
        var rgc = ctx.createLinearGradient(rx, horizon, rx, rBot);
        rgc.addColorStop(0, 'hsla(' + o[3] + ',' + o[4] + '%,62%,' + ra.toFixed(3) + ')');
        rgc.addColorStop(0.5, 'hsla(' + o[3] + ',' + o[4] + '%,55%,' + (ra * 0.35).toFixed(3) + ')');
        rgc.addColorStop(1, 'hsla(' + o[3] + ',' + o[4] + '%,50%,0)');
        ctx.fillStyle = rgc; ctx.fillRect(rx - rw * 0.4, horizon, rw * 0.8, rBot - horizon);
      }
      var mistA = 0.07 + 0.03 * Math.sin(t * 0.03);
      var mistY = horizon - H * 0.02;
      var mg = ctx.createLinearGradient(0, mistY, 0, mistY + H * 0.18);
      mg.addColorStop(0, 'rgba(120,150,162,0)'); mg.addColorStop(0.45, 'rgba(120,150,162,' + mistA.toFixed(3) + ')'); mg.addColorStop(1, 'rgba(120,150,162,0)');
      ctx.fillStyle = mg; ctx.fillRect(0, mistY, W, H * 0.18);
      for (var oj = 0; oj < orbs.length; oj++) {
        var ob = orbs[oj]; var bx2 = cx + ob[0] * W * 0.5; var by2 = horizon - ob[1] * H * 0.52;
        var tw2 = 0.62 + 0.38 * Math.sin(t * 0.05 + ob[5]);
        var orad2 = baseR * ob[2] * (1 + k * 0.12 + bass * 0.05);
        var ba = (0.14 + 0.055 * tw2) + k * 0.075 * tw2;
        var gb = ctx.createRadialGradient(bx2, by2, 0, bx2, by2, orad2);
        gb.addColorStop(0, 'hsla(' + ob[3] + ',' + ob[4] + '%,70%,' + Math.min(0.44, ba * 1.5).toFixed(3) + ')');
        gb.addColorStop(0.4, 'hsla(' + ob[3] + ',' + ob[4] + '%,58%,' + (ba * 0.5).toFixed(3) + ')');
        gb.addColorStop(1, 'hsla(' + ob[3] + ',' + ob[4] + '%,50%,0)');
        ctx.fillStyle = gb; ctx.beginPath(); ctx.arc(bx2, by2, orad2, 0, 6.283); ctx.fill();
      }
      ctx.globalCompositeOperation = 'lighter';
      for (var ok2 = 0; ok2 < orbs.length; ok2++) {
        var oc = orbs[ok2]; var cxo = cx + oc[0] * W * 0.5; var cyo = horizon - oc[1] * H * 0.52;
        var tw3 = 0.62 + 0.38 * Math.sin(t * 0.05 + oc[5]);
        var crad = baseR * oc[2] * 0.5; var ca = 0.045 * tw3 + k * 0.025;
        var gc = ctx.createRadialGradient(cxo, cyo, 0, cxo, cyo, crad);
        gc.addColorStop(0, 'hsla(' + oc[3] + ',' + oc[4] + '%,74%,' + ca.toFixed(3) + ')');
        gc.addColorStop(1, 'hsla(' + oc[3] + ',' + oc[4] + '%,60%,0)');
        ctx.fillStyle = gc; ctx.beginPath(); ctx.arc(cxo, cyo, crad, 0, 6.283); ctx.fill();
      }
      ctx.lineCap = 'round';
      var wind = 0.22 + mid * 0.10;
      for (var di = 0; di < 40; di++) {
        var t1 = Math.sin(di * 12.9898) * 43758.5; t1 -= Math.floor(t1);
        var t2 = Math.sin(di * 78.233 + 2.1) * 43758.5; t2 -= Math.floor(t2);
        var len = 10 + t2 * 20;
        var vy2 = 3 + t2 * 5 + speed * 4 + en * 3;
        var py = ((t * vy2 + t1 * 1700) % (H + 80)) - 40;
        var px = t1 * 1.30 * W - 0.15 * W;
        var depth = py / H; if (depth < 0) depth = 0; if (depth > 1) depth = 1;
        var al = (0.03 + t2 * 0.035) * (0.55 + 0.45 * depth) + S.flash * 0.04;
        if (al > 0.09) al = 0.09;
        var ef2 = (py + 30) / 60; if (ef2 > 1) ef2 = 1; if (ef2 < 0) ef2 = 0;
        var eg = (H - py) / 60; if (eg > 1) eg = 1; if (eg < 0) eg = 0;
        al *= ef2 * eg;
        if (al <= 0.003) continue;
        ctx.strokeStyle = 'hsla(200,38%,' + (66 + t2 * 14).toFixed(0) + '%,' + al.toFixed(3) + ')';
        ctx.lineWidth = (0.6 + t2 * 0.6) * (0.7 + 0.3 * depth);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - wind * len, py - len); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      ctx.globalCompositeOperation = 'source-over';
      if (S.flash > 0.01) {
        var lg = ctx.createLinearGradient(0, 0, 0, horizon + H * 0.05);
        lg.addColorStop(0, 'rgba(150,178,205,' + (S.flash * 0.42).toFixed(3) + ')');
        lg.addColorStop(0.7, 'rgba(120,150,180,' + (S.flash * 0.15).toFixed(3) + ')');
        lg.addColorStop(1, 'rgba(110,140,170,0)');
        ctx.fillStyle = lg; ctx.fillRect(0, 0, W, horizon + H * 0.05);
      }
      var vog = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.30, cx, cy, Math.max(W, H) * 0.78);
      vog.addColorStop(0, 'rgba(0,0,0,0)'); vog.addColorStop(1, 'rgba(0,0,0,0.24)');
      ctx.fillStyle = vog; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    },
  },
  {
    id: 'space', name: 'Star Rail', hue: 210, bg: [3, 4, 12],
    colors: [[150, 185, 255], [205, 165, 255], [120, 240, 230]],
    draw(R) {
      const ctx = R.ctx;
      ctx.globalCompositeOperation = 'lighter';
      // glowing centerline ribbon you ride
      ctx.beginPath(); let st = false;
      for (let z = R.znear + 0.2; z <= R.zfar; z *= 1.10) {
        const c = R.center(z);
        if (!st) { ctx.moveTo(c[0], c[1]); st = true; } else ctx.lineTo(c[0], c[1]);
      }
      ctx.strokeStyle = `hsla(${R.hue},100%,72%,${(0.5 * R.alpha).toFixed(3)})`;
      ctx.lineWidth = 3; ctx.shadowBlur = 14; ctx.shadowColor = `hsla(${R.hue},100%,66%,0.85)`;
      ctx.stroke();
      ctx.shadowBlur = 6;
      rail(R, -0.07, 0.05, (R.hue + 30) % 360, 0.3, 1.4);
      rail(R, 0.07, 0.05, (R.hue + 30) % 360, 0.3, 1.4);
      ctx.shadowBlur = 0;
      // faint nebula glow drifting (slow)
      const W = R.W; const H = R.H;
      for (let n = 0; n < 3; n++) {
        const nx = W * (0.3 + 0.2 * n) + Math.sin(R.t * 0.006 + n) * W * 0.04;
        const ny = H * (0.4 + 0.12 * Math.sin(n * 2.1)) + Math.cos(R.t * 0.005 + n) * H * 0.03;
        const nr = Math.min(W, H) * (0.22 + 0.06 * n);
        const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
        g.addColorStop(0, `hsla(${(R.hue + n * 30) % 360},80%,60%,${(0.04 * R.alpha).toFixed(3)})`);
        g.addColorStop(1, `hsla(${(R.hue + n * 30) % 360},80%,50%,0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(nx, ny, nr, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    id: 'aurora', name: 'Aurora Drift', hue: 160, bg: [4, 10, 16],
    colors: [[120, 255, 200], [120, 200, 255], [200, 150, 255]],
    draw(R) {
      const ctx = R.ctx; const W = R.W; const H = R.H;
      ctx.globalCompositeOperation = 'lighter';
      for (let b = 0; b < 4; b++) {
        const cyB = H * (0.30 + b * 0.13);
        const amp = H * 0.05 * (1 + R.energy * 0.6) + R.bass * H * 0.03;
        const hue = (R.hue + b * 26) % 360;
        const g = ctx.createLinearGradient(0, cyB - amp * 2, 0, cyB + amp * 2);
        g.addColorStop(0, `hsla(${hue},90%,62%,0)`);
        g.addColorStop(0.5, `hsla(${hue},90%,64%,${((0.06 + 0.05 * R.energy + R.kick * 0.04) * R.alpha).toFixed(3)})`);
        g.addColorStop(1, `hsla(${(hue + 40) % 360},90%,55%,0)`);
        ctx.fillStyle = g; ctx.beginPath();
        const N = 22;
        for (let i = 0; i <= N; i++) { const x = i / N * W; const y = cyB + Math.sin(i * 0.55 + R.t * 0.01 + b) * amp; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        for (let i = N; i >= 0; i--) { const x = i / N * W; const y = cyB + amp + Math.sin(i * 0.55 + R.t * 0.01 + b) * amp * 0.5; ctx.lineTo(x, y); }
        ctx.closePath(); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
];
