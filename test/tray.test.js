const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The list-mode tray icon is redrawn only when what it shows changes.
const calls = [];
class FakeTray {
  constructor() { calls.push('new'); }
  on() {}
  setImage() { calls.push('image'); }
  setToolTip(text) { calls.push(`tip:${text}`); }
  setContextMenu() { calls.push('menu'); }
  getBounds() { return {}; }
  destroy() {}
}
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { Tray: FakeTray, Menu: { buildFromTemplate: (t) => t }, nativeImage: { createFromPath: () => ({}) } };
  if (request === './lang') return { tr: (text) => text };
  return load.call(this, request, ...rest);
};
const tray = require('../src/main/tray');
Module._load = load;

test('tray list mode skips the shell calls when nothing shown changed', () => {
  tray.setMode('list');
  tray.updateDevice('m', { name: 'Mouse', capacity: 80, charging: false, offline: false });
  const first = calls.length;
  assert.ok(first > 0);
  tray.updateDevice('m', { name: 'Mouse', capacity: 80, charging: false, offline: false });
  assert.equal(calls.length, first, 'the same reading again changes nothing');
  tray.updateDevice('m', { name: 'Mouse', capacity: 79, charging: false, offline: false });
  assert.ok(calls.length > first);
  assert.ok(calls.some((c) => c.includes('Mouse: 79%')));
});
