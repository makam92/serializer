'use strict';

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const sonos = require('./sonos');
const airplay = require('./airplay');
const { StreamServer } = require('./streamserver');

/** @type {StreamServer | null} */
let streamServer = null;

/** @type {BrowserWindow | null} */
let mainWindow = null;

// Streams the live capture to AirPlay receivers (Apple TV, AirPlay-2 TVs,
// HomePods). Discovery is dependency-free; the streaming half lazily loads
// node-airtunes2 and degrades gracefully if it can't load or pair.
const airplayCaster = new airplay.AirPlayCaster();
airplayCaster.onStatus = (key, status, desc) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('airplay:status', { key, status, desc });
  }
};

// Only one instance may run — a second would start a rival stream server and
// AirPlay caster fighting over the same Sonos rooms / AirPlay receivers (we hit
// exactly this confusion in testing). Focus the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Stop broadcasting to network devices so they don't keep playing once the UI is
// gone. The local HTTP stream server stays up so reopening the window (macOS
// dock) still works; on full quit it's torn down too.
function stopStreamingToDevices() {
  try { airplayCaster.stopAll(); } catch {}
  try { if (sonosGroup.coordIp) sonos.stop(sonosGroup.coordIp).catch(() => {}); } catch {}
  sonosGroup = { coordId: null, coordIp: null, followers: new Set() };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 560,
    backgroundColor: '#08090b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing the window (which does NOT quit on macOS) must stop any active
  // Sonos/AirPlay broadcast — otherwise they keep playing with no UI to stop them.
  mainWindow.on('close', stopStreamingToDevices);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Enumerating audio output devices and using setSinkId requires that the
// renderer be granted access to media devices. Approve those requests.
function configureMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  ses.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
}

ipcMain.handle('dialog:openAudioFiles', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose audio files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aiff'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

// Discover Sonos rooms on the LAN (renderer asks via this channel).
ipcMain.handle('sonos:discover', async () => {
  const rooms = await sonos.discover();
  console.log(`[sonos] discovered ${rooms.length} room(s):`, rooms.map((r) => `${r.roomName} (${r.model})`).join(', '));
  return rooms;
});

// Live PCM frames from the renderer's BlackHole capture → fan out to Sonos clients.
ipcMain.on('sonos:pcm', (_e, buf) => { if (streamServer) streamServer.writePcm(Buffer.from(buf)); });

// Current Sonos group, tracked so we can update it incrementally — adding or
// removing a follower must NOT disturb the coordinator's stream (which would
// re-buffer and knock the whole group out of sync with the local speakers).
let sonosGroup = { coordId: null, coordIp: null, followers: new Set() };

// Serialize all Sonos group mutations — rapid play/stop must not interleave and
// race on the shared sonosGroup state.
let sonosQueue = Promise.resolve();
function queueSonos(fn) {
  const run = sonosQueue.then(fn, fn);
  sonosQueue = run.catch(() => {});
  return run;
}

ipcMain.handle('sonos:play', (_e, rooms) => queueSonos(async () => {
  if (!streamServer) return { ok: false, error: 'stream server not ready' };
  if (!rooms.length) return { ok: false, error: 'no rooms' };
  const url = `http://${streamServer.ip}:${streamServer.port}/live.wav`;
  const [coord, ...followers] = rooms;
  const failures = [];
  try {
    // (Re)start the coordinator only when it actually changes.
    if (sonosGroup.coordId !== coord.id) {
      // Stop the previous coordinator first, or it keeps streaming as a separate,
      // out-of-sync group.
      if (sonosGroup.coordIp) { try { await sonos.stop(sonosGroup.coordIp); } catch {} }
      await sonos.setUri(coord.ip, url, sonos.streamMetadata(url));
      await sonos.play(coord.ip);
      sonosGroup = { coordId: coord.id, coordIp: coord.ip, followers: new Set() };
      console.log(`[sonos] coordinator → ${coord.roomName}`);
    }
    // Group only followers not already in the group (leaves the coordinator and
    // existing members undisturbed). One unreachable room can't abort the batch.
    for (const f of followers) {
      if (sonosGroup.followers.has(f.id)) continue;
      try {
        await sonos.setUri(f.ip, `x-rincon:${coord.id}`);
        sonosGroup.followers.add(f.id);
        console.log(`[sonos] + ${f.roomName} joined ${coord.roomName}`);
      } catch (e) {
        failures.push(f.roomName);
        console.log(`[sonos] ! ${f.roomName} failed to join: ${e.message}`);
      }
    }
    return { ok: true, url, coordinator: coord.roomName, failures };
  } catch (e) { return { ok: false, error: e.message }; }
}));

ipcMain.handle('sonos:stop', (_e, rooms) => queueSonos(async () => {
  try {
    await sonos.stopAll(rooms);
    for (const r of rooms) {
      sonosGroup.followers.delete(r.id);
      if (sonosGroup.coordId === r.id) sonosGroup = { coordId: null, coordIp: null, followers: new Set() };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}));

ipcMain.handle('sonos:volume', async (_e, { ip, volume }) => {
  try { await sonos.setVolume(ip, volume); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('sonos:bass', async (_e, { ip, bass }) => {
  try { await sonos.setBass(ip, bass); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---- AirPlay (network) ----
// Discover AirPlay receivers on the LAN (renderer asks via this channel).
ipcMain.handle('airplay:discover', async () => {
  const devices = await airplay.discover();
  console.log(`[airplay] discovered ${devices.length} device(s):`, devices.map((d) => `${d.name} (${d.model})`).join(', '));
  return devices;
});

// (Re)connect the given receivers and stream the live feed to them.
ipcMain.handle('airplay:play', (_e, receivers) => airplayCaster.play(receivers || []));

// Stop a subset of receivers (by `host:port` key), or all when none given.
ipcMain.handle('airplay:stop', (_e, keys) => {
  if (keys && keys.length) airplayCaster.stop(keys); else airplayCaster.stopAll();
  return { ok: true };
});

ipcMain.handle('airplay:volume', (_e, { key, volume }) => { airplayCaster.setVolume(key, volume); return { ok: true }; });

// Enter the PIN a receiver (e.g. an Apple TV) displays on screen when pairing.
ipcMain.handle('airplay:passcode', (_e, { key, passcode }) => { airplayCaster.setPasscode(key, passcode); return { ok: true }; });

// Live PCM frames from the renderer's capture → AirPlay receivers. Separate from
// the Sonos feed so either can run alone.
ipcMain.on('airplay:pcm', (_e, buf) => airplayCaster.writePcm(Buffer.from(buf)));

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  configureMediaPermissions();
  createWindow();

  streamServer = new StreamServer();
  try {
    const { ip, port } = await streamServer.start();
    console.log(`[stream] server listening on ${ip}:${port}`);
  } catch (e) { console.log('[stream] failed to start:', e.message); }



  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On full quit, stop the broadcasts and tear down the stream server.
app.on('before-quit', () => {
  stopStreamingToDevices();
  try { if (streamServer) { streamServer.stop(); streamServer = null; } } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
