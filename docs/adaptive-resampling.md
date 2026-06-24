# Adaptive resampling — eliminating network-audio clock drift

**Status: DRAFT / design.** The resampler core (`src/drift-resampler.js`) is written and
numerically verified; it is **not yet wired into the live path**. This doc is the plan for
turning the current *drift-bounding* stopgap into *drift-elimination*.

## Problem

We capture live audio on the **Mac audio-hardware clock** (the capture `AudioContext`) and
send PCM to network receivers that play on a **different clock**:

- **AirPlay** — `node-airtunes2` drains its circular buffer on a wall-clock timer
  (`Date.now()`), and the TV follows that timeline via RTP sync.
- **Sonos** — the player pulls our HTTP/WAV stream and plays on its own crystal.

Two independent oscillators tick at slightly different rates (tens to hundreds of ppm, made
worse by the 48k→44.1k resample in the capture context). So the receiver's buffer slowly
**fills or empties**, and the audio drifts relative to the local speakers. A fixed "initial
delay" sets the starting offset but **cannot correct a rate difference** — the gap keeps
growing.

### Where we are now (the stopgap)

`AirPlayCaster.writePcm` and the Sonos `streamserver` **drop** chunks when the consumer
buffer grows too deep. This *bounds* the drift (it can't run away) but it doesn't keep tight
sync, and each drop is a brief glitch. Good enough to stop the runaway; not good enough for
"set the delay once and forget it."

## Approach: servo the production rate to the consumer's drain rate

Classic source-vs-sink clock correction (PulseAudio, Snapcast, Roon all do this): a control
loop watches the consumer buffer's fill level and continuously trims our **output sample
rate** by a tiny amount so the buffer holds a fixed target. When production is rate-locked to
consumption, the offset you dialed in stays put — no drops, no growing lag.

```
 capture PCM ──▶ DriftResampler.process(chunk) ──▶ writePcm()/stream ──▶ receiver
                       ▲                                                      │
                       │ ratio (≈1 ± <0.4%)                                   │ buffer level
                       └──────────────── setFill(bufferFrames) ◀─────────────┘
```

- **Resampler** (`DriftResampler`, done): variable-ratio linear interpolation over interleaved
  Int16, fractional position carried across chunks for click-free output. A <0.4% rate trim is
  pitch-inaudible. Verified: output length tracks the ratio; a continuous sine has no boundary
  discontinuity.
- **Controller** (in `DriftResampler.setFill`, done): PI loop. `err = fill - target`; overfeed
  (`err>0`) → `ratio>1` → emit fewer frames → buffer falls back to target. Output clamped to
  `1 ± maxAdjust`, with anti-windup. Start **P-only** (`ki=0`); add a small `ki` once stable.

## Integration

### AirPlay (do this first — clean feedback)

`node-airtunes2` exposes the buffer directly, so the feedback signal is exact:

```js
const cb = airtunes.circularBuffer;               // already used by the bound
const fillFrames = cb.currentSize / (2 /*ch*/ * 2 /*bytes*/);
resampler.targetFrames = (cb.maxSize / 2) / 4;    // the library's ~0.8s play threshold
resampler.setFill(fillFrames);
airtunes.write(Buffer.from(resampler.process(int16chunk).buffer));
```

Plug point: `AirPlayCaster.writePcm` (the chunk arrives there from `airplay:pcm`). Keep the
existing `0.6 * maxSize` drop as a **safety backstop** for big transients (scheduling hiccups);
the resampler should keep us far below it in steady state, so it rarely fires.

One resampler/controller per `AirPlayCaster` (all AirPlay devices share the one circular
buffer, so one loop governs the group — correct).

### Sonos (later — feedback is indirect)

We don't see the Sonos player's buffer. Options, roughly in order of preference:

1. **Produced-minus-accepted bytes** — track how many bytes we've written to the HTTP socket
   vs how many the socket has flushed (`res.writableLength`), as a proxy for "how far ahead of
   the player we are." Noisier than AirPlay but workable with a slow control loop.
2. Assume a fixed Sonos buffer and lock to a constant production rate derived from wall-clock
   (open-loop) — simplest, corrects the capture-clock error but not the Sonos-clock error.

Ship AirPlay closed-loop first; revisit Sonos once the AirPlay loop is tuned.

## Rollout (incremental, each step independently testable)

1. **Measure first.** Add temporary logging of `cb.currentSize` (every ~1 s) during an AirPlay
   session to confirm drift direction + magnitude and validate the model. (Low risk; do before
   touching the audio path.)
2. **Wire AirPlay, P-only, behind a flag.** Conservative `maxAdjust` (0.2–0.4%), `ki=0`. Keep
   the drop backstop.
3. **Tune `kp`** against the real TV: it should pull the buffer back to target in ~10–30 s with
   no visible oscillation. Then optionally add a small `ki` to kill steady-state error.
4. **Verify** a 30–60 min playthrough holds the set offset; confirm no audible pitch/artifact.
5. **Sonos** via the produced-vs-accepted proxy.
6. Optional: surface the live buffer level / lock state in the UI (debug readout).

## Risks & notes

- **CPU in the hot path** — `process()` runs per chunk in the main process. It's preallocated
  Int16 + linear interp (cheap), but profile under multi-device load; upgrade to a short
  polyphase/sinc filter only if linear artifacts are audible (they shouldn't be at <0.4%).
- **Interaction with the library's own silence-padding** — when its buffer underruns,
  `circular_buffer.readPacket` pads silence and re-enters `FILLING`. The controller must treat
  the `FILLING` re-fill as "buffer low" (it will, via `currentSize`) and not fight it.
- **Tuning is hardware-dependent** — gains that are stable on one receiver may need adjusting;
  keep them in `config`-like constants.
- **Don't over-correct** — `maxAdjust` is a hard ceiling so a bad measurement can never warp
  pitch audibly or run the buffer away.

## Files

- `src/drift-resampler.js` — `DriftResampler` (resampler + PI controller). Done, tested, inert
  (not imported anywhere yet).
- This doc — the plan.
