// Starting taskbar-battery.exe, sending it the list, restarting it (fork Issue #16).
// Everything outside the module is faked: the child process, the clock, the store and the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const taskbar = require('../src/main/taskbar');

const START = 100000;

function harness({ settings = {}, devices = {}, exists = true, platform = 'win32', spawnThrows = false } = {}) {
  const h = { t: START, timers: [], spawned: [], logs: [], getDevicesCalls: 0 };
  h.settings = { ...settings };
  h.devices = devices;
  h.store = {
    getDevices: () => { h.getDevicesCalls += 1; return structuredClone(h.devices); },
    getSettings: () => ({ ...h.settings }),
    upsertDevice: (id, patch) => { h.devices[id] = { ...(h.devices[id] || {}), ...patch, id }; return { ...h.devices[id] }; },
    removeDevice: (id) => { delete h.devices[id]; },
    mergeDevices: (keepId, dropId) => { delete h.devices[dropId]; },
    moveDevice: (fromId, toId) => { h.devices[toId] = { ...h.devices[fromId], id: toId }; delete h.devices[fromId]; },
    reorderDevices: (ids) => { ids.forEach((id, i) => { if (h.devices[id]) h.devices[id].order = i; }); return structuredClone(h.devices); },
    setSettings: (patch) => { Object.assign(h.settings, patch); return { ...h.settings }; },
  };
  h.app = new EventEmitter();
  h.spawn = (file, args, opts) => {
    if (spawnThrows) throw new Error('spawn failed');
    const child = new EventEmitter();
    child.file = file; child.args = args; child.opts = opts;
    child.writes = []; child.ended = false; child.killed = false;
    child.stdin = new EventEmitter();
    child.stdin.write = (s) => { child.writes.push(s); return true; };
    child.stdin.end = () => { child.ended = true; };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; return true; };
    h.spawned.push(child);
    return child;
  };
  h.setTimer = (fn, ms) => { const timer = { at: h.t + ms, fn, done: false }; h.timers.push(timer); return timer; };
  h.clearTimer = (timer) => { if (timer) timer.done = true; };
  h.advance = (ms) => {
    const end = h.t + ms;
    for (;;) {
      const due = h.timers.filter((x) => !x.done && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      h.t = due.at; due.done = true; due.fn();
    }
    h.t = end;
  };
  h.start = () => taskbar.start({
    store: h.store, logLine: (tag, msg) => h.logs.push([tag, msg]), app: h.app,
    spawn: h.spawn, exists: () => exists, platform, exePath: 'C:\\x\\taskbar-battery.exe', assetsDir: 'C:\\x\\assets\\taskbar',
    now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer,
  });
  h.last = () => h.spawned[h.spawned.length - 1];
  h.live = () => h.spawned.filter((c) => !c.killed && !c.exited);
  return h;
}

// A device read after start, so the model shows it.
const mouse = (capacity, extra = {}) => ({
  id: 'm', product: 'G502 Mouse', online: true, lastReading: { capacity, charging: false }, lastReadingAt: START + 1, ...extra,
});
const lineOf = (...items) => `${JSON.stringify({ devices: items })}\n`;
const item = (icon, level, charging = false) => ({ icon, level, charging, low: level <= 20 });

function exit(child, code = 1) { child.exited = true; child.emit('exit', code, null); }

test.afterEach(() => taskbar.stop());

test('off by default: no exe is started', () => {
  const h = harness({ settings: {}, devices: { m: mouse(50) } });
  h.start();
  h.advance(1000);
  h.store.upsertDevice('m', { lastReading: { capacity: 40, charging: false }, lastReadingAt: START + 2 });
  h.advance(1000);
  assert.equal(h.spawned.length, 0);
  assert.equal(h.getDevicesCalls, 0);
});

test('turning it on starts the exe with --parent and --assets, and sends the line', () => {
  const h = harness({ devices: { m: mouse(82) } });
  h.start();
  h.advance(100);
  assert.equal(h.spawned.length, 0);
  h.store.setSettings({ taskbarBattery: true });
  h.advance(50);
  assert.equal(h.spawned.length, 1);
  const child = h.last();
  assert.equal(child.file, 'C:\\x\\taskbar-battery.exe');
  assert.deepEqual(child.args, ['--parent', String(process.pid), '--assets', 'C:\\x\\assets\\taskbar']);
  assert.equal(child.opts.windowsHide, true);
  assert.deepEqual(child.opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(child.writes, [lineOf(item('mouse', 82))]);
});

test('already on at start: starts after the first refresh', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  assert.equal(h.spawned.length, 0); // not inside start() itself
  h.advance(50);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 82))]);
});

test('the same line is not sent twice; a changed line is sent', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const child = h.last();
  // a write that doesn't change what is shown
  h.store.upsertDevice('m', { lastReadingAt: START + 5 });
  h.advance(50);
  assert.equal(child.writes.length, 1);
  h.store.upsertDevice('m', { lastReading: { capacity: 18, charging: true }, lastReadingAt: START + 6 });
  h.advance(50);
  assert.deepEqual(child.writes, [lineOf(item('mouse', 82)), lineOf(item('mouse', 18, true))]);
  // device gone → an empty list is sent once
  h.store.removeDevice('m');
  h.advance(50);
  h.store.reorderDevices([]);
  h.advance(50);
  assert.deepEqual(child.writes.slice(2), [lineOf()]);
  assert.equal(h.spawned.length, 1);
});

test('sortMode change re-sorts and resends', () => {
  const h = harness({
    settings: { taskbarBattery: true },
    devices: {
      a: { ...mouse(10), id: 'a', product: 'K2 Keyboard', order: 2 },
      b: { ...mouse(90), id: 'b', product: 'G502 Mouse', order: 1 },
    },
  });
  h.start();
  h.advance(50);
  h.store.setSettings({ sortMode: 'manual' });
  h.advance(50);
  assert.deepEqual(h.last().writes, [
    lineOf(item('keyboard', 10), item('mouse', 90)),
    lineOf(item('mouse', 90), item('keyboard', 10)),
  ]);
});

test('turning it off stops the exe', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const child = h.last();
  h.store.setSettings({ taskbarBattery: false });
  h.advance(50);
  assert.equal(child.ended, true);
  assert.equal(child.killed, true);
  exit(child, null); // the kill lands: not a crash
  h.advance(60000);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.logs.filter(([tag]) => tag === 'ERROR').length, 0);
  // on again: a fresh exe gets the current line
  h.store.setSettings({ taskbarBattery: true });
  h.advance(50);
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 82))]);
});

test('app will-quit stops the exe', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const child = h.last();
  h.app.emit('will-quit');
  assert.equal(child.ended, true);
  assert.equal(child.killed, true);
  exit(child, null);
  // late store writes during shutdown don't bring it back
  h.store.upsertDevice('m', { lastReading: { capacity: 70, charging: false }, lastReadingAt: START + 9 });
  h.advance(60000);
  assert.equal(h.spawned.length, 1);
});

test('will-quit before the first refresh: nothing is started', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.app.emit('will-quit');
  h.advance(60000);
  assert.equal(h.spawned.length, 0);
});

test('store writes in a burst read the devices once', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  assert.equal(h.getDevicesCalls, 1);
  for (let i = 0; i < 10; i++) h.store.upsertDevice('m', { lastReading: { capacity: 80 - i, charging: false }, lastReadingAt: START + 10 + i });
  assert.equal(h.getDevicesCalls, 1);
  h.advance(49);
  assert.equal(h.getDevicesCalls, 1);
  h.advance(1);
  assert.equal(h.getDevicesCalls, 2);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 82)), lineOf(item('mouse', 71))]);
});

test('wrapped store functions return what the originals return', () => {
  const h = harness({ devices: { m: mouse(82) } });
  const originals = { ...h.store };
  h.start();
  for (const name of ['upsertDevice', 'removeDevice', 'mergeDevices', 'moveDevice', 'reorderDevices', 'setSettings']) {
    assert.notEqual(h.store[name], originals[name], `${name} is wrapped`);
  }
  assert.deepEqual(h.store.upsertDevice('m', { customName: 'x' }), { ...h.devices.m });
  assert.deepEqual(h.store.reorderDevices(['m']), structuredClone(h.devices));
  assert.deepEqual(h.store.setSettings({ sortMode: 'manual' }), { sortMode: 'manual' });
  assert.equal(h.store.removeDevice('m'), undefined);
  // a throwing original still throws
  taskbar.stop();
  const h2 = harness({});
  h2.store.upsertDevice = () => { throw new Error('disk full'); };
  h2.start();
  assert.throws(() => h2.store.upsertDevice('x', {}), /disk full/);
});

test('starting again does not wrap the store twice', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  h.start();
  h.advance(50);
  // the first exe was stopped, one exe runs now
  assert.equal(h.live().length, 1);
  taskbar.stop();
  // stop leaves the wrapper in place but inert; a third start wraps the original, not the wrapper
  h.start();
  h.store.upsertDevice('m', { lastReading: { capacity: 30, charging: false }, lastReadingAt: h.t + 1 }); // read since this start
  h.advance(50);
  assert.equal(h.live().length, 1);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 30))]);
});

test('exe missing or not Windows: never spawns, logs INFO once, no throw', () => {
  for (const opts of [{ exists: false }, { platform: 'linux' }]) {
    const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) }, ...opts });
    assert.doesNotThrow(() => h.start());
    h.advance(50);
    h.store.setSettings({ taskbarBattery: false });
    h.advance(50);
    h.store.setSettings({ taskbarBattery: true });
    h.advance(50);
    h.store.upsertDevice('m', { lastReading: { capacity: 30, charging: false } });
    h.advance(60000);
    assert.equal(h.spawned.length, 0);
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0][0], 'INFO');
    assert.match(h.logs[0][1], /^taskbar: /);
    // the store still works through any wrapper
    assert.deepEqual(h.store.setSettings({ x: 1 }).x, 1);
    taskbar.stop();
  }
});

test('exe exits unexpectedly: restarts after 1s and resends the last line', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  exit(h.last(), 3);
  h.advance(999);
  assert.equal(h.spawned.length, 1);
  h.advance(1);
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 82))]);
  assert.ok(h.logs.some(([tag, msg]) => /^taskbar: /.test(msg) && /3/.test(msg)), 'the exit is logged');
});

test('a change while the exe is down is what gets sent on restart', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  exit(h.last(), 1);
  h.store.upsertDevice('m', { lastReading: { capacity: 60, charging: false }, lastReadingAt: START + 30 });
  h.advance(50);
  assert.equal(h.spawned.length, 1); // no extra spawn before the back-off
  h.advance(950);
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 60))]);
});

test('quick exits restart 4 times (1s, 2s, 4s, 8s); the 5th exit gives up and logs ERROR once; off then on tries again', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const waits = [1000, 2000, 4000, 8000];
  for (const wait of waits) {
    const before = h.spawned.length;
    exit(h.last(), 1);
    h.advance(wait - 1);
    assert.equal(h.spawned.length, before, `not before ${wait}ms`);
    h.advance(1);
    assert.equal(h.spawned.length, before + 1, `restarted after ${wait}ms`);
  }
  assert.equal(h.spawned.length, 5);
  exit(h.last(), 1);
  h.advance(10 * 60 * 1000);
  assert.equal(h.spawned.length, 5);
  assert.equal(h.logs.filter(([tag]) => tag === 'ERROR').length, 1);
  // more store writes don't bring it back or log again
  h.store.upsertDevice('m', { lastReading: { capacity: 50, charging: false }, lastReadingAt: START + 40 });
  h.advance(50);
  assert.equal(h.spawned.length, 5);
  assert.equal(h.logs.filter(([tag]) => tag === 'ERROR').length, 1);
  // off then on: tries again, with a fresh count
  h.store.setSettings({ taskbarBattery: false });
  h.advance(50);
  h.store.setSettings({ taskbarBattery: true });
  h.advance(50);
  assert.equal(h.spawned.length, 6);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 50))]);
  exit(h.last(), 1);
  h.advance(1000);
  assert.equal(h.spawned.length, 7);
});

test('turning it off during the back-off cancels the restart', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  exit(h.last(), 1);
  h.store.setSettings({ taskbarBattery: false });
  h.advance(60000);
  assert.equal(h.spawned.length, 1);
});

test('a run of 60s or more resets the crash count', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  exit(h.last(), 1); // n = 1
  h.advance(1000);
  exit(h.last(), 1); // n = 2
  h.advance(2000);
  assert.equal(h.spawned.length, 3);
  h.advance(60000); // ran 60s
  exit(h.last(), 1); // back to n = 1: 1s wait
  h.advance(1000);
  assert.equal(h.spawned.length, 4);
  h.advance(59999); // just short of 60s
  exit(h.last(), 1); // n = 2: 2s wait
  h.advance(1999);
  assert.equal(h.spawned.length, 4);
  h.advance(1);
  assert.equal(h.spawned.length, 5);
});

test('stdin error (EPIPE) is treated like an exit, not thrown', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const child = h.last();
  const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  assert.doesNotThrow(() => child.stdin.emit('error', err));
  // the exit that follows is the same crash, not a second one
  exit(child, 1);
  h.advance(999);
  assert.equal(h.spawned.length, 1);
  h.advance(1);
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 82))]);
  // the next crash waits 2s: one crash was counted, not two
  exit(h.last(), 1);
  h.advance(1999);
  assert.equal(h.spawned.length, 2);
  h.advance(1);
  assert.equal(h.spawned.length, 3);
});

test('a write that throws is treated like an exit, not thrown', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const child = h.last();
  child.stdin.write = () => { throw new Error('write after end'); };
  h.store.upsertDevice('m', { lastReading: { capacity: 40, charging: false }, lastReadingAt: START + 50 });
  assert.doesNotThrow(() => h.advance(50));
  assert.equal(child.killed, true);
  h.advance(1000);
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.last().writes, [lineOf(item('mouse', 40))]);
});

test('spawn error event and a throwing spawn are treated like an exit', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const child = h.last();
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' })));
  exit(child, null); // an exit after the error doesn't count twice
  h.advance(1000);
  assert.equal(h.spawned.length, 2);
  exit(h.last(), 1);
  h.advance(1999);
  assert.equal(h.spawned.length, 2);
  h.advance(1);
  assert.equal(h.spawned.length, 3);

  taskbar.stop();
  const h2 = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) }, spawnThrows: true });
  h2.start();
  assert.doesNotThrow(() => h2.advance(10 * 60 * 1000));
  assert.equal(h2.logs.filter(([tag]) => tag === 'ERROR').length, 1); // gave up after 5 tries
});

test('a failing refresh is logged, never thrown into the store caller', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.store.getDevices = () => { throw new Error('bad store'); };
  assert.doesNotThrow(() => h.store.upsertDevice('m', { customName: 'x' }));
  assert.doesNotThrow(() => h.advance(50));
  assert.ok(h.logs.some(([tag, msg]) => tag === 'ERROR' && /^taskbar: /.test(msg) && /bad store/.test(msg)));
});

test('stdout WARN/INFO/ERROR lines go to logLine with the same level, prefixed "taskbar: "', () => {
  const h = harness({ settings: { taskbarBattery: true }, devices: { m: mouse(82) } });
  h.start();
  h.advance(50);
  const child = h.last();
  h.logs.length = 0;
  child.stdout.emit('data', Buffer.from('WARN no room left of the tray\r\nINFO sho'));
  child.stdout.emit('data', 'wing again\nERROR boom\nsomething else\n');
  child.stderr.emit('data', 'ERROR from stderr\n');
  assert.deepEqual(h.logs, [
    ['WARN', 'taskbar: no room left of the tray'],
    ['INFO', 'taskbar: showing again'],
    ['ERROR', 'taskbar: boom'],
    ['INFO', 'taskbar: something else'],
    ['ERROR', 'taskbar: from stderr'],
  ]);
});
