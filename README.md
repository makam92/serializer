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
- **Sonos (network)** — discovers Sonos rooms on your LAN and broadcasts your Live
  audio to them, even across VLANs. Multiple rooms play grouped in tight sync, with
  per-room **volume** / **bass** and a group-wide **delay** — all over the network
  (see below)
- **AirPlay (network)** — discovers AirPlay receivers (Apple TV, AirPlay-2 TVs,
  HomePods) that the OS hides from the app's speaker list, and streams your Live audio
  to them with per-device **volume** and a group-wide **delay** (see below)

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

### Sonos over the network (Live mode)

Sonos players don't appear as OS audio devices, so Serializer talks to them directly:
it discovers rooms via mDNS (works even when the Mac and Sonos sit on different
subnets/VLANs, via your network's Bonjour reflector), then streams the live capture to
them over HTTP and drives them with UPnP. Tick the rooms under **Sonos · network** while
in Live mode.

- Multiple rooms are **grouped** so they stay in tight sync with each other.
- Per-room **volume** and **bass** use Sonos's own controls (over the network).
- A group-wide **delay** nudges the whole Sonos set's timing.

> Sonos buffers on its own clock, so Sonos-vs-*local*-speaker timing is loose (~1–2 s);
> Sonos-to-Sonos is tight. Streaming to Sonos is Live-mode only.

> **Hearing reverb/echo on Sonos?** If your real speakers are part of the BlackHole
> Multi-Output Device, you hear the *instant* local sound and the *delayed* Sonos sound
> at once. Set the Mac's output to **BlackHole alone**, or move out of earshot of the
> local speakers. The app shows this reminder whenever it streams to Sonos.

### AirPlay over the network (Live mode)

AirPlay receivers (Apple TV, AirPlay-2 TVs like Samsung's *The Frame*, HomePods) show
up in macOS's volume menu but **not** in Chromium's device list — macOS only creates a
Core Audio device for an AirPlay target once it's the system output. So Serializer
discovers them itself over mDNS (`_airplay._tcp` / `_raop._tcp`) and streams to them
directly. Tick devices under **AirPlay · network** while in Live mode.

- Per-device **volume** uses AirPlay's own control (over the network).
- A group-wide **delay** nudges the whole AirPlay set's timing (like Sonos).
- Receivers that show a **PIN** on screen (e.g. Apple TV) prompt for it inline the first
  time you connect.

> Streaming to AirPlay uses the [`node-airtunes2`](https://www.npmjs.com/package/node-airtunes2)
> library, which carries the AirPlay-2 pairing crypto. On macOS it runs in pure
> JavaScript (no native build needed); on Windows/Linux `npm install` compiles a small
> native module via `node-gyp`. Like Sonos, AirPlay is Live-mode only and buffers on its
> own clock, so the same group-delay tuning applies.

**Planned (later phases):**
- Chromecast & other network-protocol speakers (mDNS discovery + casting)
- Native macOS 14.4+ Core Audio process taps (system capture with no driver)
- Direct streaming-service SDKs (Spotify / Apple Music)
- Playlist / queue

## Project layout

```
src/
  main.js              Electron main process (window, file dialog, permissions, Sonos IPC)
  preload.js           Secure bridge: file picker + file reading + Sonos control
  sonos.js             Sonos discovery (mDNS + UPnP topology) and control
  airplay.js           AirPlay discovery (mDNS) + streaming via node-airtunes2
  streamserver.js      HTTP server that streams live PCM to Sonos players
  renderer/
    index.html         UI
    styles.css         Styling
    renderer.js        Device discovery + multi-output sync engine
    sonos-capture-worklet.js   Audio-thread PCM capture for the Sonos stream
```
