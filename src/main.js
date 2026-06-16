'use strict';

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('node:path');
const sonos = require('./sonos');
const { StreamServer } = require('./streamserver');

/** @type {StreamServer | null} */
let streamServer = null;

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0e0f13',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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
let sonosGroup = { coordId: null, followers: new Set() };

ipcMain.handle('sonos:play', async (_e, rooms) => {
  if (!streamServer) return { ok: false, error: 'stream server not ready' };
  if (!rooms.length) return { ok: false, error: 'no rooms' };
  const url = `http://${streamServer.ip}:${streamServer.port}/live.wav`;
  const [coord, ...followers] = rooms;
  try {
    // (Re)start the coordinator only when it actually changes.
    if (sonosGroup.coordId !== coord.id) {
      await sonos.setUri(coord.ip, url, sonos.streamMetadata(url));
      await sonos.play(coord.ip);
      sonosGroup = { coordId: coord.id, followers: new Set() };
      console.log(`[sonos] coordinator → ${coord.roomName}`);
    }
    // Group only followers that aren't already in the group (leaves the
    // coordinator and existing members playing undisturbed).
    for (const f of followers) {
      if (!sonosGroup.followers.has(f.id)) {
        await sonos.setUri(f.ip, `x-rincon:${coord.id}`);
        sonosGroup.followers.add(f.id);
        console.log(`[sonos] + ${f.roomName} joined ${coord.roomName}`);
      }
    }
    return { ok: true, url, coordinator: coord.roomName };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('sonos:stop', async (_e, rooms) => {
  try {
    await sonos.stopAll(rooms);
    for (const r of rooms) {
      sonosGroup.followers.delete(r.id);
      if (sonosGroup.coordId === r.id) sonosGroup = { coordId: null, followers: new Set() };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('sonos:volume', async (_e, { ip, volume }) => {
  try { await sonos.setVolume(ip, volume); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('sonos:bass', async (_e, { ip, bass }) => {
  try { await sonos.setBass(ip, bass); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

app.whenReady().then(async () => {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
