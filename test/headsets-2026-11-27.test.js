const test = require('node:test');
const assert = require('node:assert');
const table = require('../src/main/hid/drivers/table');
const { detectDriver } = require('../src/main/hid/drivers');
const inzone = require('../src/main/hid/drivers/inzone');
const audeze = require('../src/main/hid/drivers/audeze');
const { pad } = require('../src/main/hid/drivers/exchange');

const entry = (vendorId, productId, product) => table.find({ vendorId, productId, product });
const frame = (bytes, length = 64) => pad(bytes, length);
const ch = (usagePage, usage, iface) => ({ usagePage, usage, interface: iface, path: `${usagePage}:${usage}:${iface}` });
const xor = (bytes) => bytes.reduce((x, b) => x ^ b, 0);

test('INZONE H5 and H9 II: one battery, the generic checksum, 0xFF when off', () => {
  const h5 = [0x02, 0x0e, 0x04, 0xff, 0x0b, 0x00, 0x96, 0xc3, 0x14, 0x04, 0x10, 0x02, 0x01, 0x00, 0x32, 0xb6];
  assert.deepEqual(inzone.parseHeadset(frame(h5), 0x0102), { capacity: 50, charging: false });
  assert.equal(inzone.parseHeadset(frame(h5), 0x0103), null);
  const off = [...h5]; off[14] = 0xff; off[15] = (0xb6 - 0x32 + 0xff) & 0xff;
  assert.equal(inzone.parseHeadset(frame(off), 0x0102).off, true);
  assert.equal(detectDriver({ vendorId: 0x054c, productId: 0x0ebf, channels: [ch(0xff04, 0x0002, 0)] }).id, 'inzone');
  assert.equal(detectDriver({ vendorId: 0x054c, productId: 0x0fa8, channels: [ch(0xff04, 0x0001, 5)] }).id, 'inzone');
  assert.notEqual((detectDriver({ vendorId: 0x054c, productId: 0x0ce6, channels: [ch(0xff04, 0x0001, 5)] }) || {}).id, 'inzone');
});

test('Audeze Maxwell variants and Skullcandy PLYR use the Audeze driver', () => {
  for (const [v, p] of [[0x3329, 0x4b1e], [0x3329, 0x4ba9], [0x34f0, 0x3210], [0x34f0, 0x5310]]) assert.equal(audeze.matches({ vendorId: v, productId: p }), true);
  assert.equal(audeze.matches({ vendorId: 0x34f0, productId: 0x4b19 }), false);
});

test('HyperX, Corsair and SteelSeries ids join their families', () => {
  assert.equal(entry(0x0951, 0x1718).name, 'HyperX Cloud Flight S');
  assert.equal(entry(0x0951, 0x1749).name, 'HyperX Cloud Flight');
  assert.equal(entry(0x03f0, 0x0795).name, 'HyperX Cloud II Core Wireless');
  assert.equal(entry(0x03f0, 0x0fcc).name, 'HyperX Cloud III Wireless');
  assert.equal(entry(0x03f0, 0x02cc).name, 'HyperX Cloud III S Wireless');
  assert.equal(entry(0x03f0, 0x0e90).name, 'HyperX Cloud Flight (HP)');
  assert.equal(entry(0x1b1c, 0x0a6b).name, 'Corsair Virtuoso SE and XT');
  assert.equal(entry(0x1b1c, 0x0a69).wired, true);
  assert.equal(entry(0x1038, 0x2255).name, 'SteelSeries Arctis Nova 3P/5');
});

test('FIFINE HT6 reads like the X9, with 55 0A meaning off', () => {
  const s = entry(0x3142, 0x00c3).steps[0];
  assert.deepEqual(s.request.slice(0, 4), [0x55, 0x65, 0x01, 0x00]);
  assert.deepEqual(s.parse(frame([0x55, 0x65, 80, 3])), { capacity: 80, charging: true });
  assert.equal(s.parse(frame([0x55, 0x65, 80, 0x1a])).offline, true);
  assert.equal(s.parse(frame([0x55, 0x0a])).offline, true);
});

test('Corsair SABRE v3 PRO: Slipstream V2 frame, 513 bytes to the receiver', () => {
  const rx = entry(0x1b1c, 0x2b42).steps[0];
  assert.equal(rx.request.length, 513);
  assert.deepEqual(rx.request.slice(0, 6), [0x00, 0x01, 0x01, 0x01, 0x02, 0x0f]);
  assert.deepEqual(rx.parse([0x01, 0x00, 0x01, 0x02, 0x00, 0xac, 0x03]), { capacity: 94 });
  assert.equal(rx.parse([0x00, 0x00, 0x04, 0x0d, 0, 0, 0]), null);
  const cable = entry(0x1b1c, 0x2b43).steps[0];
  assert.deepEqual(cable.request.slice(0, 6), [0x00, 0x00, 0x01, 0x01, 0x02, 0x0f]);
  assert.equal(cable.request.length, 65);
});

test('Razer V2 HyperSpeed and Kraken V4: the V3 frame by domain, without the byte-1 check', () => {
  const rx = entry(0x1532, 0x0565).steps[0];
  assert.equal(rx.request[9], 0x80);
  assert.equal(rx.request[62], 0xc7); // XOR for domain 0x80, command 0x21
  const cable = entry(0x1532, 0x056b).steps[0];
  assert.equal(cable.request[9], 0x00);
  assert.equal(cable.request[62], 0x47);
  const reply = frame([0x02, 0x00, 0x61, 0, 0, 0, 5, 0, 0, 0x80, 0x21, 0x01, 0x01, 87]);
  assert.deepEqual(rx.parse(reply), { capacity: 87 });
  assert.equal(rx.parse(frame([0x02, 0x00, 0x61, 0, 0, 0, 5, 0, 0, 0x80, 0x21, 0x01, 0x01, 0xff])).offline, true);
  assert.deepEqual(entry(0x1532, 0x0576).steps[0].request.slice(0, 11), razerV3Head()); // the V3 entry is unchanged
});
function razerV3Head() { return [0x02, 0x00, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x80, 0x21]; }

test('Razer BlackShark V2 Pro 2020 and Nari: Avnera feature read in millivolts', () => {
  const s = entry(0x1532, 0x0528).steps[0];
  assert.equal(s.via, 'feature');
  assert.deepEqual(s.request.slice(0, 9), [0xff, 0x0a, 0x00, 0xfd, 0x04, 0x12, 0xf1, 0x02, 0x05]);
  const reply = (state, mv) => frame([0xff, 0x0f, 0x05, 0xfe, 0x12, 0x04, 0x1f, 0x08, 0x05, 0, 0, state, mv >> 8, mv & 0xff]);
  assert.deepEqual(s.parse(reply(0x01, 4150)), { capacity: 100, charging: false, voltageMv: 4150 });
  assert.equal(s.parse(reply(0x09, 3900)).charging, true);
  assert.equal(s.parse(reply(0x01, 0)).offline, true);
  assert.equal(s.parse(frame([0xff, 0x01, 0x00, 0xfe])), null);
});

test('Razer BlackShark V3 X: feature report 7, checksum over bytes 3-60', () => {
  const [level, charge] = entry(0x1532, 0x057d).steps;
  assert.equal(level.request[62], 0x85);
  assert.equal(charge.request[62], 0x81);
  const reply = (cmd, value) => { const f = frame([0x07, 0x02, 0x03, 0, 0, 0, 0x02, 0x07, cmd, 0, value]); f[62] = xor(f.slice(3, 61)); return f; };
  assert.deepEqual(level.parse(reply(0x80, 49)), { capacity: 49 });
  assert.deepEqual(charge.parse(reply(0x84, 1)), { charging: true });
  const busy = reply(0x80, 49); busy[1] = 0x01;
  assert.equal(level.parse(busy), null);
});

test('ASUS Strix Go and TUF H3, HyperX Cloud Core: Avnera millivolts to levels', () => {
  const go = entry(0x0b05, 0x18d6).steps[0];
  const goReply = (chg, mv) => frame([0xff, 0x1b, 0, 0, 0, 0, 0, 0, 0, chg, 0, mv & 0xff, mv >> 8]);
  assert.deepEqual(go.parse(goReply(0x03, 3850)), { capacity: 75, charging: false, voltageMv: 3850 });
  assert.equal(go.parse(goReply(0x0a, 4300)).capacity, 100);
  assert.equal(go.parse(frame([0xff, 0x00])).offline, true);
  assert.equal(entry(0x0b05, 0x18d7).steps[0].parse(goReply(0x03, 3850)).charging, true);
  const tuf = entry(0x0b05, 0x1963).steps[0];
  const tufReply = (chg, mv) => frame([0xff, 0x12, 0x05, 0xfe, 0x0c, 0x04, 0x1f, 0x0b, 0x01, chg, 0, mv & 0xff, mv >> 8]);
  assert.equal(tuf.parse(tufReply(0x03, 3904)).capacity % 25, 0);
  assert.equal(tuf.parse(tufReply(0x0a, 3904)), null);
  const core = entry(0x0951, 0x173f).steps[0];
  assert.equal(core.parse(frame([0xff, 0x12, 0x05, 0xfe, 0, 0, 0, 0, 0, 0x05, 0, 0x2c, 0x0f])).charging, true);
  // A millivolt value no cell can have is a stray frame, not a low battery; 0 is off.
  assert.equal(core.parse(frame([0xff, 0x12, 0x05, 0xfe, 0, 0, 0, 0, 0, 0x03, 0, 0x10, 0x00])), null);
  assert.equal(tuf.parse(tufReply(0x03, 0)).offline, true);
  assert.equal(tuf.parse(tufReply(0x03, 6000)), null);
  assert.equal(go.parse(goReply(0x03, 900)), null);
});

test('HyperX Cloud Alpha 2: on/off first, then level and charging', () => {
  const [on, level] = entry(0x03f0, 0x08be).steps;
  assert.equal(on.parse(frame([0x53, 0x01, 0])).offline, true);
  assert.deepEqual(on.parse(frame([0x53, 0x01, 1])), {});
  assert.deepEqual(level.parse(frame([0x51, 0x02, 91, 1])), { capacity: 91, charging: true });
});

test('SteelSeries Nova Pro Omni / Elite and GameBuds', () => {
  const omni = entry(0x1038, 0x2290).steps[0];
  const reply = (level, status) => { const f = frame([0x01, 0xb0]); f[6] = level; f[15] = status; return f; };
  assert.deepEqual(omni.parse(reply(31, 0x02)), { capacity: 31, charging: true });
  assert.equal(omni.parse(reply(31, 0x01)).offline, true);
  assert.equal(omni.parse(reply(0, 0x08)).offline, true);
  assert.equal(omni.parse(reply(140, 0x08)), null); // a protocol error, not the headset being off
  const buds = entry(0x1038, 0x230a).steps[0];
  // Only buds out of the case (3) count, as HeadsetControl reads them; a docked bud (2) is charging.
  assert.deepEqual(buds.parse(frame([0xb0, 0, 0, 0x03, 0x02, 80, 64])), { capacity: 80, charging: false });
  assert.deepEqual(buds.parse(frame([0xb0, 0, 0, 0x03, 0x03, 80, 64])), { capacity: 64, charging: false });
  assert.equal(buds.parse(frame([0xb0, 0, 0, 0x02, 0x02, 80, 64])).offline, true);
  assert.deepEqual(buds.parse(frame([0xb0, 0, 0, 0x03, 0x00, 80, 0])), { capacity: 80, charging: false });
  assert.equal(buds.parse(frame([0xb0, 0, 0, 0x00, 0x00, 0, 0])).offline, true);
});

test('Logitech G325 and PRO X 2: fixed-index requests and their replies', () => {
  const g325 = entry(0x046d, 0x0b21).steps[0];
  assert.deepEqual(g325.request.slice(0, 11), [0x50, 0x23, 0x0b, 0x00, 0x03, 0x1a, 0x00, 0x03, 0x00, 0x07, 0x0a]);
  assert.equal(g325.parse(frame([0x50, 0x23, 0x03, 0x00, 0x03, 0x1a])), null); // the acknowledgement
  assert.deepEqual(g325.parse(frame([0x50, 0x23, 0x0b, 0x00, 0x03, 0x10, 0x00, 0x06, 0x00, 0x07, 0x0a, 0xb4, 72, 0x02])), { capacity: 72, charging: true });
  const x2 = entry(0x046d, 0x0af7).steps[0];
  assert.deepEqual(x2.parse(frame([0x51, 0x0b, 0, 0, 0, 0, 0, 0, 0x04, 0, 75, 0, 0x00])), { capacity: 75, charging: false });
  assert.equal(x2.parse(frame([0x51, 0x05, 0, 0, 0, 0, 0x00])).offline, true);
  assert.equal(x2.parse(frame([0x51, 0x03, 0, 0, 0, 0, 0])), null);
});

test('Jabra GN battery, Lenovo VoIP, Poly BT600 and JBL Quantum', () => {
  const link = entry(0x0b0e, 0x2e51).steps[0];
  assert.deepEqual(link.request.slice(0, 7), [0x05, 0x04, 0x00, 0x5a, 0x46, 0x12, 0x02]);
  assert.deepEqual(link.parse(frame([0x05, 0x01, 0x04, 0x5a, 0xc6, 0x12, 0x02, 0x01, 66])), { capacity: 66, charging: true });
  assert.equal(link.parse(frame([0x05, 0x01, 0x04, 0x5a, 0xc6, 0xfe, 0xf4])).offline, true);
  assert.equal(entry(0x0b0e, 0x2548).steps[0].request[1], 0x08);
  const lenovo = entry(0x17ef, 0xa07d).steps[0];
  assert.equal(lenovo.via, 'feature-input');
  assert.deepEqual(lenovo.parse(frame([0x27, 0x01, 0x00, 0, 0, 0, 0, 58], 61)), { capacity: 58 });
  assert.equal(lenovo.parse(frame([0x27, 0x01, 0x01], 61)).offline, true);
  const poly = entry(0x047f, 0x02ee).steps;
  assert.equal(poly.length, 4);
  assert.deepEqual(poly[3].parse(frame([0x07, 0x01, 0x01, 0x10, 0x0c, 0x02, 0, 0, 0x03, 0x0a, 0x1a, 3, 5, 1])), { capacity: 75, charging: true });
  const [link68, level49] = entry(0x0ecb, 0x2069).steps;
  assert.equal(link68.parse([0x68, 0]).offline, true);
  assert.deepEqual(level49.parse([0x49, 85]), { capacity: 85 });
});

test('none of the new headset entries steals a device another driver reads', () => {
  // The Razer BlackShark V3 cable and dongle stay on their own entry.
  assert.equal(entry(0x1532, 0x0577).name, 'Razer BlackShark V3');
  assert.equal(detectDriver({ vendorId: 0x1532, productId: 0x0565, channels: [ch(0xff14, 0x01, 3)] }).id, 'tabled');
  assert.equal(detectDriver({ vendorId: 0x1532, productId: 0x0565, channels: [ch(0xff00, 0x01, 3)] }), null);
});
