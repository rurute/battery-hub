const test = require('node:test');
const assert = require('node:assert');
const table = require('../src/main/hid/drivers/table');
const { detectDriver } = require('../src/main/hid/drivers');
const akko = require('../src/main/hid/drivers/akko');
const razerDevices = require('../src/main/hid/drivers/razer-devices');
const { pad } = require('../src/main/hid/drivers/exchange');

const entry = (vendorId, productId, product) => table.find({ vendorId, productId, product });
const frame = (bytes, length = 64) => pad(bytes, length);
const ch = (usagePage, usage, iface) => ({ usagePage, usage, interface: iface, path: `${usagePage}:${usage}:${iface}` });

test('ASUS ROG keyboards: 12 01, level at 5 (Falchion family at 10), FF AA asleep', () => {
  const azoth = entry(0x0b05, 0x1a85).steps[0];
  assert.deepEqual(azoth.request.slice(0, 3), [0x00, 0x12, 0x01]);
  assert.deepEqual(azoth.parse(frame([0x12, 0x01, 0, 0, 0, 77, 0, 0, 1])), { capacity: 77, charging: true });
  assert.equal(azoth.parse(frame([0xff, 0xaa])).offline, true);
  const falchion = entry(0x0b05, 0x1b04).steps[0];
  assert.deepEqual(falchion.parse(frame([0x12, 0x01, 0, 0, 0, 8, 0, 0, 0, 0, 82])), { capacity: 82, charging: false });
  assert.equal(entry(0x0b05, 0x196b).name, 'ASUS ROG Claymore II, Azoth, Strix Scope');
  assert.equal(entry(0x0b05, 0x1a64), null); // Falchion Ace: no battery
});

test('Lofree on its Compx receiver: the keyboard flag, and only by name', () => {
  const lofree = entry(0x3554, 0xfa0a, '2.4G Wireless Receiver');
  const [status, battery] = lofree.steps;
  assert.deepEqual(status.request, [0x08, 0x03, 0, 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xca]);
  assert.equal(battery.request[16], 0xc9);
  assert.equal(status.parse(frame([0x08, 0x03, 0, 0, 0, 0, 0])).offline, true);
  assert.deepEqual(battery.parse(frame([0x08, 0x04, 0, 0, 0, 0, 66, 1])), { capacity: 66, charging: true });
  assert.equal(entry(0x3554, 0xfa0a, 'VXE Mouse'), null);
  assert.equal(entry(0x05ac, 0x024f, '2.4G Wireless Receiver').name, 'Lofree Flow Lite84');
  assert.equal(entry(0x05ac, 0x024f, 'F108Pro Dongle').name, 'AULA F108 Pro (dongle)');
  assert.equal(detectDriver({ vendorId: 0x3554, productId: 0xfa0a, product: '2.4G Wireless Receiver', channels: [ch(0xff02, 2, 1), ch(0xff04, 2, 1)] }).id, 'tabled');
});

test('GANSS GS3075T: AA 10 18 by name on the SONiX receiver, AULA stays on 20 01', () => {
  const ganss = entry(0x0c45, 0xfefe, 'GS3075T 2.4G').steps[0];
  assert.equal(ganss.request.length, 33);
  assert.deepEqual(ganss.request.slice(0, 4), [0x00, 0xaa, 0x10, 0x18]);
  const reply = new Array(32).fill(0); reply[0] = 0x55; reply[1] = 0x10; reply[2] = 0x18; reply[25] = 64; reply[26] = 0x02;
  assert.deepEqual(ganss.parse(reply), { capacity: 64, charging: true });
  assert.deepEqual(ganss.parse([0x00, ...reply]), { capacity: 64, charging: true });
  assert.deepEqual(entry(0x0c45, 0xfefe, 'AULA 2.4G').steps[0].request.slice(0, 3), [0x00, 0x20, 0x01]);
});

test('Alienware, Red Square, Apex Pro and the Cherry request', () => {
  const alien = entry(0x413c, 0x211d).steps[0];
  assert.equal(alien.via, 'feature-input');
  assert.deepEqual(alien.parse([0x0e, 0xa1, 92, 0x04]), { capacity: 92, charging: true });
  assert.deepEqual(alien.parse([0x00, 0x0e, 0xa1, 92, 0x00]), { capacity: 92, charging: false });
  assert.equal(alien.parse([0x0e, 0x05, 92, 0x00]), null);
  const rsq = entry(0x342d, 0xe411, 'RSQ 20055 2.4G').steps[0];
  assert.deepEqual(rsq.parse(frame([0x07, 0x05, 0xa1, 0x01, 0x0a, 0x07, 0x8b, 5, 2, 71], 33)), { capacity: 71 });
  assert.equal(entry(0x342d, 0xe411, 'RSQ_20055_2.4G').name, 'Red Square Alumix TKL');
  const [linked, level] = entry(0x1038, 0x1644).steps;
  assert.equal(linked.parse([0xbc, 0x00]).offline, true);
  assert.deepEqual(level.parse([0xd2, 0x14]), { capacity: 95, charging: false });
  assert.deepEqual(entry(0x1038, 0x1646).steps[0].parse([0x92, 0x80 | 0x15]), { capacity: 100, charging: true });
  assert.deepEqual(akko.REQUEST_CHERRY.slice(0, 8), [0x04, 0x72, 0x00, 0x1a, 0x03, 0x00, 0x00, 0x55]);
  assert.equal(akko.REQUEST_CHERRY[1], 0x1a + 0x03 + 0x55);
  assert.equal(detectDriver({ vendorId: 0x046a, productId: 0x00ea, channels: [ch(0xff1c, 0x92, 0)] }).id, 'akko');
});

test('Razer: the BlackWidow V4 Low Profile TKL, the V3 Pro wired transaction id, and new mice', () => {
  const tid = (pid) => (razerDevices.find(([p]) => p === pid) || [])[1];
  assert.equal(tid(0x02d2), 0x9f);
  assert.equal(tid(0x02d4), 0x1f);
  assert.equal(tid(0x025a), 0x3f);
  for (const pid of [0x00e0, 0x00e2, 0x00e3, 0x00e7, 0x00e8, 0x00ea, 0x00eb]) assert.equal(tid(pid), 0x1f);
  const pids = razerDevices.map(([p]) => p);
  assert.equal(new Set(pids).size, pids.length);
});
