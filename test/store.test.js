const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// store.js keeps the devices and settings in memory: it hands out copies and writes only on a change.
class FakeStore {
  constructor({ defaults }) { this.data = structuredClone(defaults); this.data.uiV2 = true; this.gets = 0; this.sets = 0; }
  get(key) { this.gets += 1; return structuredClone(this.data[key]); }
  set(key, value) { this.sets += 1; this.data[key] = structuredClone(value); }
}
let fake = null;
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron-store') return class extends FakeStore { constructor(o) { super(o); fake = this; } };
  return load.call(this, request, ...rest);
};
const store = require('../src/main/store');
Module._load = load;

test('store: reads come from memory, and a change made to a copy never reaches the store', () => {
  store.upsertDevice('a', { product: 'Mouse', lastReading: { capacity: 50 } });
  const gets = fake.gets;
  const copy = store.getDevices();
  copy.a.product = 'changed';
  copy.a.lastReading.capacity = 1;
  assert.equal(store.getDevices().a.product, 'Mouse');
  assert.equal(store.getDevices().a.lastReading.capacity, 50);
  assert.equal(fake.gets, gets, 'no file read once loaded');
  const returned = store.upsertDevice('a', {});
  returned.product = 'changed again';
  assert.equal(store.getDevices().a.product, 'Mouse');
});

test('store: an update that changes nothing writes nothing', () => {
  store.upsertDevice('b', { product: 'Keyboard', identity: 'mac:001122334455' });
  const sets = fake.sets;
  store.upsertDevice('b', { identity: 'mac:001122334455' });
  assert.equal(fake.sets, sets);
  store.upsertDevice('b', { identity: 'mac:665544332211' });
  assert.equal(fake.sets, sets + 1);
  assert.equal(fake.data.devices.b.identity, 'mac:665544332211');
});

test('store: settings are cached, merged with defaults, and written only on a change', () => {
  const sets = fake.sets;
  assert.equal(store.getSetting('pollIntervalSec'), 60);
  store.setSettings({ pollIntervalSec: 60 });
  assert.equal(fake.sets, sets);
  store.setSettings({ pollIntervalSec: 30 });
  assert.equal(fake.sets, sets + 1);
  assert.equal(store.getPollIntervalSec(), 30);
  const all = store.getSettings();
  all.confirmedDevices.x = 1;
  assert.deepEqual(store.getSetting('confirmedDevices'), {});
});

test('store: remove, move, merge and reorder keep memory and file in step', () => {
  store.upsertDevice('c', { product: 'C', order: 2 });
  store.upsertDevice('d', { product: 'D', order: 1, lastReadingAt: 5, lastReading: { capacity: 9 } });
  store.mergeDevices('c', 'd');
  assert.equal(store.getDevices().d, undefined);
  assert.equal(store.getDevices().c.lastReading.capacity, 9);
  store.moveDevice('c', 'e', { driverId: 'x' });
  assert.equal(store.getDevices().e.driverId, 'x');
  store.reorderDevices(['e', 'a']);
  assert.equal(store.getDevices().a.order, 1);
  store.removeDevice('e');
  assert.equal(fake.data.devices.e, undefined);
  assert.deepEqual(Object.keys(fake.data.devices).sort(), Object.keys(store.getDevices()).sort());
});
