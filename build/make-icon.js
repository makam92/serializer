'use strict';
// Render build/make-icon.html to build/icon-1024.png. Run: electron build/make-icon.js
// (the .icns is then built from it via sips + iconutil — see the npm scripts / README).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false });
  await win.loadFile(path.join(__dirname, 'make-icon.html'));
  await new Promise((r) => setTimeout(r, 400)); // let the canvas paint
  const dataUrl = await win.webContents.executeJavaScript('document.getElementById("c").toDataURL("image/png")');
  fs.writeFileSync(path.join(__dirname, 'icon-1024.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote build/icon-1024.png');
  app.quit();
});
