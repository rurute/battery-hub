const test = require('node:test');
const assert = require('node:assert');
const nintendo = require('../src/main/hid/drivers/nintendo');

test('a Switch Pro Controller (or clone) on Bluetooth is claimed by its gamepad collection', () => {
  const pad = (productId) => ({ vendorId: 0x057e, productId, channels: [{ path: 'p', usagePage: 1, usage: 5 }] });
  assert.equal(nintendo.matches(pad(0x2009)), true);
  assert.equal(nintendo.matches(pad(0x2006)), true);
  assert.equal(nintendo.matches(pad(0x0306)), false);
  assert.equal(nintendo.matches({ vendorId: 0x057e, productId: 0x2009, channels: [] }), false);
});

test('the battery comes from byte 2 of reports 0x21 and 0x30', () => {
  assert.deepEqual(nintendo.parseReport([0x21, 0x05, 0x90]), { capacity: 100, charging: true });
  assert.deepEqual(nintendo.parseReport([0x30, 0x05, 0x60]), { capacity: 75, charging: false });
  assert.deepEqual(nintendo.parseReport([0x21, 0x05, 0x20]), { capacity: 25, charging: false });
  assert.equal(nintendo.parseReport([0x3f, 0x00, 0x80]), null);
});

test('the request asks for device info with no rumble, short enough for any clone', () => {
  const r = nintendo.request();
  assert.equal(r.length, 11);
  assert.deepEqual(r.slice(2, 11), [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40, 0x02]);
  assert.equal(r[0], 0x01);
});
