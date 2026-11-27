// Batteries read through Windows rather than HID: paired Bluetooth devices and Xbox controllers.
// One watcher stays running while any such device is tracked. It is a small program built from
// batteries/SystemBatteries.cs (about 17 MB running); without it, the same work runs as a PowerShell
// script, which holds about 125 MB.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROGRAM = path.join(__dirname, 'system-batteries.exe');
// Bluetooth LE devices whose level Windows doesn't show, read from their Battery Service
// (batteries/BleBatteries.cs). Slower and it wakes the radio, so it runs less often.
const BLE_PROGRAM = path.join(__dirname, 'ble-batteries.exe');
const BLE_EVERY_MS = 5 * 60 * 1000;
const BLE_TIMEOUT_MS = 60000;
const BLE_SCAN_WAIT_MS = 8000;
const SCRIPT = path.join(__dirname, 'system-batteries.ps1');
const ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];

// The command for one scan, or for a watcher scanning every few seconds while the app runs.
function command(every) {
  if (fs.existsSync(PROGRAM)) return [PROGRAM, every ? ['--every', String(every), '--parent', String(process.pid)] : []];
  return ['powershell.exe', every ? [...ARGS, '-Every', String(every), '-ParentId', String(process.pid)] : ARGS];
}
const SCAN_TIMEOUT_MS = 20000;
const WATCH_EVERY_S = 10; // cheap once running: it asks the device manager directly

let watcher = null;
let latest = new Map(); // id -> { id, name, kind, capacity, connected }
let ble = new Map();    // the same, from the Bluetooth LE reader
let bleTimer = null;

function readBle() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(BLE_PROGRAM)) { resolve([]); return; }
    execFile(BLE_PROGRAM, [], { windowsHide: true, timeout: BLE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      const list = err ? null : parseScan(String(stdout).trim().split(/\r?\n/).pop());
      // A device that didn't answer this time (asleep) keeps its last level until it does.
      if (list) for (const d of list) ble.set(d.id, d);
      resolve(list || []);
    });
  });
}
let seenAt = 0;

function parseScan(line) {
  try {
    const list = JSON.parse(line);
    return (Array.isArray(list) ? list : [list]).filter((d) => d && d.id && d.capacity >= 0 && d.capacity <= 100);
  } catch (_) {
    return null;
  }
}

function remember(list) {
  latest = new Map(list.map((d) => [d.id, d]));
  seenAt = Date.now();
}

function runScript() {
  return new Promise((resolve) => {
    const [file, args] = command(0);
    execFile(file, args, { windowsHide: true, timeout: SCAN_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      const list = err ? null : parseScan(stdout.trim().split(/\r?\n/).pop());
      resolve({ list, error: list ? null : String(stderr || (err && err.message) || 'no output').slice(0, 200) });
    });
  });
}

// One fresh look, for the Add device list.
async function scan() {
  if (process.platform !== 'win32') return [];
  // The Bluetooth LE read can take a while per sleeping device, so the list doesn't wait for it long:
  // what it hasn't read yet shows up on the next look.
  const wait = new Promise((resolve) => setTimeout(resolve, BLE_SCAN_WAIT_MS));
  const [{ list }] = await Promise.all([runScript(), Promise.race([readBle(), wait])]);
  if (list) remember(list);
  return (list || []).concat(Array.from(ble.values()));
}

// For the support check: can PowerShell run the script at all?
async function selfTest() {
  if (process.platform !== 'win32') return { ok: true, count: 0 };
  const { list, error } = await runScript();
  return list ? { ok: true, count: list.length } : { ok: false, error };
}

function startWatching() {
  if (watcher || process.platform !== 'win32') return;
  const [file, args] = command(WATCH_EVERY_S);
  watcher = spawn(file, args, { windowsHide: true });
  let buffer = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const list = parseScan(line);
      if (list) remember(list);
    }
  });
  if (!bleTimer) {
    readBle();
    bleTimer = setInterval(readBle, BLE_EVERY_MS);
  }
  watcher.on('error', () => { watcher = null; });
  watcher.on('exit', () => { watcher = null; });
}

function stopWatching() {
  if (watcher) watcher.kill();
  watcher = null;
  if (bleTimer) clearInterval(bleTimer);
  bleTimer = null;
}

const get = (id) => latest.get(id) || ble.get(id) || null;
const list = () => Array.from(latest.values()).concat(Array.from(ble.values()));
const hasScanned = () => seenAt > 0;
const isSystemId = (id) => /^(bt|ble|xinput):/.test(id);

module.exports = { scan, selfTest, startWatching, stopWatching, get, list, hasScanned, isSystemId, parseScan };
