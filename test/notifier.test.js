const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const sent = [];
let settings = {};
class Notification {
  constructor(options) { this.options = options; }
  static isSupported() { return true; }
  show() { sent.push(this.options); }
}

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { Notification };
  if (request === './store') return { getSettings: () => settings };
  return load.call(this, request, ...rest);
};
const notifier = require('../src/main/notifier');
Module._load = load;

const device = (capacity, charging = false, extra = {}) => ({ id: 'd', product: 'Mouse', online: true, lastReading: { capacity, charging }, ...extra });

test.beforeEach(() => {
  sent.length = 0;
  settings = { notifyEnabled: true, notifyThreshold: 20, notifyCharging: true, notifyCharged: true };
  notifier.reset('d');
});

test('low battery fires once per crossing, and again after recovering', () => {
  [50, 20, 15, 10].forEach((c) => notifier.check(device(c)));
  assert.deepEqual(sent.map((n) => n.title), ['Low battery']);
  assert.match(sent[0].body, /Mouse is at 20%/);
  assert.match(sent[0].icon, /mood-low\.png$/);
  notifier.check(device(60));
  notifier.check(device(18));
  assert.equal(sent.length, 2);
});

test('a reading wobbling around the alert level alerts only once', () => {
  [22, 20, 21, 20, 22, 19, 24, 20].forEach((c) => notifier.check(device(c)));
  assert.equal(sent.length, 1);
  notifier.check(device(25));
  notifier.check(device(20));
  assert.equal(sent.length, 2);
});

test('charging ends the low state, so unplugging while still low alerts again', () => {
  notifier.check(device(15));
  notifier.check(device(16, true));
  notifier.check(device(17));
  assert.deepEqual(sent.map((n) => n.title).filter((t) => t === 'Low battery'), ['Low battery', 'Low battery']);
});

test('low battery stays quiet while charging, offline or switched off', () => {
  notifier.check(device(10, true));
  notifier.check(device(10, false, { online: false }));
  settings.notifyEnabled = false;
  notifier.check(device(10));
  assert.equal(sent.length, 0);
});

test('charging fires when charging starts, only if enabled', () => {
  notifier.check(device(40));
  notifier.check(device(40, true));
  assert.deepEqual(sent.map((n) => n.title), ['Charging']);
  assert.match(sent[0].icon, /mood-charge\.png$/);
  notifier.reset('d');
  sent.length = 0;
  settings.notifyCharging = false;
  notifier.check(device(40));
  notifier.check(device(40, true));
  assert.equal(sent.length, 0);
});

test('a device already charging at startup stays quiet', () => {
  notifier.check(device(40, true));
  notifier.check(device(41, true));
  assert.equal(sent.length, 0);
});

test('a loose cable does not repeat the charging alert', () => {
  [40, 40].forEach((c) => { notifier.check(device(c)); notifier.check(device(c, true)); });
  assert.equal(sent.length, 1);
});

test('fully charged fires when charging ends near full, only if enabled', () => {
  settings.notifyCharging = false;
  notifier.check(device(90, true));
  notifier.check(device(97));
  assert.deepEqual(sent.map((n) => n.title), ['Fully charged']);
  sent.length = 0;
  notifier.check(device(90, true));
  notifier.check(device(80));
  assert.equal(sent.length, 0);
  settings.notifyCharged = false;
  notifier.check(device(90, true));
  notifier.check(device(97));
  assert.equal(sent.length, 0);
});

test('every alert has a title, a message and an icon', () => {
  for (const make of Object.values(notifier.ALERTS)) {
    const alert = make('Mouse', 50);
    assert.ok(alert.title && alert.body.includes('Mouse') && alert.icon);
  }
});

test('a device with its own alert level uses it instead of the one in Settings', () => {
  notifier.check(device(40, false, { alertThreshold: 30 }));
  notifier.check(device(30, false, { alertThreshold: 30 }));
  assert.deepEqual(sent.map((n) => n.title), ['Low battery']);
  notifier.reset('d');
  sent.length = 0;
  [40, 25, 21].forEach((c) => notifier.check(device(c, false, { alertThreshold: null })));
  assert.equal(sent.length, 0);
  notifier.check(device(20, false, { alertThreshold: null }));
  assert.equal(sent.length, 1);
});

// ---- Old reading alert (#182): a device read only now and then, e.g. a headset read over Bluetooth
// but used over a dongle that reports nothing. Off by default, on per device, real readings only.
const DAY = 24 * 3600000;
const NOW = Date.parse('2026-11-25T12:00:00Z');
const stale = (extra = {}) => ({
  id: 'h', product: 'Fuxi-H6', online: false, lastReading: { capacity: 100, charging: false },
  lastReadingAt: NOW - 3 * DAY, staleAlertDays: 2, ...extra,
});

test('a reading older than the device\'s limit alerts once, naming its age', () => {
  const patch = notifier.checkStale(stale(), NOW);
  assert.deepEqual(sent.map((n) => n.title), ['Old reading']);
  assert.equal(sent[0].body, 'Fuxi-H6: last reading 3 days ago. Connect it in a way Battery Hub can read, like Bluetooth, to update it.');
  assert.deepEqual(patch, { staleAlertedFor: NOW - 3 * DAY }, 'which reading was alerted is kept on the device');
});

test('the same reading never alerts twice, also after a restart', () => {
  const alerted = stale({ staleAlertedFor: NOW - 3 * DAY }); // what the store keeps across restarts
  assert.equal(notifier.checkStale(alerted, NOW), null);
  assert.equal(notifier.checkStale(alerted, NOW + 5 * DAY), null);
  assert.equal(sent.length, 0);
});

test('a new reading that gets old alerts again', () => {
  const fresh = stale({ staleAlertedFor: NOW - 3 * DAY, lastReadingAt: NOW - 1 * DAY });
  assert.equal(notifier.checkStale(fresh, NOW), null, 'one day old, under the two-day limit');
  assert.deepEqual(notifier.checkStale(fresh, NOW + 1 * DAY + 1), { staleAlertedFor: NOW - 1 * DAY });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /last reading 2 days ago/);
});

test('the old reading alert stays quiet when off or without a real reading', () => {
  notifier.checkStale(stale({ staleAlertDays: 0 }), NOW);                  // off for this device
  notifier.checkStale(stale({ staleAlertDays: null }), NOW);               // follows Settings, off by default
  notifier.checkStale(stale({ hidden: true }), NOW);                       // hidden
  notifier.checkStale(stale({ lastReading: null, lastReadingAt: null }), NOW); // never read
  notifier.checkStale(stale(), NOW - 2 * DAY);                             // only one day old then
  assert.equal(sent.length, 0);
});

test('turned on in Settings, it covers every device that follows Settings', () => {
  settings.notifyStale = true;
  settings.notifyStaleDays = 2;
  assert.deepEqual(notifier.checkStale(stale({ staleAlertDays: null }), NOW), { staleAlertedFor: NOW - 3 * DAY });
  assert.deepEqual(notifier.checkStale(stale({ id: 'k', staleAlertDays: undefined }), NOW), { staleAlertedFor: NOW - 3 * DAY });
  assert.equal(sent.length, 2);
  settings.notifyStaleDays = 4;                                            // a longer limit in Settings
  assert.equal(notifier.checkStale(stale({ id: 'm', staleAlertDays: null }), NOW), null);
});

test('a device can switch it off or set its own days, whatever Settings say', () => {
  settings.notifyStale = true;
  settings.notifyStaleDays = 2;
  assert.equal(notifier.checkStale(stale({ staleAlertDays: 0 }), NOW), null, 'off for this device');
  assert.equal(notifier.checkStale(stale({ staleAlertDays: 5 }), NOW), null, 'its own 5 days, not yet');
  settings.notifyStale = false;
  assert.ok(notifier.checkStale(stale({ staleAlertDays: 2 }), NOW), 'its own 2 days alert with Settings off');
  assert.equal(sent.length, 1);
});

test('the old reading alert has its own switch, apart from the low battery one', () => {
  settings.notifyEnabled = false;                                          // low battery alerts off
  assert.ok(notifier.checkStale(stale({ staleAlertDays: 2 }), NOW));
});

test('one day old says "1 day"', () => {
  notifier.checkStale(stale({ staleAlertDays: 1, lastReadingAt: NOW - 1 * DAY - 60000 }), NOW);
  assert.match(sent[0].body, /last reading 1 day ago/);
});

test("a device's days: empty follows Settings, 0 is off, else 1 to 14", () => {
  assert.equal(notifier.staleDaysOf(null), null);
  assert.equal(notifier.staleDaysOf(undefined), null);
  assert.equal(notifier.staleDaysOf(''), null);
  assert.equal(notifier.staleDaysOf('abc'), null);
  assert.equal(notifier.staleDaysOf(0), 0);
  assert.equal(notifier.staleDaysOf(2), 2);
  assert.equal(notifier.staleDaysOf('3'), 3);
  assert.equal(notifier.staleDaysOf(2.6), 3);
  assert.equal(notifier.staleDaysOf(30), 14);
  assert.equal(notifier.staleDaysOf(-4), 0);
});
