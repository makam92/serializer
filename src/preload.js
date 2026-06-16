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
});
