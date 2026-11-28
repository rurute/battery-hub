const test = require('node:test');
const assert = require('node:assert');
const table = require('../src/main/hid/drivers/table');
const { detectDriver } = require('../src/main/hid/drivers');
const gearhub = require('../src/main/hid/drivers/gearhub');
const compx = require('../src/main/hid/drivers/compx');
const mchoseMouse = require('../src/main/hid/drivers/mchose-mouse');
const yjx = require('../src/main/hid/drivers/yjx');
const { pad } = require('../src/main/hid/drivers/exchange');

const entry = (vendorId, productId, product) => table.find({ vendorId, productId, product });
const frame = (bytes, length = 64) => pad(bytes, length);
const ch = (usagePage, usage, iface) => ({ usagePage, usage, interface: iface, path: `${usagePage}:${usage}:${iface}` });

test('existing drivers pick up the ids the vendors’ web drivers list', () => {
  assert.equal(yjx.matches({ vendorId: 0x391d, productId: 0x1a09, channels: [ch(0xff01, 0x10, 1)] }), true);
  assert.equal(yjx.matches({ vendorId: 0x3837, productId: 0x4042, channels: [ch(0xff01, 0x10, 1)] }), true);
  assert.equal(yjx.matches({ vendorId: 0x3837, productId: 0x4042, channels: [ch(0xff01, 0x01, 1)] }), false);
  const ff02 = [ch(0xff02, 2, 1)];
  assert.equal(compx.matches({ vendorId: 0x391d, productId: 0x2a01, channels: ff02 }), true);
  assert.equal(compx.matches({ vendorId: 0x258a, productId: 0x027b, channels: ff02 }), true);
  assert.equal(compx.matches({ vendorId: 0x258a, productId: 0x0049, channels: ff02 }), false); // Redragon Azure (#228): never
  assert.equal(mchoseMouse.matches({ vendorId: 0x0bda, productId: 0x4762, channels: [ch(0xff01, 1, 1)] }), true);
  assert.equal(entry(0x373b, 0x1179).name, 'ATK X1 NearLink');
  assert.equal(entry(0x391d, 0x1a35).name, 'VGN (Keychron platform)');
});

test('gearhub: other vendors’ Rongyuan dongles, the paired-kind byte and the request checksum', () => {
  assert.equal(gearhub.REQUEST[8], 0x08);
  assert.equal(gearhub.REQUEST.length, 65);
  assert.equal(gearhub.matches({ vendorId: 0x342d, productId: 0xe3e0, channels: [ch(0xffff, 0x02, 2)] }), true);
  assert.equal(gearhub.matches({ vendorId: 0x342d, productId: 0xe411, channels: [ch(0xffff, 0x02, 2)] }), false);
  // byte 7 = 1: the keyboard is what's paired, whatever the name says
  assert.deepEqual(gearhub.parseReply([0, 1, 70, 40, 0, 1, 0, 1], 'mouse'), { capacity: 70 });
  assert.deepEqual(gearhub.parseReply([0, 1, 70, 40, 1, 0, 0, 2], 'keyboard'), { capacity: 40 });
  assert.equal(gearhub.parseReply([0, 0xf7, 0, 0, 0, 0, 0, 0], 'mouse'), null);
  // Akko's own receivers stay on akko.js
  assert.equal(detectDriver({ vendorId: 0x38ee, productId: 0x0024, channels: [ch(0xff1c, 0x92, 1), ch(0xffff, 0x02, 2)] }).id, 'akko');
});

test('ATK Hechi and Waizowl; kysona leaves the Waizowl receivers alone', () => {
  const [awake, info] = entry(0x373b, 0x1196).steps;
  assert.equal(awake.parse(frame([0x0b, 0x14, 0, 0, 0])).offline, true);
  const reply = frame([0x0b, 0x13]); reply[17] = 1; reply[18] = 88;
  assert.deepEqual(info.parse(reply), { capacity: 88, charging: true });
  const w = entry(0x373b, 0x1283).steps[0];
  assert.deepEqual(w.request.slice(0, 4), [0x02, 0x0e, 0x81, 0x01]);
  // ATK's hub sends and reads it as feature report 2, never as an output report.
  assert.equal(w.via, 'feature');
  assert.equal(w.reportId, 2);
  assert.deepEqual(w.parse(frame([0x02, 0x0e, 0x81, 0x01, 3, 77, 0])), { capacity: 77, charging: false });
  assert.deepEqual(w.parse(frame([0x02, 0x0e, 0x00, 0x01, 3, 77, 1])), { capacity: 77, charging: true });
  assert.equal(w.parse(frame([0x02, 0x0e, 0x81, 0x01, 3, 77, 2])).offline, true);
  const layout = [ch(0xff02, 2, 1), ch(0xff04, 2, 1)];
  assert.equal(detectDriver({ vendorId: 0x373b, productId: 0x1283, channels: layout }).id, 'tabled');
  assert.equal(detectDriver({ vendorId: 0x373b, productId: 0x1085, channels: layout }).id, 'kysona');
});

test('MCHOSE 0x4D, VGN ldMs and king, Pulsar Fusion2', () => {
  const m = entry(0x3837, 0x101d).steps[0];
  assert.deepEqual(m.request.slice(0, 9), [0x4d, 0x01, 0x01, 0x00, 0x00, 0x09, 0x00, 0x00, 0x08]);
  assert.equal(m.request[2] ^ m.request[3] ^ m.request[4] ^ m.request[5] ^ m.request[6] ^ m.request[7], 0x08);
  const mr = frame([0x4d, 0x01, 0x01, 0x10, 0x00, 0x09]); mr[8] = 0x37; mr[19] = 1; mr[20] = 64;
  assert.deepEqual(m.parse(mr), { capacity: 64, charging: true });
  mr[20] = 0;
  assert.equal(m.parse(mr), null); // M HUB retries a 0 before calling the mouse off
  assert.equal(mchoseMouse.matches({ vendorId: 0x3837, productId: 0x101d, channels: [ch(0xff01, 1, 1)] }), false);
  assert.deepEqual(entry(0x391d, 0x1a18).steps[0].parse(frame([0xa0, 0x02, 0x25, 91], 33)), { capacity: 91 });
  const king = frame([0x20]); king[8] = 0x08; king[17] = 55;
  assert.deepEqual(entry(0x9981, 0x7002).steps[0].parse(king), { capacity: 55 });
  const [level, charge] = entry(0x3710, 0x5403).steps;
  assert.equal(level.request.length, 65);
  assert.deepEqual(level.request.slice(1, 5), [0x00, 0x08, 0x81, 0x01]);
  assert.deepEqual(level.request.slice(63), [0x8a, 0x00]);
  assert.deepEqual(charge.request.slice(63), [0x8c, 0x00]);
  const ready = new Array(65).fill(0); ready[1] = 0x01; ready[2] = 0x08; ready[3] = 0x81; ready[7] = 88;
  assert.deepEqual(level.parse(ready), { capacity: 88 });
  ready[7] = 0xff;
  assert.equal(level.parse(ready).offline, true);
  const busy = [...ready]; busy[1] = 0x02;
  assert.equal(level.parse(busy), null);
  const noMouse = [...ready]; noMouse[1] = 0x05; // status 05, the request echoed: no mouse on the dongle
  assert.equal(level.parse(noMouse).offline, true);
  assert.equal(detectDriver({ vendorId: 0x3710, productId: 0x5403, channels: [ch(0xff00, 1, 3)] }).id, 'tabled');
});
