// fork: runs taskbar-battery.exe, which draws each connected device's icon and level next to
// the tray (fork Issue #16). This file only starts and stops the exe and sends it one JSON line
// per change; taskbar-model.js decides what the line says. Changes are picked up by wrapping
// the store's write functions, so main.js needs just require + start. Nothing here may stop the
// readings, the tray or the notifications: every failure is logged and swallowed.
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { itemsFor, lineFor } = require('./taskbar-model');

const WRAPPED = ['upsertDevice', 'removeDevice', 'mergeDevices', 'moveDevice', 'reorderDevices', 'setSettings'];
const ORIGINAL = Symbol('taskbar original');
const BATCH_MS = 50;
const GIVE_UP_AFTER = 5;          // exits in a row
const STEADY_RUN_MS = 60 * 1000;  // a run this long resets the count
const LEVELS = /^(WARN|INFO|ERROR) (.*)$/;
// What the exe prints is not trusted: anything a log viewer could take as a line break or a control
// (a lone CR, NEL, U+2028, U+2029, other C0/C1 controls) becomes a space, so one exe line is one log line.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

let s = null; // state of the current start(); null before start

function log(tag, msg) {
  try { s.logLine(tag, `taskbar: ${msg}`); } catch (_) {}
}

function start(opts) {
  if (s) stop();
  const o = opts || {};
  s = {
    store: o.store,
    logLine: o.logLine || (() => {}),
    spawn: o.spawn || childProcess.spawn,
    exePath: o.exePath || path.join(__dirname, 'taskbar-battery.exe'),
    assetsDir: o.assetsDir || path.join(__dirname, '..', '..', 'assets', 'taskbar'),
    now: o.now || Date.now,
    setTimer: o.setTimer || setTimeout,
    clearTimer: o.clearTimer || clearTimeout,
    stopped: false,
    available: false,
    since: 0,
    batchTimer: null,
    restartTimer: null,
    child: null,
    startedAt: 0,
    crashes: 0,
    gaveUp: false,
    line: null,      // the line the exe should be showing
    sentLine: null,  // what the running exe was last sent
  };
  s.since = s.now();
  const platform = o.platform || process.platform;
  const exists = o.exists || fs.existsSync;
  let found = false;
  try { found = platform === 'win32' && exists(s.exePath); } catch (_) {}
  if (!found) {
    log('INFO', `${s.exePath} is not there (${platform}); taskbar battery levels are off`);
    return;
  }
  s.available = true;
  wrapStore(s.store);
  const mine = s;
  try { if (o.app && typeof o.app.on === 'function') o.app.on('will-quit', () => { if (s === mine) stop(); }); } catch (_) {}
  refresh();
}

function wrapStore(store) {
  for (const name of WRAPPED) {
    const current = store && store[name];
    if (typeof current !== 'function') continue;
    const original = current[ORIGINAL] || current;
    const wrapped = function (...args) {
      try { return original.apply(this, args); } finally { refresh(); }
    };
    wrapped[ORIGINAL] = original;
    store[name] = wrapped;
  }
}

// Batches bursts of store writes: one getDevices() per BATCH_MS.
function refresh() {
  try {
    if (!s || s.stopped || !s.available || s.batchTimer) return;
    s.batchTimer = s.setTimer(update, BATCH_MS);
  } catch (e) {
    log('ERROR', `refresh failed: ${e && e.message || e}`);
  }
}

function update() {
  if (!s || s.stopped) return;
  s.batchTimer = null;
  try {
    const settings = s.store.getSettings() || {};
    if (settings.taskbarBattery !== true) {
      turnOff();
      return;
    }
    s.line = lineFor(itemsFor(s.store.getDevices(), settings, s.since));
    if (s.child) send();
    else if (!s.restartTimer && !s.gaveUp) launch();
  } catch (e) {
    log('ERROR', `update failed: ${e && e.stack || e}`);
  }
}

function turnOff() {
  kill();
  if (s.restartTimer) { s.clearTimer(s.restartTimer); s.restartTimer = null; }
  s.crashes = 0;
  s.gaveUp = false;
}

function launch() {
  s.restartTimer = null;
  if (s.stopped || s.child) return;
  let child;
  try {
    child = s.spawn(s.exePath, ['--parent', String(process.pid), '--assets', s.assetsDir], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    s.startedAt = s.now();
    crashed(`could not start: ${e && e.message || e}`);
    return;
  }
  s.child = child;
  s.startedAt = s.now();
  s.sentLine = null;
  let done = false;
  const gone = (why) => {
    if (done) return;
    done = true;
    if (s && s.child === child) {
      s.child = null;
      try { child.kill(); } catch (_) {}
      crashed(why);
    }
  };
  child.on('error', (e) => gone(`error: ${e && e.message || e}`));
  child.on('exit', (code, signal) => gone(`exited (code ${code}, signal ${signal})`));
  if (child.stdin) child.stdin.on('error', (e) => gone(`stdin: ${e && e.message || e}`));
  readLines(child.stdout);
  readLines(child.stderr);
  send();
}

function crashed(why) {
  if (s.now() - s.startedAt >= STEADY_RUN_MS) s.crashes = 0;
  s.crashes += 1;
  if (s.crashes >= GIVE_UP_AFTER) {
    s.gaveUp = true;
    log('ERROR', `${why}; gave up after ${s.crashes} tries in a row (turn the setting off and on to try again)`);
    return;
  }
  const wait = 1000 * 2 ** (s.crashes - 1);
  log('INFO', `${why}; starting again in ${wait / 1000}s`);
  s.restartTimer = s.setTimer(launch, wait);
}

function send() {
  const child = s.child;
  if (!child || s.line === null || s.line === s.sentLine) return;
  try {
    child.stdin.write(`${s.line}\n`);
    s.sentLine = s.line;
  } catch (e) {
    // same as the exe having ended: drop it and let the restart resend the line
    child.emit('error', e);
  }
}

function readLines(stream) {
  if (!stream) return;
  if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '').replace(UNSAFE, ' ');
      if (!line.trim()) continue;
      const m = LEVELS.exec(line);
      if (m) log(m[1], m[2]);
      else log('INFO', line);
    }
  });
  stream.on('error', () => {});
}

function kill() {
  const child = s.child;
  if (!child) return;
  s.child = null; // its exit is no longer a crash
  try { child.stdin.end(); } catch (_) {}
  try { child.kill(); } catch (_) {}
}

// Stops the exe and the timers for good (will-quit). start() begins again.
function stop() {
  if (!s) return;
  s.stopped = true;
  if (s.batchTimer) { try { s.clearTimer(s.batchTimer); } catch (_) {} s.batchTimer = null; }
  if (s.restartTimer) { try { s.clearTimer(s.restartTimer); } catch (_) {} s.restartTimer = null; }
  kill();
}

module.exports = { start, refresh, stop };
