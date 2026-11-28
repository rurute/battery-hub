// Which devices the taskbar shows, in what order, and how (fork Issue #16).
const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleDevices, itemsFor, iconName, lineFor, LOW_AT, READS_BEFORE_REPORT, ICON_PATHS } = require('../src/main/taskbar-model');

const SINCE = 1000;

function dev({ id, capacity, charging = false, at, online = true, hidden = false, failedReads = 0, order, product = 'Thing', driverId, customIcon, alertThreshold }) {
  return {
    id, product, driverId, customIcon, hidden, online, order, failedReads, alertThreshold,
    lastReading: { capacity, charging },
    lastReadingAt: at,
  };
}

test('constants', () => {
  assert.equal(LOW_AT, 20);
  assert.equal(READS_BEFORE_REPORT, 3);
  for (const name of ['mouse', 'keyboard', 'headset', 'mic', 'speaker', 'camera', 'controller', 'pen', 'plug', 'flash']) {
    assert.equal(typeof ICON_PATHS[name], 'string', name);
  }
});
test('shows only devices read since start, online, not hidden, readable', () => {
  const d = {
    ok:      dev({ id: 'ok', capacity: 50, at: 2000 }),
    before:  dev({ id: 'before', capacity: 50, at: 999 }),      // read before this launch
    off:     dev({ id: 'off', capacity: 50, at: 2000, online: false }),
    hidden:  dev({ id: 'hidden', capacity: 50, at: 2000, hidden: true }),
    failing: dev({ id: 'failing', capacity: 50, at: 2000, failedReads: 3 }),
    once:    dev({ id: 'once', capacity: 50, at: 2000, failedReads: 2 }),
    none:    dev({ id: 'none', capacity: null, at: 2000 }),
  };
  assert.deepEqual(visibleDevices(d, { sortMode: 'urgent' }, SINCE).map((x) => x.id).sort(), ['ok', 'once']);
});
test('a device with no reading or no read time is not shown', () => {
  const d = {
    noReading: { id: 'noReading', online: true, lastReading: null, lastReadingAt: 2000 },
    noTime: { id: 'noTime', online: true, lastReading: { capacity: 50, charging: false } },
  };
  assert.deepEqual(visibleDevices(d, {}, SINCE), []);
  assert.deepEqual(visibleDevices({}, {}, SINCE), []);
});
test('a device read exactly at start is shown', () => {
  assert.deepEqual(visibleDevices({ a: dev({ id: 'a', capacity: 50, at: SINCE }) }, {}, SINCE).map((x) => x.id), ['a']);
});
test('urgent order matches the cards: draining first, then charging', () => {
  const d = { c10: dev({ id: 'c10', capacity: 10, charging: true, at: 2000 }), d80: dev({ id: 'd80', capacity: 80, at: 2000 }) };
  assert.deepEqual(visibleDevices(d, { sortMode: 'urgent' }, SINCE).map((x) => x.id), ['d80', 'c10']);
});
test('urgent is the default order', () => {
  const d = { c10: dev({ id: 'c10', capacity: 10, charging: true, at: 2000 }), d80: dev({ id: 'd80', capacity: 80, at: 2000 }) };
  assert.deepEqual(visibleDevices(d, {}, SINCE).map((x) => x.id), ['d80', 'c10']);
});
test('manual order follows order', () => {
  const d = { a: dev({ id: 'a', capacity: 10, at: 2000, order: 2 }), b: dev({ id: 'b', capacity: 90, at: 2000, order: 1 }) };
  assert.deepEqual(visibleDevices(d, { sortMode: 'manual' }, SINCE).map((x) => x.id), ['b', 'a']);
});
test('low is 20 or below, also while charging', () => {
  const lvl = (capacity, charging = false) => itemsFor({ x: dev({ id: 'x', capacity, charging, at: 2000 }) }, {}, SINCE)[0].low;
  assert.equal(lvl(20), true); assert.equal(lvl(21), false); assert.equal(lvl(0), true); assert.equal(lvl(15, true), true);
});
test('low ignores the notification thresholds', () => {
  const low = (capacity, alertThreshold, notifyThreshold) =>
    itemsFor({ x: dev({ id: 'x', capacity, at: 2000, alertThreshold }) }, { notifyThreshold }, SINCE)[0].low;
  assert.equal(low(15, undefined, 10), true);   // below 20 even if notifications fire at 10
  assert.equal(low(25, undefined, 30), false);  // above 20 even if notifications fire at 30
  assert.equal(low(25, 40, 20), false);         // a device's own alert level doesn't count
  assert.equal(low(20, 5, 5), true);
});
test('levels are clamped to whole numbers 0..100', () => {
  const lv = (capacity) => itemsFor({ x: dev({ id: 'x', capacity, at: 2000 }) }, {}, SINCE)[0].level;
  assert.equal(lv(-1), 0); assert.equal(lv(101), 100); assert.equal(lv(49.6), 50);
});
test('items carry the icon name and charging flag', () => {
  const items = itemsFor({
    m: dev({ id: 'm', capacity: 82, at: 2000, product: 'G502 Mouse' }),
    h: dev({ id: 'h', capacity: 45, charging: true, at: 2000, customIcon: '🎧' }),
  }, { sortMode: 'urgent' }, SINCE);
  assert.deepEqual(items, [
    { icon: 'mouse', level: 82, charging: false, low: false },
    { icon: 'headset', level: 45, charging: true, low: false },
  ]);
});
test('icon names match the window', () => {
  assert.equal(iconName({ customIcon: 'keyboard' }), 'keyboard');
  assert.equal(iconName({ customIcon: '🎧' }), 'headset');            // old saved emoji
  assert.equal(iconName({ product: 'G502 Mouse' }), 'mouse');         // guessed
  assert.equal(iconName({ customIcon: 'nonsense', product: 'X' }), 'plug');
});
test('line format', () => {
  assert.equal(lineFor([{ icon: 'mouse', level: 82, charging: false, low: false }, { icon: 'headset', level: 18, charging: true, low: true }]),
    '{"devices":[{"icon":"mouse","level":82,"charging":false,"low":false},{"icon":"headset","level":18,"charging":true,"low":true}]}');
  assert.equal(lineFor([]), '{"devices":[]}');
});
