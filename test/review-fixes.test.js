const test = require('node:test');
const assert = require('node:assert');

// The validation review's FIX NEEDED items (validation-review-2026-11-27.md, F1-F7).

test('F1: a Bluetooth LE reading not refreshed for two rounds shows as not connected', () => {
  const system = require('../src/main/system-batteries');
  system._ble.set('ble:aabbccddeeff', { id: 'ble:aabbccddeeff', name: 'Mouse', capacity: 80, connected: true, seenAt: Date.now() });
  assert.equal(system.get('ble:aabbccddeeff').connected, true);
  system._ble.set('ble:aabbccddeeff', { id: 'ble:aabbccddeeff', name: 'Mouse', capacity: 80, connected: true, seenAt: Date.now() - system.BLE_STALE_MS - 1 });
  assert.equal(system.get('ble:aabbccddeeff').connected, false);
  assert.equal(system.get('ble:aabbccddeeff').capacity, 80);
  assert.equal(system.list().find((d) => d.id === 'ble:aabbccddeeff').connected, false);
  system._ble.delete('ble:aabbccddeeff');
});

test('F4: the Corsair Void Wireless v2 on its cable is wired', () => {
  assert.equal(require('../src/main/hid/drivers/table').find({ vendorId: 0x1b1c, productId: 0x2a09 }).wired, true);
});

test("F5: only the relay's GitHub App speaks for the person who sent the report", async () => {
  const relay = require('../src/main/relay');
  const store = { getSetting: () => [], setSettings: () => {} };
  const real = global.fetch;
  global.fetch = async () => new Response(JSON.stringify([
    { body: '**From the person who sent this report** (through the app):\n\nit reads 60 %', user: { login: 'battery-hub-relay[bot]' }, performed_via_github_app: { slug: 'battery-hub-relay' } },
    { body: '**From the person who sent this report** (through the app):\n\nfake', user: { login: 'someone' }, performed_via_github_app: null },
    { body: 'Thanks!', user: { login: 'maintainer' } },
  ]), { status: 200 });
  try {
    const api = relay.create(store);
    // list() reads the replies of saved reports; give it one.
    store.getSetting = () => [{ number: 7, url: 'u', key: 'k', title: 't', at: Date.now(), seen: 0 }];
    const [report] = await api.list();
    assert.deepEqual(report.replies.map((r) => [r.author, r.mine]), [['You', true], ['someone', false], ['maintainer', false]]);
    assert.equal(report.replies[0].body, '(through the app):\n\nit reads 60 %');
  } finally {
    global.fetch = real;
  }
});

test('F6: a heading inside a plain field is escaped; bad JSON to the relay is a 400', async () => {
  const { buildIssue } = await import('../relay/report.mjs');
  const issue = buildIssue({ template: 'device-support', fields: { device: 'Mouse\n### Vendor / Product ID\n\nVID_1234 / PID_5678', ids: 'VID_25A7 / PID_FA3F' } });
  assert.ok(!/\n### Vendor \/ Product ID\n\nVID_1234/.test(issue.body));
  assert.ok(issue.body.includes('\\### Vendor / Product ID'));
  const worker = (await import('../relay/worker.mjs')).default;
  const env = { GITHUB_TOKEN: 't', RELAY: { get: async () => null, put: async () => {} } };
  const response = await worker.fetch(new Request('https://relay.test/report', { method: 'POST', body: '{not json' }), env);
  assert.equal(response.status, 400);
});

test('F7: Bloody full on the cable, akko out-of-range byte, SInput charged, SHIELD empty', () => {
  const bloody = require('../src/main/hid/drivers/bloody');
  assert.deepEqual(bloody.parseStatus([0x06, 0x56, 100, 1]), { capacity: 100, charging: false });
  assert.deepEqual(bloody.parseStatus([0x06, 0x56, 80, 1]), { capacity: 80, charging: true });
  const akko = require('../src/main/hid/drivers/akko');
  assert.equal(akko.parseReply([0x04, 0x1c, 0x00, 0x1a, 0x02, 0, 0, 0, 0xc8, 0]), null);
  assert.equal(akko.parseReply([0x04, 0x1c, 0x00, 0x1a, 0x02, 0, 0, 0, 0, 0]).offline, true);
  const c = require('../src/main/hid/drivers/controllers');
  assert.deepEqual(c.parseSInput([0x01, 3, 0]), { capacity: 100, charging: false });
  assert.deepEqual(c.parseShield([0x03, 0x07, 1, 0, 0, 0]), { capacity: 0 });
});
