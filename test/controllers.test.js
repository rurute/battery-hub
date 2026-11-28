const test = require('node:test');
const assert = require('node:assert');
const { detectDriver } = require('../src/main/hid/drivers');
const c = require('../src/main/hid/drivers/controllers');

const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });

test('controllers are claimed only with the collection their battery comes on', () => {
  assert.equal(detectDriver({ vendorId: 0x37d7, productId: 0x2401, channels: [ch(1, 5), ch(0xffa0, 1)] }).id, 'controllers');
  assert.equal(detectDriver({ vendorId: 0x37d7, productId: 0x2401, channels: [ch(1, 5)] }), null);
  assert.equal(detectDriver({ vendorId: 0x2dc8, productId: 0x6012, channels: [ch(1, 5)] }).id, 'controllers');
  assert.equal((detectDriver({ vendorId: 0x2dc8, productId: 0x6003, channels: [ch(1, 5)] }) || {}).id, undefined); // Pro 2 needs a mode switch
  assert.equal(detectDriver({ vendorId: 0x28de, productId: 0x1142, channels: [ch(0xff00, 1)] }).id, 'controllers');
  assert.equal(detectDriver({ vendorId: 0x2e8a, productId: 0x10df, channels: [ch(1, 5)] }).id, 'controllers');
});

test('Flydigi: GET_INFO, level x20 (x10 on the Apex 6), charging and full', () => {
  assert.deepEqual(c.flydigiRequest(0x2401)[0], [0x00, 0x5a, 0xa5, 0x01, 0x02, 0x03]);
  assert.equal(c.flydigiRequest(0x2501)[0][0], 0x03);
  const reply = (power, id = []) => id.concat([0x5a, 0xa5, 0x01, 0, 0, 130, 1, 0, 0, 0, 0, power, 0, 0, 0, 0, 0]);
  assert.deepEqual(c.parseFlydigi(reply(0x04), 0x2401), { capacity: 80, charging: false });
  assert.deepEqual(c.parseFlydigi(reply(0x13, [0x03]), 0x2501), { capacity: 60, charging: true });
  assert.deepEqual(c.parseFlydigi(reply(0x07), 0x2502), { capacity: 70, charging: false });
  assert.deepEqual(c.parseFlydigi(reply(0x25), 0x2401), { capacity: 100, charging: false });
  assert.equal(c.parseFlydigi(reply(0x34), 0x2401), null);
  assert.equal(c.parseFlydigi([0x5a, 0xa5, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0x04], 0x2401), null);
});

test('8BitDo, Steam Controllers, SHIELD, Luna and SInput read what their reports carry', () => {
  const eight = new Array(34).fill(0); eight[0] = 0x03; eight[14] = 0x80 | 64;
  assert.deepEqual(c.parse8BitDo(eight), { capacity: 64, charging: true });
  const steam = new Array(64).fill(0); steam[0] = 1; steam[2] = 4; steam[14] = 72;
  assert.deepEqual(c.parseSteam2015(steam), { capacity: 72 });
  const gone = new Array(64).fill(0); gone[0] = 1; gone[2] = 3; gone[4] = 1;
  assert.equal(c.parseSteam2015(gone).offline, true);
  assert.deepEqual(c.parseSteam2026([0x43, 2, 55, 0, 0]), { capacity: 55, charging: true });
  assert.equal(c.parseSteam2026([0x43, 3, 55]), null);
  assert.deepEqual(c.parseShield([0x03, 0x07, 1, 0, 0, 4]), { capacity: 80 });
  assert.deepEqual(c.parseLuna([0x04, 255]), { capacity: 100 });
  assert.deepEqual(c.parseSInput([0x01, 4, 90]), { capacity: 90, charging: false });
  assert.equal(c.parseSInput([0x01, 1, 90]), null);
});
