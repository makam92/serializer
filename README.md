# Serializer

Play one track across **multiple speakers at the same time, in sync** — Bluetooth,
AirPlay, wired, or built-in. A cross-platform desktop app (macOS / Windows / Linux)
built with Electron.

## How it works

Every speaker your OS knows about appears as an audio **output device**. Serializer
opens one audio stream per device, routes it to that device with
[`setSinkId`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId),
and plays the same source through all of them. One stream acts as the reference
clock; the others are continuously reconciled to it so they don't drift apart.

Because real speakers (especially Bluetooth and AirPlay/Sonos) have very different
latency, each device has a **Delay comp** control — type a value, use the
**±10 / ±100 ms** nudge buttons, or drag the slider — to push it earlier or later
until everything lines up. Each speaker also has its own **Volume** and a **Bass**
boost (a low-shelf EQ). All three are **saved per speaker and restored** on the next
launch, so you only have to tune a room once.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (ships with `npm`)
- macOS, Windows, or Linux

## Install & run

```bash
git clone https://github.com/makam92/serializer.git
cd serializer
npm install
npm start
```

To launch with verbose logging during development:

```bash
npm run dev
```

1. Click **Open file…** and pick an audio file (MP3, WAV, FLAC, M4A, …).
2. Tick the speakers you want under **Output speakers**.
3. Press **Play**. Adjust per-speaker **Volume**, **Bass**, and **Delay comp** to
   taste — your settings are remembered for next time.

> First launch will ask for microphone permission — this is only used to reveal the
> *names* of your output devices (a Chromium quirk); no audio is recorded.

## Scope

**Working now:**
- **File mode** — local audio files (MP3, WAV, FLAC, M4A, …)
- **Live mode** — capture any audio *input* and broadcast it live to your speakers.
  Combined with the free [BlackHole](https://github.com/ExistentialAudio/BlackHole)
  loopback driver this lets you stream your **browser / system audio** (Spotify in a
  browser tab, YouTube, anything) to every speaker.
- Simultaneous playback to any OS output devices (Bluetooth / AirPlay / wired / built-in)
- Per-speaker **volume**, **bass** (low-shelf EQ), and **delay compensation**
  (type / nudge / drag), all **saved between sessions**
- Master transport & continuous drift sync, plus an **input level meter** in Live mode
  to confirm signal is flowing

### Broadcasting browser / system audio (Live mode)

macOS doesn't let apps tap system output directly, so use a virtual loopback device:

1. Install **BlackHole** (`brew install blackhole-2ch`).
2. Open **Audio MIDI Setup** → create a **Multi-Output Device** containing both your
   real speakers *and* BlackHole (so you still hear audio locally), and set it as the
   Mac's output. *(Or just set output to BlackHole if you only want it on the remote speakers.)*
3. In Serializer, switch to **🎙 Live input**, pick **BlackHole** as the input, tick
   your speakers, and press **Start**.

> Live audio has a small inherent latency, and **Delay comp** can only *add* delay in
> live mode — align the faster speakers down to the slowest one.

**Planned (later phases):**
- Chromecast & Sonos (network-protocol speakers via mDNS discovery + casting)
- Native macOS 14.4+ Core Audio process taps (system capture with no driver)
- Direct streaming-service SDKs (Spotify / Apple Music)
- Playlist / queue

## Project layout

```
src/
  main.js              Electron main process (window, file dialog, permissions)
  preload.js           Secure bridge: file picker + file reading
  renderer/
    index.html         UI
    styles.css         Styling
    renderer.js        Device discovery + multi-output sync engine
```
