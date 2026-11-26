const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return {};
  return load.call(this, request, ...rest);
};
const elecom = require('../src/main/hid/drivers/elecom');
const { detectDriver } = require('../src/main/hid/drivers');
Module._load = load;

const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage.toString(16)}:${usage}` });
// What the ELECOM BlueLED Mouse (056e:00e5, Bluetooth) enumerates as on Windows.
const blueLed = { vendorId: 0x056e, productId: 0x00e5, product: 'Broadcom Bluetooth Wireless Mouse', channels: [ch(0x01, 0x02), ch(0x0c, 0x01), ch(0xff31, 0x01)] };

test('elecom: reads Battery Strength from byte 1 of input report 3', () => {
  // A real BlueLED Mouse at 92%; the rest is its Bluetooth address (replaced here).
  assert.deepEqual(elecom.parseReport([0x03, 0x5c, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]), { capacity: 92, charging: null });
  assert.deepEqual(elecom.parseReport([0x03, 100, 0, 0, 0, 0, 0, 0]), { capacity: 100, charging: null });
});

test('elecom: ignores other reports, empty and out-of-range levels', () => {
  assert.equal(elecom.parseReport([0x02, 0x5c, 0, 0, 0, 0, 0, 0]), null);
  assert.equal(elecom.parseReport([0x03]), null);
  assert.equal(elecom.parseReport([]), null);
  assert.equal(elecom.parseReport([0x03, 0xc8, 0, 0, 0, 0, 0, 0]), null);
  // An all-zero report is what the OS hands back when the mouse hasn't answered.
  assert.equal(elecom.parseReport([0x03, 0, 0, 0, 0, 0, 0, 0]), null);
});

test('elecom: asks the consumer-control collection, where the battery usage lives', () => {
  assert.deepEqual(elecom.batteryChannel(blueLed), blueLed.channels[1]);
  assert.equal(elecom.batteryChannel({ ...blueLed, channels: [ch(0x01, 0x02)] }), undefined);
});

test('elecom: claims only the BlueLED Mouse', () => {
  assert.equal(detectDriver(blueLed).id, 'elecom');
  assert.equal(elecom.matches({ ...blueLed, productId: 0x00e6 }), false);
  assert.equal(elecom.matches({ ...blueLed, vendorId: 0x046d }), false);
  assert.equal(elecom.matches({ ...blueLed, channels: [ch(0x01, 0x02)] }), false);
});
