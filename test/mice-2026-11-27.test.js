const test = require('node:test');
const assert = require('node:assert');
const table = require('../src/main/hid/drivers/table');
const { detectDriver } = require('../src/main/hid/drivers');
const kysona = require('../src/main/hid/drivers/kysona');
const sinowealth = require('../src/main/hid/drivers/sinowealth');
const rapoo = require('../src/main/hid/drivers/rapoo');
const { pad } = require('../src/main/hid/drivers/exchange');

const entry = (vendorId, productId, product) => table.find({ vendorId, productId, product });
const frame = (bytes, length = 64) => pad(bytes, length);
const ch = (usagePage, usage, iface) => ({ usagePage, usage, interface: iface, path: `${usagePage}:${usage}:${iface}` });
const compxLayout = [ch(1, 2, 0), ch(0xff02, 2, 1), ch(0xff04, 2, 1), ch(0xff01, undefined, 1)];

test('Pulsar, G-Wolves, Endgame Gear and iRocks receivers use the VXE frame, by exact id', () => {
  for (const [v, p] of [[0x3710, 0x5406], [0x3710, 0x3414], [0x33e4, 0x3854], [0x3367, 0x1961], [0x14a5, 0xc009]]) {
    assert.equal(detectDriver({ vendorId: v, productId: p, channels: compxLayout }).id, 'kysona', `${v.toString(16)}:${p.toString(16)}`);
  }
  assert.notEqual((detectDriver({ vendorId: 0x3710, productId: 0x5402, channels: compxLayout }) || {}).id, 'kysona');
  assert.equal(kysona.matches({ vendorId: 0x3710, productId: 0x5406, channels: [ch(0xff00, 1, 0)] }), false);
});

test('Zebronics 3554:fc0a reads its feature report 6, not the VXE frame', () => {
  const z = { vendorId: 0x3554, productId: 0xfc0a, channels: compxLayout };
  assert.equal(detectDriver(z).id, 'tabled');
  const s = entry(0x3554, 0xfc0a).steps[0];
  assert.deepEqual(s.parse([0x06, 0x00, 0x02, 0x00, 0x11, 73, 0x14, 0x80]), { capacity: 73 });
  assert.equal(detectDriver({ vendorId: 0x3554, productId: 0xf58a, channels: compxLayout }).id, 'kysona'); // VXE R1 Pro still kysona
});

test('WLmouse and the Attack Shark R5 Ultra: the sinowealth exchange on 0xFFFF alone', () => {
  assert.equal(sinowealth.matches({ vendorId: 0x36a7, productId: 0xa880, channels: [ch(0xffff, 0, 2)] }), true);
  assert.equal(sinowealth.matches({ vendorId: 0x373e, productId: 0x0047, channels: [ch(0xffff, 0, 2)] }), true);
  assert.equal(sinowealth.matches({ vendorId: 0x373e, productId: 0x0048, channels: [ch(0xffff, 0, 2)] }), false);
  assert.equal(sinowealth.matches({ vendorId: 0x36a7, productId: 0xa880, channels: [ch(0x01, 2, 0)] }), false);
  // HaloBattery wlmouse.py: "00 a1 00 02 02 00 83 01 60" = 96 %, charging; WLmouse also answers ready as A2.
  const reply = (status) => [0x00, status, 0x00, 0x02, 0x02, 0x00, 0x83, 0x01, 0x60];
  assert.deepEqual(sinowealth.parseReply(reply(0xa1), false, 0x36a7), { capacity: 96, charging: true });
  assert.deepEqual(sinowealth.parseReply(reply(0xa2), false, 0x36a7), { capacity: 96, charging: true });
  assert.equal(sinowealth.parseReply(reply(0xa2), false, 0x373e), null); // A2 counts for WLmouse only
});

test('the Rival 650 on its cable is its own wired entry', () => {
  const { DEVICES } = require('../src/main/hid/drivers/table');
  const cable = DEVICES.find((e) => e.vendorId === 0x1038 && e.productIds.includes(0x172b));
  assert.equal(cable.wired, true);
  assert.deepEqual(cable.steps[0].parse([60, 0, 1]), { capacity: 60, charging: true });
  assert.equal(cable.steps[0].parse([0, 0, 0]), null);
  assert.ok(!DEVICES.find((e) => e.vendorId === 0x1038 && e.productIds.includes(0x1726)).wired);
});

test('Rapoo VT9 Pro V2 and the VT7 cable', () => {
  assert.equal(rapoo.matches({ vendorId: 0x24ae, productId: 0x14a9, channels: [ch(0xff00, 0x02, 1)] }), true);
  assert.equal(rapoo.matches({ vendorId: 0x24ae, productId: 0x4613, channels: [ch(0xff00, 0x02, 1)] }), true);
});

test('Darmoshark N5 receiver and cable: the Nordic frame sums to 0xA1', () => {
  assert.equal(entry(0x1915, 0x0723).name, 'Waizowl OGM 8K');
  const cable = entry(0x1915, 0x073c).steps[0];
  assert.equal(cable.request.length, 65);
  assert.equal(cable.request.slice(1).reduce((a, b) => a + b, 0) & 0xff, 0xa1);
  const reply = new Array(64).fill(0); reply[0] = 0x01; reply[3] = 0x01; reply[6] = 63;
  reply[63] = (0xa1 - reply.slice(0, 63).reduce((a, b) => a + b, 0)) & 0xff;
  assert.deepEqual(cable.parse(reply), { capacity: 63 });
});

test('SteelSeries Aerox 3 Gen 2, Rival 650 and Rival Pro', () => {
  assert.deepEqual(entry(0x1038, 0x1890).steps[0].parse([0xd2, 0x00, 0x61, 0x00]), { capacity: 97, charging: false });
  assert.deepEqual(entry(0x1038, 0x1892).steps[0].parse([0x92, 0x01, 0x64, 0x00]), { capacity: 100, charging: true });
  assert.equal(entry(0x1038, 0x1890).steps[0].parse([0xd2, 0x00, 0xff, 0x00]), null);
  assert.deepEqual(entry(0x1038, 0x1726).steps[0].parse([55, 0, 1]), { capacity: 55, charging: true });
  assert.deepEqual(entry(0x1038, 0x1880).steps[0].parse([0x92, 0x00, 77, 0, 60]), { capacity: 77 });
});

test('ASUS ROG and TUF mice: 12 07 by interface, report 3 for the SPEEDNOVA receiver', () => {
  const chakram = entry(0x0b05, 0x1a1a);
  assert.deepEqual(chakram.steps[0].request.slice(0, 3), [0x00, 0x12, 0x07]);
  assert.deepEqual(chakram.steps[0].parse(frame([0x12, 0x07, 0, 0, 64, 0, 0, 0, 0, 1])), { capacity: 64, charging: true });
  assert.equal(entry(0x0b05, 0x1a18).wired, true);
  assert.equal(entry(0x0b05, 0x1b63).steps[0].request.length, 64);
  assert.deepEqual(entry(0x0b05, 0x1ad0).steps[0].parse(frame([0x03, 0x12, 0x07, 0x00, 0x00, 0x35, 0x02, 0x14, 0xfd, 0x0e, 0x00])), { capacity: 53, charging: false });
  assert.equal(detectDriver({ vendorId: 0x0b05, productId: 0x19f4, channels: [ch(0xff01, 1, 0)] }).id, 'tabled');
});

test('HyperX Haste 2 and Dart, MSI VERSA PRO, NZXT Lift Elite, Cooler Master', () => {
  const [link, level] = entry(0x03f0, 0x0f98).steps;
  assert.equal(link.parse(frame([0x53, 0x01, 0])).offline, true);
  assert.deepEqual(level.parse(frame([0x51, 0x02, 80, 0])), { capacity: 80, charging: false });
  assert.deepEqual(entry(0x0951, 0x16e1).steps[0].parse(frame([0x51, 0x00, 0x00, 0x03, 45, 1])), { capacity: 45, charging: true });
  assert.deepEqual(entry(0x0db0, 0x1fc6).steps[0].parse(frame([0, 0, 0, 0, 0, 0, 0x05, 0, 88, 0x02])), { capacity: 88, charging: false });
  const nzxt = new Array(28).fill(0); nzxt[0] = 0x4e; nzxt[1] = 0x02; nzxt[2] = 0x97; nzxt[17] = 72; nzxt[22] = 1;
  assert.deepEqual(entry(0x1e71, 0x2101).steps[0].parse(nzxt), { capacity: 72, charging: true });
  assert.deepEqual(entry(0x2516, 0x01b7).steps[0].parse(frame([0x47, 0x81, 0x50, 0, 0, 0, 0, 0, 0, 0, 66, 0])), { capacity: 66, charging: false });
});

test('VAXEE, CROCIRIS, DARKRIM, Ninjutso, Delux and Redragon M690 PRO', () => {
  const [vaxLevel, vaxCharge] = entry(0x3057, 0x1001).steps;
  assert.deepEqual(vaxLevel.request.slice(0, 5), [0x0e, 0xa5, 0x0b, 0x01, 0x01]);
  assert.deepEqual(vaxLevel.parse(frame([0x0e, 0xa5, 0x0b, 0, 0, 17])), { capacity: 85 });
  assert.deepEqual(vaxCharge.parse(frame([0x0e, 0xa5, 0x10, 0, 0, 1])), { charging: true });
  const cro = entry(0x36f9, 0xaa20).steps[0];
  assert.deepEqual(cro.parse(frame([0x55, 0x12, 6, 0, 0, 97, 0, 0x01])), { capacity: 97, charging: false });
  assert.equal(cro.parse(frame([0x55, 0x12, 6, 0, 0, 97, 0, 0x00])).offline, true);
  assert.deepEqual(entry(0x3654, 0x6901).steps[0].parse(frame([0xfe, 0x03, 0x10, 0x00, 0x02, 0, 0, 0x03, 0, 0x01, 0x01, 0x80 | 60])), { capacity: 60, charging: true });
  const [ninLevel] = entry(0x093a, 0xeb02).steps;
  assert.deepEqual(ninLevel.parse([0x06, 0x12, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0]), { capacity: 90 });
  const delux = entry(0x248a, 0x5b2f).steps[0];
  const a = delux.request(); const b = delux.request();
  assert.notEqual(a[4], b[4]);
  const dReply = new Array(33).fill(0); dReply[0] = 0x0c; dReply[2] = 0x20; dReply[18] = 70; dReply[19] = 1;
  assert.deepEqual(delux.parse(dReply), { capacity: 70, charging: true });
  dReply[2] = 0x21; // fuyue521 PollDeluxM800 checks the 0x20 echo
  assert.equal(delux.parse(dReply), null);
  const [m690link, m690status] = entry(0x258a, 0x002f).steps;
  assert.equal(m690link.parse([0x05, 0x80, 0x00, 0, 0, 0, 0, 0]).offline, true);
  assert.deepEqual(m690status.parse([0x05, 0x90, 0x11, 58, 0, 0, 0, 0]), { capacity: 58 });
});
