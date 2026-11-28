// HID++ 0x0003 Device Information as the proof that a cable and a Lightspeed slot are one unit.
// The replies are what the G913 TKL sent on 2026-11-28, on its cable (c343, index 0xff) and
// through the c547 receiver (slot 1): the same except for the device index byte.
const test = require('node:test');
const assert = require('node:assert');
const { pad } = require('../src/main/hid/drivers/exchange');

const G913 = 'logi:b35f408ec343:71b82111';
const G913_INFO = [0x05, 0x71, 0xb8, 0x21, 0x11, 0x00, 0x0e, 0xb3, 0x5f, 0x40, 0x8e, 0xc3, 0x43, 0x04, 0x00, 0x00];
const LONG = [{ path: 'k', usagePage: 0xff00, usage: 0x02 }];
const cable = { product: 'G913 TKL LIGHTSPEED Wireless RGB Mechanical Gaming Keyboard', vendorId: 0x046d, productId: 0xc343, channels: LONG };
const child = { product: 'G913 TKL', vendorId: 0x046d, productId: 0xc547, channels: LONG, receiver: { slot: 1, wpid: 0x408e, kind: 1 } };
const receiverCard = { product: 'USB Receiver', vendorId: 0x046d, productId: 0xc539, channels: LONG };

// A keyboard with 0x0003 at feature index 2 that answers getDeviceInfo with `info`.
function keyboard(calls, { info = G913_INFO, featureIndex = 0x02, silent = false } = {}) {
  return async (channel, request, accept) => {
    const [, device, index, fnSw] = request;
    calls.push({ device, index });
    if (silent) throw new Error('timeout waiting for battery response');
    if (index === 0) {
      const feature = (request[4] << 8) | request[5];
      return accept(pad([0x11, device, 0x00, fnSw, feature === 0x0003 ? featureIndex : 0], 20));
    }
    if (index === featureIndex && fnSw >> 4 === 0) return accept(pad([0x11, device, index, fnSw, ...info], 20));
    throw new Error('timeout waiting for battery response');
  };
}

async function withExchange(fake, fn) {
  const exchange = require('../src/main/hid/drivers/exchange');
  const original = exchange.exchange;
  delete require.cache[require.resolve('../src/main/hid/drivers/hidpp')];
  exchange.exchange = fake;
  try {
    await fn(require('../src/main/hid/drivers/hidpp'));
  } finally {
    exchange.exchange = original;
    delete require.cache[require.resolve('../src/main/hid/drivers/hidpp')];
  }
}

test('identify: the G913 TKL gives the same identity on its cable and through the receiver', async () => {
  const calls = [];
  await withExchange(keyboard(calls), async (hidpp) => {
    assert.equal(await hidpp.identify(cable), G913);
    assert.equal(await hidpp.identify(child), G913);
    assert.deepEqual(calls.map((c) => c.device), [0xff, 0xff, 1, 1]);
  });
});

test('identify: two units of one model differ', async () => {
  const other = [...G913_INFO];
  other[4] = 0x12; // unit ID 71b82112
  await withExchange(keyboard([], { info: other }), async (hidpp) => {
    const id = await hidpp.identify(cable);
    assert.equal(id, 'logi:b35f408ec343:71b82112');
    assert.notEqual(id, G913);
  });
});

test('identify: no usable unit id gives null', async () => {
  for (const unit of [[0, 0, 0, 0], [0xff, 0xff, 0xff, 0xff]]) {
    const info = [...G913_INFO];
    info.splice(1, 4, ...unit);
    await withExchange(keyboard([], { info }), async (hidpp) => {
      assert.equal(await hidpp.identify(cable), null);
    });
  }
});

test('identify: no 0x0003 feature gives null', async () => {
  const calls = [];
  await withExchange(keyboard(calls, { featureIndex: 0 }), async (hidpp) => {
    assert.equal(await hidpp.identify(cable), null);
    assert.deepEqual(calls.map((c) => c.index), [0], 'getDeviceInfo is never sent');
  });
});

test('identify: a silent device throws', async () => {
  await withExchange(keyboard([], { silent: true }), async (hidpp) => {
    await assert.rejects(hidpp.identify(child), /^Error: timeout waiting/);
  });
});

test('identify: a receiver card is never asked', async () => {
  const calls = [];
  await withExchange(keyboard(calls), async (hidpp) => {
    assert.equal(await hidpp.identify(receiverCard), null);
    assert.equal(calls.length, 0);
  });
});

test('identityFromInfo reads unit ID at [1..4] and modelId at [7..12]', () => {
  const hidpp = require('../src/main/hid/drivers/hidpp');
  assert.equal(hidpp.identityFromInfo(G913_INFO), G913);
  assert.equal(hidpp.identityFromInfo([0x05, 0, 0, 0, 0, 0x00, 0x0e, 0xb3, 0x5f, 0x40, 0x8e, 0xc3, 0x43]), null);
});

test('hidpp asks the poller to identify', () => {
  assert.equal(require('../src/main/hid/drivers/hidpp').needsIdentify, true);
});
