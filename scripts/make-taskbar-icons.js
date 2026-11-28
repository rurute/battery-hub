// fork: build-time generator for the taskbar battery icons (fork Issue #16).
// Run: npx electron scripts/make-taskbar-icons.js
// Paints each icons.js glyph (viewBox 0 0 20 20) on a canvas in a hidden window and writes
// assets/taskbar/<name>-<white|black>-<px>.png (square, transparent). taskbar-battery.exe
// reads these; the running app never renders images (see the comment in make-icon.js).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { ICON_PATHS } = require('../src/main/taskbar-model');

const OUT = path.join(__dirname, '..', 'assets', 'taskbar');
const NAMES = ['mouse', 'keyboard', 'headset', 'mic', 'speaker', 'camera', 'controller', 'pen', 'plug', 'flash'];
const COLORS = { white: '#FFFFFF', black: '#000000' };
// Display scale 100 / 125 / 150 / 200%.
const SIZES = [16, 20, 24, 32];

const drawScript = (d, color, px) => `
(() => {
  const c = document.createElement('canvas'); c.width = c.height = ${px};
  const x = c.getContext('2d');
  x.clearRect(0, 0, ${px}, ${px});
  x.scale(${px / 20}, ${px / 20});
  x.fillStyle = ${JSON.stringify(color)};
  x.fill(new Path2D(${JSON.stringify(d)}));
  return c.toDataURL('image/png');
})()
`;

async function main() {
  for (const name of NAMES) {
    if (typeof ICON_PATHS[name] !== 'string') throw new Error(`icons.js has no path for ${name}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  let count = 0;
  for (const name of NAMES) {
    for (const [colorName, color] of Object.entries(COLORS)) {
      for (const px of SIZES) {
        const url = await win.webContents.executeJavaScript(drawScript(ICON_PATHS[name], color, px));
        fs.writeFileSync(path.join(OUT, `${name}-${colorName}-${px}.png`), Buffer.from(url.split(',')[1], 'base64'));
        count++;
      }
    }
  }
  console.log(`Wrote ${count} taskbar icons to assets/taskbar`);
}

app.whenReady()
  .then(main)
  .then(() => app.quit(), (err) => {
    console.error(err && err.stack ? err.stack : err);
    app.exit(1);
  });
