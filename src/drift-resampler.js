'use strict';

/**
 * DriftResampler — adaptive (variable-ratio) linear resampler for clock-drift
 * correction on the live network-audio paths (AirPlay / Sonos).
 *
 * THE PROBLEM
 * We produce PCM on the Mac audio-hardware clock (the capture AudioContext) but
 * the receiver consumes on a different clock (AirPlay: node-airtunes2's wall-clock
 * RTP drain; Sonos: the player's own crystal). Those oscillators differ by a small
 * but constant rate, so a fixed delay can't keep them aligned — the receiver's
 * buffer slowly fills or empties and the audio drifts. Dropping chunks (the current
 * back-pressure) only *bounds* the drift; it doesn't keep tight sync and it glitches.
 *
 * THE FIX (this module)
 * A control loop watches the receiver buffer's fill level and continuously trims our
 * output sample rate by a tiny amount (<~0.4%, inaudible) so the buffer holds a fixed
 * target. Net effect: production rate is servo-locked to the consumer's drain rate, so
 * the offset you set with the group delay stays put — no drops, no growing lag.
 *
 *   capture PCM ──▶ DriftResampler.process() ──▶ writePcm()/stream
 *                        ▲
 *                        │ ratio
 *                  setFill(bufferFrames)   ◀── consumer buffer level (feedback)
 *
 * This is the standard technique used by PulseAudio / Snapcast / Roon for the same
 * source-vs-sink clock problem.
 *
 * STATUS: DRAFT. The resampler math is verified; the controller GAINS (kp/ki) and the
 * target must be tuned against real hardware before wiring into the live path. Not yet
 * connected — see docs/adaptive-resampling.md for the rollout plan.
 */

class DriftResampler {
  /**
   * @param {object} [opts]
   * @param {number} [opts.channels=2]      interleaved channel count
   * @param {number} [opts.targetFrames=0]  desired steady-state consumer buffer fill (frames)
   * @param {number} [opts.maxAdjust=0.004] max rate trim (±0.4%) — clamps the controller
   * @param {number} [opts.kp]              proportional gain (ratio per frame of error)
   * @param {number} [opts.ki=0]            integral gain (start P-only; add I once stable)
   */
  constructor(opts = {}) {
    this.channels = opts.channels || 2;
    this.targetFrames = opts.targetFrames || 0;
    this.maxAdjust = opts.maxAdjust != null ? opts.maxAdjust : 0.004;
    // Default kp reaches full maxAdjust at ~0.25 s of buffer error (11025 frames @44.1k).
    this.kp = opts.kp != null ? opts.kp : this.maxAdjust / 11025;
    this.ki = opts.ki != null ? opts.ki : 0;

    this.ratio = 1;            // input frames consumed per output frame (1 = passthrough)
    this._integral = 0;
    this._pos = 0;             // fractional read position carried across chunks (input frames)
    this._prev = new Float32Array(this.channels); // last input frame of the previous chunk
    this._havePrev = false;
  }

  /**
   * Feed the latest consumer buffer fill (in frames). Updates `ratio` via a PI loop.
   * @param {number} fillFrames current buffered frames waiting to be played by the receiver
   */
  setFill(fillFrames) {
    const err = fillFrames - this.targetFrames; // >0 = buffer too full = we're overfeeding
    this._integral += err;
    // Overfeeding -> consume MORE input per output (ratio>1) -> emit fewer frames -> buffer falls.
    let r = 1 + this.kp * err + this.ki * this._integral;
    if (r < 1 - this.maxAdjust) r = 1 - this.maxAdjust;
    else if (r > 1 + this.maxAdjust) r = 1 + this.maxAdjust;
    this.ratio = r;
    // Anti-windup: stop integrating once clamped.
    if (this.ki && (r === 1 - this.maxAdjust || r === 1 + this.maxAdjust)) {
      this._integral -= err;
    }
  }

  /**
   * Resample one interleaved Int16 chunk by the current `ratio` (linear interpolation,
   * fractional position carried across calls for click-free continuity).
   * @param {Int16Array} input interleaved Int16 (length = frames * channels)
   * @returns {Int16Array} resampled interleaved Int16
   */
  process(input) {
    const ch = this.channels;
    const inFrames = (input.length / ch) | 0;
    if (inFrames === 0) return input;

    if (!this._havePrev) { // seed prev with the first frame so pos can't read before the start
      for (let c = 0; c < ch; c++) this._prev[c] = input[c];
      this._havePrev = true;
    }

    const step = this.ratio;
    // Virtual input: frame -1 = this._prev (carried), frames 0..inFrames-1 = input.
    const at = (idx, c) => (idx < 0 ? this._prev[c] : input[idx * ch + c]);

    // Worst-case output frames for preallocation (ratio >= 1-maxAdjust).
    const cap = Math.ceil((inFrames - this._pos) / (1 - this.maxAdjust)) + 1;
    const out = new Int16Array(cap * ch);

    let pos = this._pos;
    let o = 0;
    while (pos < inFrames - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      for (let c = 0; c < ch; c++) {
        const a = at(i0, c);
        const b = at(i0 + 1, c);
        let v = a + (b - a) * frac;
        v = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
        out[o++] = v;
      }
      pos += step;
    }

    for (let c = 0; c < ch; c++) this._prev[c] = input[(inFrames - 1) * ch + c];
    this._pos = pos - inFrames; // remainder continues into the next chunk's coordinate space
    return o === out.length ? out : out.subarray(0, o);
  }

  reset() {
    this.ratio = 1;
    this._integral = 0;
    this._pos = 0;
    this._havePrev = false;
  }
}

module.exports = { DriftResampler };
