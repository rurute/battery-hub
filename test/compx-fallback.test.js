const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// 3554:fa09 also carries mice (issues #244, #190, #82, #116): when the receiver never answers the
// keyboard session, compx.js reads it as a VXE mouse. A fake receiver that answers only the mouse frame.
class MouseOnly {
  constructor() { this.queue = []; this.sent = []; }
  async read() { return Buffer.from(this.queue.shift() || []); }
  async write(bytes) {
    const b = Array.from(bytes);
    this.sent.push(b);
    if (b[0] === 0x08 && b[1] === 0x03) this.queue.push([0x08, 0x03, 0, 0, 0, 1, 1, 0xb5, 0xb6, 0x0d, 0, 0, 0, 0, 0, 0, 0xd0]);
    if (b[0] === 0x08 && b[1] === 0x04) this.queue.push([0x08, 0x04, 0, 0, 0, 0, 58, 0, 0x0f, 0xa0]);
    return b.length;
  }
  async close() {}
}
const dev = new MouseOnly();
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return { HIDAsync: { open: async () => dev } };
  if (request === 'child_process') return { execFile: (file, args, options, cb) => (cb || options)(new Error('no helper in tests')) };
  return load.call(this, request, ...rest);
};
const compx = require('../src/main/hid/drivers/compx');
const kysona = require('../src/main/hid/drivers/kysona');
Module._load = load;

test('compx: a fa09 receiver that never answers the keyboard session is read as a mouse', async () => {
  const receiver = { vendorId: 0x3554, productId: 0xfa09, channels: [{ path: 'fa09', usagePage: 0xff02, usage: 2 }] };
  assert.equal(compx.matches(receiver), true);
  const reading = await compx.readBattery(receiver);
  assert.equal(reading.capacity, 58);
  assert.ok(dev.sent.some((b) => b[0] === 0x13), 'the keyboard session was tried first');
  assert.ok(dev.sent.some((b) => b[0] === 0x08 && b[1] === 0x04), 'then the mouse battery frame');

  // Once known to carry a mouse, the receiver is read as one straight away, without the keyboard session.
  dev.sent = [];
  const started = Date.now();
  assert.equal((await compx.readBattery(receiver)).capacity, 58);
  assert.ok(!dev.sent.some((b) => b[0] === 0x13), 'no keyboard session the second time');
  assert.ok(Date.now() - started < 1500);
});

test('compx: MCHOSE K87 and G98 Pro receivers are claimed, kysona leaves table devices alone', () => {
  const ch = [{ path: 'x', usagePage: 0xff02, usage: 2 }, { path: 'y', usagePage: 0xff04, usage: 2 }];
  assert.equal(compx.matches({ vendorId: 0x41e4, productId: 0x2001, channels: ch }), true);
  assert.equal(compx.matches({ vendorId: 0x41e4, productId: 0x2120, channels: ch }), false); // Ace 68 Air-II, can't be read (#170)
  assert.equal(kysona.matches({ vendorId: 0x3554, productId: 0xfa0a, product: '2.4G Wireless Receiver', channels: ch }), false);
  assert.equal(kysona.matches({ vendorId: 0x3554, productId: 0xfa0a, product: 'VXE R1', channels: ch }), true);
});
