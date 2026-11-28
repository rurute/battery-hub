// fork: the taskbar battery levels (fork Issue #16) are wired into upstream files by a few marked
// lines only (docs/fork.md). These checks keep that wiring in place after an upstream merge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const TITLE = 'Taskbar battery levels';
const HINT = "Show each connected device's icon and level next to the tray.";

test('the settings screen has the taskbarBattery toggle with its title and hint', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /<button class="toggle" data-setting="taskbarBattery" role="switch">/);
  assert.ok(html.includes(`<span class="settings-title">${TITLE}</span>`));
  assert.ok(html.includes(`<span class="settings-hint">${HINT}</span>`));
});

test('the window loads the fork translations right after i18n-strings.js', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /<script src="i18n-strings\.js"><\/script>\s*<script src="i18n-fork\.js"><\/script><!-- fork: -->/);
});

test('the title and the hint are translated in every language, in Node too', () => {
  const { BH_STRINGS } = require('../src/renderer/i18n-strings');
  for (const lang of ['pt', 'es', 'zh', 'he', 'ru']) {
    for (const text of [TITLE, HINT]) {
      const t = BH_STRINGS[lang][text];
      assert.ok(typeof t === 'string' && t.trim() && t !== text, `${lang}: ${text}`);
    }
  }
});

test('main.js has exactly two fork lines: require the taskbar and start it', () => {
  const lines = read('src/main/main.js').split('\n').filter((l) => l.includes('// fork:'));
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("require('./taskbar')")));
  assert.ok(lines.some((l) => l.includes('taskbar.start({ store, logLine, app })')));
});

test('the taskbar starts right after the poller', () => {
  const src = read('src/main/main.js');
  assert.match(src, /poller\.start\(broadcast\);\n\s*taskbar\.start\(\{ store, logLine, app \}\); \/\/ fork:/);
});
