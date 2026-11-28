const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The Bluetooth LE reader never runs twice at once, and its timer asks only for the tracked devices.
const runs = [];
let finish = null;
const fakeChild = {
  execFile: (file, args, options, cb) => {
    runs.push({ file, args });
    if (/ble-batteries/.test(file)) finish = () => cb(null, '[{"id":"ble:AABBCCDDEEFF","name":"Mouse","kind":"bluetooth","capacity":70,"connected":true}]\n');
    else cb(null, '[]\n');
  },
  spawn: () => ({ stdout: { setEncoding() {}, on() {} }, on() {}, kill() {} }),
};
const realFs = require('fs');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'child_process') return fakeChild;
  if (request === 'fs') return { ...realFs, existsSync: () => true };
  return load.call(this, request, ...rest);
};
delete require.cache[require.resolve('../src/main/system-batteries')];
const system = require('../src/main/system-batteries');
Module._load = load;

const bleRuns = () => runs.filter((r) => /ble-batteries/.test(r.file));

test('the LE reader asks only for the tracked devices, and a second start joins the running one', async () => {
  if (process.platform !== 'win32') return;
  system.startWatching({ ble: ['AABBCCDDEEFF'] });
  assert.equal(bleRuns().length, 1);
  assert.deepEqual(bleRuns()[0].args, ['--only', 'AABBCCDDEEFF']);
  // Add device's scan while the timer's read is still running: no second reader.
  const scanning = system.scan();
  assert.equal(bleRuns().length, 1);
  finish();
  await scanning;
  assert.equal(system.get('ble:AABBCCDDEEFF').capacity, 70);
  // The same devices again: the timer keeps going, nothing new starts.
  system.startWatching({ ble: ['AABBCCDDEEFF'] });
  assert.equal(bleRuns().length, 1);
  system.stopWatching();
});
