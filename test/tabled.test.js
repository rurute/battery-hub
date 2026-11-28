const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// tabled.js against a fake node-hid: the step modes (feature, feature then input, no reply), the
// fallback steps, and the product gate in table.find().
class FakeDevice {
  constructor() { this.reads = []; this.features = []; this.sent = []; this.featuresSent = []; }
  async read() { const next = this.reads.shift(); return Buffer.from(next || []); }
  async write(bytes) { this.sent.push(Array.from(bytes)); return bytes.length; }
  async getFeatureReport(id, length) { this.lastGet = [id, length]; return Buffer.from(this.features.shift() || [id]); }
  async sendFeatureReport(bytes) { this.featuresSent.push(Array.from(bytes)); return bytes.length; }
  async close() {}
}
const devices = new Map();
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return { HIDAsync: { open: async (path) => devices.get(path) } };
  return load.call(this, request, ...rest);
};
const tabled = require('../src/main/hid/drivers/tabled');
const table = require('../src/main/hid/drivers/table');
Module._load = load;

let n = 0;
function device() { const path = `t-${n += 1}`; const dev = new FakeDevice(); devices.set(path, dev); return { path, dev }; }
const entryOf = (fields) => ({ name: 'test', kind: 'mouse', ...fields });

test('a feature step sends its request and reads the feature report back', async () => {
  const { path, dev } = device();
  dev.features = [[0xff, 0x01], [0xff, 0x0f, 42]];
  const entry = entryOf({ steps: [{ via: 'feature', request: [0xff, 0x0a], reportId: 0xff, length: 64, wait: 1, parse: (f) => (f[1] === 0x0f ? { capacity: f[2] } : null) }] });
  const reading = await tabled.runSteps({ path }, entry, entry.steps, 1);
  assert.equal(reading.capacity, 42);
  assert.deepEqual(dev.featuresSent, [[0xff, 0x0a]]);
  assert.deepEqual(dev.lastGet, [0xff, 65]); // at least 65: Windows wants the collection's full length
});

test('a short feature read asks with a buffer of at least 65 bytes', async () => {
  const { path, dev } = device();
  dev.features = [[0x49, 70]];
  const entry = entryOf({ steps: [{ via: 'feature', reportId: 0x49, length: 2, wait: 1, parse: (f) => (f[0] === 0x49 ? { capacity: f[1] } : null) }] });
  assert.equal((await tabled.runSteps({ path }, entry, entry.steps, 1)).capacity, 70);
  assert.deepEqual(dev.lastGet, [0x49, 65]);
});

test('a feature-input step sends a feature report and reads the answer as input', async () => {
  const { path, dev } = device();
  dev.reads = [[], [0x27, 0x01, 0x00, 0, 0, 0, 0, 77]];
  const entry = entryOf({ steps: [{ via: 'feature-input', request: [0x24, 0x01], parse: (f) => (f[0] === 0x27 ? { capacity: f[7] } : null) }] });
  assert.equal((await tabled.runSteps({ path }, entry, entry.steps, 1)).capacity, 77);
  assert.deepEqual(dev.featuresSent, [[0x24, 0x01]]);
});

test('a no-reply step only writes, and a request can be made fresh each time', async () => {
  const { path, dev } = device();
  dev.reads = [[], [0x07, 55]]; // nothing queued before the request, then the answer
  let seq = 0;
  const entry = entryOf({ steps: [
    { noReply: true, wait: 1, request: [0x06, 0x01], parse: () => null },
    { request: () => [0x07, (seq += 1)], parse: (f) => (f[0] === 0x07 ? { capacity: f[1] } : null) },
  ] });
  assert.equal((await tabled.runSteps({ path }, entry, entry.steps, 1)).capacity, 55);
  assert.deepEqual(dev.sent, [[0x06, 0x01], [0x07, 1]]);
});

test('a product-gated entry only claims a device with that name', () => {
  const lofreeLike = { vendorId: 0x05ac, productId: 0x024f };
  const aula = table.find({ ...lofreeLike, product: 'F108Pro Dongle' });
  assert.ok(aula && /AULA/.test(aula.name));
  assert.equal(table.find({ ...lofreeLike, product: 'Magic Keyboard' }), null);
});

test('Corsair dongles read the OpenLinkHub frame, and fall back to the headset frame', () => {
  const slip = table.find({ vendorId: 0x1b1c, productId: 0x1bdc });
  assert.deepEqual(slip.steps[0].request.slice(0, 5), [0x00, 0x09, 0x02, 0x0f, 0x00]);
  assert.equal(slip.steps[0].request.length, 65);
  assert.deepEqual(slip.steps[0].parse([0x01, 0x02, 0x00, 0xe8, 0x03]), { capacity: 100 });
  assert.deepEqual(slip.steps[0].parse([0x01, 0x02, 0x00, 0x26, 0x02]), { capacity: 55 });
  assert.equal(slip.steps[0].parse([0x01, 0x02, 0x05, 0, 0]).offline, true);
  assert.equal(slip.steps[0].parse([0x01, 0x01, 0x02, 0x00, 0xe8, 0x03]), null); // the headset framing's reply
  assert.equal(slip.fallbackSteps.length, 2);
  assert.equal(table.find({ vendorId: 0x1b1c, productId: 0x2b07 }).kind, 'keyboard');
  const cable = table.find({ vendorId: 0x1b1c, productId: 0x1bb5 });
  assert.deepEqual(cable.steps[0].request.slice(0, 4), [0x00, 0x08, 0x02, 0x0f]);
  assert.equal(cable.wired, true);
  assert.deepEqual(cable.channel, { usagePage: 0xff42, usage: 0x01 });
  // The answer's source byte must fit the target: 00 for the device itself, 01 for the one behind the receiver.
  assert.deepEqual(cable.steps[0].parse([0x00, 0x02, 0x00, 0x3e, 0x03]), { capacity: 83 });
  assert.equal(cable.steps[0].parse([0x01, 0x02, 0x00, 0x3e, 0x03]), null);
  assert.equal(slip.steps[0].parse([0x00, 0x02, 0x00, 0xe8, 0x03]), null); // the receiver answering iCUE for itself
});

test('NIGHTSWORD v2 on its cable speaks Slipstream V2; the VANGUARD keyboards wait for a capture', () => {
  const ns = table.find({ vendorId: 0x1b1c, productId: 0x2b1c });
  assert.equal(ns.name, 'Corsair NIGHTSWORD v2 (cable)');
  assert.deepEqual(ns.steps[0].request.slice(0, 6), [0x00, 0x00, 0x01, 0x01, 0x02, 0x0f]);
  assert.deepEqual(ns.steps[0].parse([0x00, 0x00, 0x01, 0x02, 0x00, 0xe8, 0x03]), { capacity: 100 });
  assert.equal(table.find({ vendorId: 0x1b1c, productId: 0x2b0f }), null);
  assert.equal(table.find({ vendorId: 0x1b1c, productId: 0x2b21 }), null);
});
