const test = require('node:test');
const assert = require('node:assert');
const { detectDriver } = require('../src/main/hid/drivers');
const rapoo = require('../src/main/hid/drivers/rapoo');
const gearhub = require('../src/main/hid/drivers/gearhub');
const bytech = require('../src/main/hid/drivers/bytech');

const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });

test('Rapoo VT mice report their level in input report 7', () => {
  assert.equal(detectDriver({ vendorId: 0x24ae, productId: 0x1413, channels: [ch(0xff00, 0x0e), ch(0xff00, 0x02)] }).id, 'rapoo');
  assert.deepEqual(rapoo.parseStatus([0x07, 0x21, 1, 0x20, 0x03, 0x20, 0x03, 0x02, 77]), { capacity: 77, charging: true });
  assert.deepEqual(rapoo.parseStatus([0x07, 0x11, 1, 0x20, 0x03, 0x20, 0x03, 0x00, 55]), { capacity: 55, charging: false });
  assert.equal(rapoo.parseStatus([0x07, 0x21, 1, 0, 0, 0, 0, 0, 1]), null);
  assert.equal(rapoo.parseStatus([0x07, 0x31, 1, 0, 0, 0, 0, 0, 50]), null);
  assert.equal(rapoo.UNLOCK.length, 33);
});

test('YICHIP GearHub receivers hold the mouse and keyboard levels', () => {
  const layout = [ch(0xffff, 1), ch(0xffff, 2), ch(1, 2)];
  assert.equal(detectDriver({ vendorId: 0x3151, productId: 0x4026, channels: layout }).id, 'gearhub');
  assert.notEqual((detectDriver({ vendorId: 0x3151, productId: 0x1020, channels: [ch(0xffbc, 0x88)] }) || {}).id, 'gearhub');
  assert.deepEqual(gearhub.parseReply([0, 1, 0, 0x2d, 1, 0, 1], 'mouse'), { capacity: 45 });
  assert.deepEqual(gearhub.parseReply([0, 1, 80, 0x2d, 0, 0, 1], 'keyboard'), { capacity: 80 });
  assert.equal(gearhub.parseReply([0, 1, 80, 0x2d, 0, 1, 1], 'mouse').offline, true);
  assert.equal(gearhub.parseReply([0, 0, 0, 0, 0, 0, 0], 'mouse'), null);
  assert.equal(gearhub.REQUEST.length, 65);
});

test('BY Tech mice answer basic info in feature report 3', () => {
  assert.equal(detectDriver({ vendorId: 0x372e, productId: 0x1014, channels: [ch(0xff00, 1), ch(0xff06, 1)] }).id, 'bytech');
  assert.equal(bytech.REQUEST[1], (0x50 + 0x02 + 0x4f + 0x81) & 0xff);
  assert.deepEqual(bytech.parseReply([0x03, 0, 0, 0, 0x02, 0, 64]), { capacity: 64 });
  assert.deepEqual(bytech.parseReply([0x03, 0, 0, 0, 0x02, 0, 0xe4]), { capacity: 100 });
  assert.equal(bytech.parseReply([0x03, 0, 0, 0, 0x0a, 0, 64]), null);
});

test('Bloody wireless mice answer with report 6 on 0xFF01', () => {
  const bloody = require('../src/main/hid/drivers/bloody');
  assert.equal(detectDriver({ vendorId: 0x1956, productId: 0x3031, channels: [ch(0xff02, 1), ch(0xff01, 1), ch(0xff00, 1)] }).id, 'bloody');
  assert.deepEqual(bloody.parseStatus([0x06, 0x56, 81, 0]), { capacity: 81, charging: false });
  assert.deepEqual(bloody.parseStatus([0x06, 0x56, 81, 1]), { capacity: 81, charging: true });
  assert.equal(bloody.parseStatus([0x06, 0x56, 0xff, 0]).offline, true);
  assert.equal(bloody.parseStatus([0x06, 0x57, 81, 0]), null);
});

test('Darmoshark answers feature report 0x51, Telink mice get a summed retry, AULA receivers answer 20 01', () => {
  const darmoshark = require('../src/main/hid/drivers/darmoshark');
  assert.equal(detectDriver({ vendorId: 0x248a, productId: 0xff12, channels: [ch(0x008c, 1), ch(1, 2)] }).id, 'darmoshark');
  assert.notEqual((detectDriver({ vendorId: 0x248a, productId: 0x5c2e, channels: [ch(0x008c, 1)] }) || {}).id, 'darmoshark');
  const reply = [0x51, 0x06, 1, 0, 0, 0, 0, 0, 0, 0, 0, 67].concat(new Array(9).fill(0));
  assert.deepEqual(darmoshark.parseReply(reply), { capacity: 67 });
  assert.equal(darmoshark.parseReply([0x51, 0x06, 0].concat(new Array(18).fill(0))), null);
  const akko = require('../src/main/hid/drivers/akko');
  assert.deepEqual(akko.REQUEST_SUMMED.slice(0, 5), [0x04, 0x20, 0x00, 0x1a, 0x06]);
  const aula = require('../src/main/hid/drivers/table').DEVICES.find((e) => e.vendorId === 0x0c45 && e.productIds.includes(0xfefe) && !e.product).steps[0];
  assert.equal(aula.request.length, 33);
  assert.equal(aula.request.slice(1, 32).reduce((a, b) => a + b, 0) & 0xff, aula.request[32]);
  assert.deepEqual(aula.parse([0x20, 0x01, 0x00, 76]), { capacity: 76 });
});

test('a Bluetooth LE battery read joins the same device seen as HID', () => {
  const { identityOf } = require('../src/main/identity');
  assert.equal(identityOf({ id: 'ble:D228599C0140' }), 'mac:d228599c0140');
  assert.equal(identityOf({ id: 'bt:BTHLE\Dev_d228599c0140\8&1420c792&0&d228599c0140' }), 'mac:d228599c0140');
});
