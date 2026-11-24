// One Lightspeed receiver, several devices: each paired device gets its own card.
// Byte fixtures are what the G913 TKL / G502 X receiver (046d:c547) sent during fork Issue #2.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return {};
  return load.call(this, request, ...rest);
};
const lightspeed = require('../src/main/hid/drivers/lightspeed');
const { identityOf, planMerges } = require('../src/main/identity');
Module._load = load;

const hex = (t) => t.split(' ').map((b) => parseInt(b, 16));

test('pairing info: wireless PID and kind from the bytes the G913 TKL / G502 X receiver sent', () => {
  assert.deepEqual(lightspeed.parsePairing(hex('20 07 08 40 8e 11 00 01 b3')), { wpid: 0x408e, kind: 1 });
  assert.deepEqual(lightspeed.parsePairing(hex('21 08 08 40 9f 11 00 02 b1')), { wpid: 0x409f, kind: 2 });
  assert.equal(lightspeed.parsePairing(hex('22 00 00 00 00 00 00 00')), null);
});

test('device name: length then ASCII', () => {
  const name = [0x40, 8, ...Buffer.from('G913 TKL')];
  assert.equal(lightspeed.parseName(name), 'G913 TKL');
  assert.equal(lightspeed.parseName([0x41, 0]), null);
});

test('a child keeps its id across slots and takes the receiver short name', () => {
  const parent = { id: '1133:50503:ABC', vendorId: 0x046d, productId: 0xc547, serialNumber: 'ABC', product: 'USB Receiver', manufacturer: 'Logitech', channels: [] };
  const a = lightspeed.childOf(parent, { slot: 1, wpid: 0x408e, kind: 1, name: 'G913 TKL' });
  const b = lightspeed.childOf(parent, { slot: 2, wpid: 0x408e, kind: 1, name: 'G913 TKL' });
  assert.equal(a.id, '1133:50503:ABC:408e');
  assert.equal(a.id, b.id);
  assert.equal(a.product, 'G913 TKL');
  assert.deepEqual(a.receiver, { slot: 1, wpid: 0x408e, kind: 1 });
  assert.equal(a.identity, undefined);
  assert.equal(lightspeed.childOf(parent, { slot: 2, wpid: 0x409f, kind: 2, name: null }).product, 'Logitech mouse');
});

test('only the c547 receiver with both HID++ collections is a target', () => {
  const ch = [{ usagePage: 0xff00, usage: 1 }, { usagePage: 0xff00, usage: 2 }];
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc547, channels: ch }), true);
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc548, channels: ch }), false);
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc547, channels: [ch[1]] }), false);
});

test('children of a receiver whose serial looks like a Bluetooth address are never merged', () => {
  const serial = '0123456789ab';
  const live = { id: `1133:50503:${serial}:408e`, serialNumber: serial };
  assert.equal(identityOf(live), null);
  const saved = { a: { id: `1133:50503:${serial}:408e` }, b: { id: `1133:50503:${serial}:409f` } };
  assert.equal(identityOf(saved.a), null);
  assert.deepEqual(planMerges(saved), []);
  const livePair = { a: { id: `1133:50503:${serial}:408e`, serialNumber: serial }, b: { id: `1133:50503:${serial}:409f`, serialNumber: serial } };
  assert.deepEqual(planMerges(livePair), []);
  assert.equal(identityOf({ id: `1133:50503:${serial}` }), `mac:${serial}`); // unchanged for others
});
