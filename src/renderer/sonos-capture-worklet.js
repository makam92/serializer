'use strict';

/**
 * Sonos capture worklet — runs on the audio render thread (NOT the main thread),
 * so UI work (slider drags, layout, GC) can never starve it.
 *
 * It converts the incoming live audio to 16-bit stereo PCM, batches a chunk
 * (~23 ms), and posts it to the main thread as a transferable ArrayBuffer
 * (zero-copy). The main thread just forwards it to the streaming server.
 */

const BATCH_FRAMES = 1024; // ~23 ms at 44.1 kHz

class SonosCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(BATCH_FRAMES * 2);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const L = input[0];
      const R = input.length > 1 ? input[1] : input[0];
      if (L) {
        for (let i = 0; i < L.length; i++) {
          let l = L[i]; if (l > 1) l = 1; else if (l < -1) l = -1;
          let r = R[i]; if (r > 1) r = 1; else if (r < -1) r = -1;
          this._buf[this._n++] = l < 0 ? l * 0x8000 : l * 0x7fff;
          this._buf[this._n++] = r < 0 ? r * 0x8000 : r * 0x7fff;
          if (this._n >= this._buf.length) {
            this.port.postMessage(this._buf.buffer, [this._buf.buffer]);
            this._buf = new Int16Array(BATCH_FRAMES * 2);
            this._n = 0;
          }
        }
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor('sonos-capture', SonosCaptureProcessor);
