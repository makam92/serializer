'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

contextBridge.exposeInMainWorld('api', {
  /**
   * Open a native file picker and return absolute paths of chosen audio files.
   * @returns {Promise<string[]>}
   */
  pickAudioFiles: () => ipcRenderer.invoke('dialog:openAudioFiles'),

  /**
   * Read a local audio file as bytes so the renderer can decode it.
   * @param {string} filePath
   * @returns {Promise<{name: string, bytes: Uint8Array}>}
   */
  readAudioFile: async (filePath) => {
    const buf = await fs.promises.readFile(filePath);
    return { name: path.basename(filePath), bytes: new Uint8Array(buf) };
  },

  /**
   * Discover Sonos rooms on the local network.
   * @returns {Promise<Array<{id:string, ip:string, roomName:string, model:string, location:string}>>}
   */
  discoverSonos: () => ipcRenderer.invoke('sonos:discover'),

  /** Start streaming our live feed to the given rooms (first = group coordinator). */
  sonosPlay: (rooms) => ipcRenderer.invoke('sonos:play', rooms),

  /** Stop playback on the given rooms. */
  sonosStop: (rooms) => ipcRenderer.invoke('sonos:stop', rooms),

  /** Push a chunk of 16-bit stereo PCM to the live stream. */
  sendSonosPcm: (arrayBuffer) => ipcRenderer.send('sonos:pcm', arrayBuffer),

  /** Set a Sonos room's volume (0–100). */
  sonosSetVolume: (ip, volume) => ipcRenderer.invoke('sonos:volume', { ip, volume }),

  /** Set a Sonos room's bass (-10…+10). */
  sonosSetBass: (ip, bass) => ipcRenderer.invoke('sonos:bass', { ip, bass }),
});
