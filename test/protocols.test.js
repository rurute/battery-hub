// Battery protocols, checked against the byte layouts documented by HeadsetControl, OpenRazer,
// rivalcfg and the Linux kernel. Most of these devices aren't available to test on hardware.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return {};
  return load.call(this, request, ...rest);
};
const table = require('../src/main/hid/drivers/table');
const { channelsFor } = require('../src/main/hid/drivers/tabled');
const hidpp = require('../src/main/hid/drivers/hidpp');
const razer = require('../src/main/hid/drivers/razer');
const razerDevices = require('../src/main/hid/drivers/razer-devices');
const playstation = require('../src/main/hid/drivers/playstation');
const audeze = require('../src/main/hid/drivers/audeze');
const { detectDriver } = require('../src/main/hid/drivers');
const { pad, scale, fromVoltage } = require('../src/main/hid/drivers/exchange');
const { parseScan } = require('../src/main/system-batteries');
const { identityOf, routesOf, planMerges } = require('../src/main/identity');
Module._load = load;

const entry = (vendorId, productId) => table.find({ vendorId, productId });
const frame = (bytes) => pad(bytes, 64);

test('no product id is claimed twice in the device table', () => {
  const seen = new Set();
  for (const d of table.DEVICES) {
    for (const pid of d.productIds) {
      const key = `${d.vendorId}:${pid}`;
      assert.ok(!seen.has(key), key);
      seen.add(key);
    }
  }
});

test('every table entry has a request to send and a parser', () => {
  for (const d of table.DEVICES) {
    assert.ok(d.steps.length > 0 && d.kind, d.name);
    for (const step of d.steps) assert.ok(step.request.length > 0 && typeof step.parse === 'function', d.name);
  }
});

test('Arctis Nova 7 reads levels and percent by model, and knows when the headset is off', () => {
  const parse = entry(0x1038, 0x2202).steps[0].parse;
  assert.deepEqual(parse(frame([0, 0, 3, 3]), 0x2202), { capacity: 75, charging: false });
  assert.deepEqual(parse(frame([0, 0, 0x64, 1]), 0x227e), { capacity: 100, charging: true });
  assert.deepEqual(parse(frame([0, 0, 41, 3]), 0x227e), { capacity: 41, charging: false });
  assert.equal(parse(frame([0, 0, 0, 0]), 0x2202).offline, true);
});

test('Arctis 9 maps its raw range onto a percentage', () => {
  const parse = entry(0x1038, 0x12c2).steps[0].parse;
  assert.equal(parse(frame([0, 0, 0, 0x64, 0])).capacity, 0);
  assert.equal(parse(frame([0, 0, 0, 0x9a, 1])).capacity, 100);
  assert.equal(parse(frame([0, 0, 0, 0x7f, 1])).charging, true);
});

test('Corsair Void clears the microphone flag from the level', () => {
  const parse = entry(0x1b1c, 0x0a14).steps[0].parse;
  assert.deepEqual(parse([100, 0, 0x80 | 57, 177, 1]), { capacity: 57, charging: false });
  assert.equal(parse([100, 0, 40, 177, 5]).charging, true);
  assert.equal(parse([100, 0, 0, 177, 0]).offline, true);
  assert.equal(parse([99, 0, 40, 177, 1]), null);
});

test('HyperX Cloud Alpha Wireless needs all three answers', () => {
  const [link, charge, level] = entry(0x03f0, 0x098d).steps;
  assert.equal(link.parse(frame([0x21, 0xbb, 0x03, 0x01])).offline, true);
  assert.deepEqual(charge.parse(frame([0x21, 0xbb, 0x0c, 0x01])), { charging: true });
  assert.deepEqual(level.parse(frame([0x21, 0xbb, 0x0b, 66])), { capacity: 66 });
  assert.equal(level.parse(frame([0x21, 0xbb, 0x0c, 66])), null);
});

test('HyperX Cloud Alpha Wireless: a level of 0 is not a reading', () => {
  const level = entry(0x03f0, 0x098d).steps[2];
  assert.equal(level.parse(frame([0x21, 0xbb, 0x0b, 0]), 0x098d, { charging: false }).offline, true);
  assert.deepEqual(level.parse(frame([0x21, 0xbb, 0x0b, 0]), 0x098d, { charging: true }), {});
});

test('Logitech headsets convert voltage through the model curve', () => {
  const parse = entry(0x046d, 0x0ab5).steps[0].parse;
  const at = (mv, state) => parse(pad([0x11, 0xff, 8, 0x0a, mv >> 8, mv & 0xff, state], 20));
  assert.equal(at(4100, 1).capacity, 100);
  assert.equal(at(3750, 1).capacity, 40);
  assert.equal(at(3750, 3).charging, true);
  assert.equal(at(3000, 1).offline, true);
});

test('SteelSeries wireless mice decode the level and charge flag', () => {
  const aerox = entry(0x1038, 0x1838);
  assert.deepEqual(aerox.steps[0].request, [0x00, 0xd2]);
  assert.deepEqual(aerox.steps[0].parse([0xd2, 15]), { capacity: 70, charging: false });
  assert.deepEqual(aerox.steps[0].parse([0xd2, 0x80 | 21]), { capacity: 100, charging: true });
  assert.deepEqual(entry(0x1038, 0x1830).steps[0].parse([54, 0, 1]), { capacity: 54, charging: true });
});

test('a table entry only opens the collection the protocol lives on', () => {
  const device = {
    vendorId: 0x1038, productId: 0x2202,
    channels: [
      { usagePage: 0x0c, usage: 1, interface: 0, path: 'a' },
      { usagePage: 0xffc0, usage: 1, interface: 3, path: 'b' },
    ],
  };
  assert.deepEqual(channelsFor(device, table.find(device)).map((c) => c.path), ['b']);
});

test('HID++ requests are long reports for the right device and function', () => {
  assert.deepEqual(hidpp.request(1, 0x00, 0, [0x10, 0x04]).slice(0, 6), [0x11, 1, 0x00, 0x0b, 0x10, 0x04]);
  assert.equal(hidpp.request(1, 6, 1).length, 20);
});

test('HID++ replies are matched to the call, and errors are told apart', () => {
  const reply = pad([0x11, 1, 6, 0x1b, 80, 8, 0, 0], 20);
  assert.equal(hidpp.replyTo(reply, 1, 6, 1)[0], 80);
  assert.equal(hidpp.replyTo(reply, 2, 6, 1), null);
  assert.equal(hidpp.replyTo(reply, 1, 7, 1), null);
  // The receiver can't reach the device (Linux: resource error, unknown device; Solaar: connect failed)
  for (const code of [0x04, 0x08, 0x09]) {
    assert.throws(() => hidpp.replyTo(pad([0x10, 1, 0x8f, 6, 0x1b, code], 20), 1, 6, 1), /^Error: device is off$/);
  }
  // The device itself answered with an error, so it is on
  assert.throws(() => hidpp.replyTo(pad([0x11, 1, 0xff, 6, 0x1b, 5], 20), 1, 6, 1), /refused the request \(error 5\)/);
  assert.throws(() => hidpp.replyTo(pad([0x10, 1, 0x8f, 6, 0x1b, 0x01], 20), 1, 6, 1), /refused/);
  // Errors for someone else's request (another feature, or G HUB's function and software id)
  assert.equal(hidpp.replyTo(pad([0x11, 1, 0xff, 9, 0x1b, 5], 20), 1, 6, 1), null);
  assert.equal(hidpp.replyTo(pad([0x11, 1, 0xff, 6, 0x1a, 5], 20), 1, 6, 1), null);
  assert.equal(hidpp.replyTo(pad([0x10, 1, 0x8f, 6, 0x13, 0x09], 20), 1, 6, 1), null);
});

test('HID++ battery features decode percent, levels, and voltage', () => {
  assert.deepEqual(hidpp.parseUnified([73, 4, 0, 0]), { capacity: 73, charging: false });
  assert.deepEqual(hidpp.parseUnified([0, 2, 1, 1]), { capacity: 20, charging: true });
  assert.deepEqual(hidpp.parseUnified([0, 8, 3, 1]), { capacity: 100, charging: true });
  assert.deepEqual(hidpp.parseStatus([50, 30, 0]), { capacity: 50, charging: false });
  assert.equal(hidpp.parseStatus([0, 0, 1]).charging, true);
  assert.equal(hidpp.parseVoltage([0x0f, 0x00, 0x00]).capacity, 53);
  assert.equal(hidpp.parseVoltage([0x10, 0x00, 0x80]).charging, true);
});

test('Razer requests carry the checksum OpenRazer computes', () => {
  const report = razer.buildRequest(0x1f, 0x80);
  assert.equal(report.length, 90);
  assert.deepEqual(report.slice(0, 8), [0, 0x1f, 0, 0, 0, 2, 7, 0x80]);
  assert.equal(report[88], 2 ^ 7 ^ 0x80);
});

test('Razer replies are checked before use', () => {
  const reply = new Array(90).fill(0);
  Object.assign(reply, { 0: 2, 6: 7, 7: 0x80, 9: 128 });
  assert.equal(razer.parseReply(reply, 0x80)[1], 128);
  assert.equal(razer.parseReply(reply, 0x84), null);
  assert.equal(razer.parseReply({ ...reply, length: 90, 0: 3, slice: reply.slice }, 0x80), null);
});

test('Razer table uses the transaction id each model needs', () => {
  const pids = new Set(razerDevices.map(([pid]) => pid));
  assert.equal(pids.size, razerDevices.length);
  const viper = razerDevices.find(([, , name]) => name === 'viper v2 pro wireless');
  assert.equal(viper[1], 0x1f);
});

test('DualSense reads battery over USB and Bluetooth', () => {
  const usb = new Array(64).fill(0);
  usb[0] = 0x01;
  usb[53] = 0x07;
  assert.deepEqual(playstation.parseDualSense(usb), { capacity: 75, charging: false });
  usb[53] = 0x14;
  assert.deepEqual(playstation.parseDualSense(usb), { capacity: 45, charging: true });
  usb[53] = 0x2a;
  assert.deepEqual(playstation.parseDualSense(usb), { capacity: 100, charging: true });
  usb[53] = 0xa0;
  assert.equal(playstation.parseDualSense(usb), null);
  const bt = new Array(78).fill(0);
  bt[0] = 0x31;
  bt[54] = 0x09;
  assert.equal(playstation.parseDualSense(bt, true).capacity, 95);
});

test('a short Bluetooth report is never mistaken for an empty battery', () => {
  const short = new Array(78).fill(0); // what the real controller sent: padded with zeros
  short[0] = 0x01;
  assert.equal(playstation.parseDualSense(short, true), null);
  assert.equal(playstation.parseDualShock4(short, true), null);
});

test('DualShock 4 reads battery over USB and Bluetooth', () => {
  const usb = new Array(64).fill(0);
  usb[0] = 0x01;
  usb[30] = 0x05;
  assert.deepEqual(playstation.parseDualShock4(usb), { capacity: 55, charging: false });
  usb[30] = 0x1b;
  assert.deepEqual(playstation.parseDualShock4(usb), { capacity: 100, charging: true });
  const bt = new Array(78).fill(0);
  bt[0] = 0x11;
  bt[32] = 0x12;
  assert.deepEqual(playstation.parseDualShock4(bt, true), { capacity: 25, charging: true });
});

test('Audeze request matches the documented bytes', () => {
  const report = audeze.buildRequest();
  assert.equal(report.length, 62);
  assert.deepEqual(report.slice(0, 10), [0x06, 7, 0x80, 0x05, 0x5a, 3, 0, 0xd6, 0x0c, 0x00]);
});

test('Audeze finds the battery in the message stream, even split across reports', () => {
  const ack = [0x07, 7, 0x80, 0x05, 0x5b, 3, 0, 0xd6, 0x0c, 0x00];
  assert.deepEqual(audeze.parseReports([pad(ack, 62), pad([0x07, 9, 0x80, 0x05, 0x5d, 5, 0, 0xd6, 0x0c, 0, 0, 87], 62)]), { capacity: 87, charging: null });
  assert.equal(audeze.parseReports([pad([0x07, 7, 0x80, 0x05, 0x5b, 3, 0, 0xd6, 0x0c, 0x05], 62)]).off, true);
  assert.equal(audeze.parseReports([pad(ack, 62)]), null);
  assert.equal(audeze.parseReports([pad([0x07, 0, 0x80, 0x05, 0x5d, 5, 0, 0xd6, 0x0c, 0, 0, 87], 62)]), null);
  const split = [pad([0x07, 5, 0x80, 0x05, 0x5d, 5, 0, 0xd6], 62), pad([0x07, 4, 0x80, 0x0c, 0, 0, 42], 62)];
  assert.equal(audeze.parseReports(split).capacity, 42);
});

test('devices are routed to the right driver, and unknown ones are left alone', () => {
  const channel = (usagePage, usage, iface) => ({ usagePage, usage, interface: iface, path: `${usagePage}/${usage}` });
  const device = (vendorId, productId, product, channels) => ({ vendorId, productId, product, channels });
  const id = (d) => (detectDriver(d) || { id: null }).id;
  assert.equal(id(device(0x046d, 0x0ab5, 'G733', [channel(0xff43, 0x0202, 3), channel(0xff00, 2, 2)])), 'tabled');
  assert.equal(id(device(0x046d, 0xc548, 'USB Receiver', [channel(0xff00, 2, 2)])), 'hidpp');
  assert.equal(id(device(0x046d, 0xc54f, 'USB Receiver', [channel(1, 6, 0), channel(0xff43, 0x0301, 2), channel(1, 2, 1), channel(0xff43, 0x0302, 2), channel(0x0c, 1, 2)])), 'hidpp');
  assert.equal(id(device(0x1532, 0x00a6, 'Razer', [channel(1, 2, 0)])), 'razer');
  assert.equal(id(device(0x054c, 0x0ce6, 'DualSense', [channel(1, 5, 3)])), 'playstation');
  assert.equal(id(device(0x3329, 0x4b19, 'Audeze Maxwell', [channel(0xff13, 1, 3)])), 'audeze');
  assert.equal(id(device(0x1b1c, 0x1b73, 'K70', [channel(0xff42, 1, 1)])), null);
  assert.equal(id(device(0x1234, 0x5678, 'Unknown', [channel(0xff00, 1, 0)])), null);
});

test('the same Bluetooth address means the same device, however it was reached', () => {
  const windows = { id: 'bt:BTHLE\\Dev_d228599c0140\\8&1420c792&0&d228599c0140' };
  const hid = { id: '1133:45122:d228599c0140', serialNumber: 'd228599c0140' };
  const saved = { id: '1133:45122:d228599c0140' };
  assert.equal(identityOf(windows), 'mac:d228599c0140');
  assert.equal(identityOf(hid), identityOf(windows));
  assert.equal(identityOf(saved), identityOf(windows));
  assert.equal(identityOf({ id: '13652:62858:' }), null);
  assert.equal(identityOf({ id: '1:2:ABC123', serialNumber: 'ABC123' }), null);
});

test('a card reads directly before asking Windows', () => {
  const card = { id: 'bt:x', driverId: 'system', links: [{ id: '1:2:abc', driverId: 'hidpp', profile: null }] };
  assert.deepEqual(routesOf(card).map((r) => r.id), ['1:2:abc', 'bt:x']);
});

test('duplicate cards merge, keeping the name and the longer history', () => {
  const plans = planMerges({
    a: { id: 'a', identity: 'mac:1', history: [1, 2, 3] },
    b: { id: 'b', identity: 'mac:1', customName: 'My pad', history: [1] },
    c: { id: 'c', identity: 'mac:2', history: [] },
    d: { id: 'd', history: [] },
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].keep.id, 'b');
  assert.deepEqual(plans[0].drop.map((c) => c.id), ['a']);
});

test('two controllers with different addresses stay separate', () => {
  assert.equal(planMerges({ a: { id: 'a', identity: 'mac:1' }, b: { id: 'b', identity: 'mac:2' } }).length, 0);
});

test('helpers scale and interpolate within range', () => {
  assert.equal(scale(2, 0, 4), 50);
  assert.equal(scale(9, 0, 4), 100);
  const curve = [[4000, 100], [3500, 0]];
  assert.equal(fromVoltage(4100, curve), 100);
  assert.equal(fromVoltage(3750, curve), 50);
  assert.equal(fromVoltage(3000, curve), 0);
});

test('a Windows scan parses one device or many, and rejects nonsense', () => {
  assert.equal(parseScan('[{"id":"bt:1","name":"Mouse","capacity":90,"connected":true}]').length, 1);
  assert.equal(parseScan('{"id":"bt:1","name":"Mouse","capacity":90}').length, 1);
  assert.equal(parseScan('[{"id":"bt:1","capacity":250}]').length, 0);
  assert.equal(parseScan('not json'), null);
});

test('switched-off devices read as off instead of a made-up level', () => {
  const aerox = entry(0x1038, 0x1838);
  assert.deepEqual(aerox.steps[0].parse([0xd2, 0]), { offline: true }); // rivalcfg: level -5
  assert.deepEqual(aerox.steps[0].parse([0xd2, 0x7f]), { offline: true });
  assert.deepEqual(entry(0x1038, 0x1830).steps[0].parse([0xff, 0, 0]), { offline: true });
  const g733 = entry(0x046d, 0x0ab5).steps[0];
  assert.deepEqual(g733.parse(pad([0x11, 0xff, 0xff, 0x08, 0x0a, 0x05], 20)), { offline: true });
  // Answers to other software's requests are not this headset's battery
  assert.equal(g733.parse(pad([0x11, 0xff, 0xff, 0x08, 0x1c, 0x05], 20)), null);
  assert.equal(g733.parse(pad([0x11, 0xff, 0x04, 0x0a, 0x0f, 0xa0, 1], 20)), null);
  assert.equal(g733.parse(pad([0x11, 0xff, 0x08, 0x1a, 0x0f, 0xa0, 1], 20)), null);
});

test('a razer receiver that times out on the mouse means the mouse is off', async () => {
  const timedOut = razer.buildRequest(0x1f, 0x80);
  timedOut[0] = 0x04;
  const dev = { sendFeatureReport: async () => {}, getFeatureReport: async () => [0, ...timedOut] };
  const session = require('../src/main/hid/session');
  const acquire = session.acquire;
  session.acquire = async () => dev;
  try {
    await assert.rejects(razer.readBattery({ id: 'r', productId: razerDevices[0][0], channels: [{ path: 'p', interface: 0 }] }), /^Error: device is not answering$/);
  } finally {
    session.acquire = acquire;
  }
});

test('a table device whose dongle never answers is not answering, unless it is on its cable', async () => {
  const exchange = require('../src/main/hid/drivers/exchange');
  const original = exchange.exchange;
  delete require.cache[require.resolve('../src/main/hid/drivers/tabled')];
  exchange.exchange = async () => { throw new Error('timeout waiting for battery response'); };
  try {
    const tabled = require('../src/main/hid/drivers/tabled');
    const device = { vendorId: 0x03f0, productId: 0x098d, channels: [{ path: 'a', usagePage: 0xff00 }, { path: 'b', usagePage: 0xff01 }] };
    await assert.rejects(tabled.readBattery(device), /^Error: headset is not answering$/);
    const cable = { vendorId: 0x1038, productId: 0x183a, channels: [{ path: 'c', usagePage: 0xffc0, interface: 3 }] };
    await assert.rejects(tabled.readBattery(cable), /^Error: timeout waiting for battery response$/);
  } finally {
    exchange.exchange = original;
    delete require.cache[require.resolve('../src/main/hid/drivers/tabled')];
  }
});

test('Logitech: a device that stops answering reads as off on the same poll, an unplugged one does not', async () => {
  const exchange = require('../src/main/hid/drivers/exchange');
  const original = exchange.exchange;
  const fresh = () => {
    delete require.cache[require.resolve('../src/main/hid/drivers/hidpp')];
    return require('../src/main/hid/drivers/hidpp');
  };
  const receiver = { product: 'USB Receiver', vendorId: 0x046d, channels: [{ path: 'r', usagePage: 0xff00, usage: 0x02 }] };
  try {
    // Slot 1 holds a mouse with Unified Battery at index 6, then it goes quiet.
    let on = true;
    exchange.exchange = async (channel, request, accept) => {
      const [, device, index, fnSw] = request;
      if (!on || device !== 1) throw new Error('timeout waiting for battery response');
      if (index === 0) return accept(pad([0x11, 1, 0, fnSw, request[4] === 0x10 && request[5] === 0x04 ? 6 : 0], 20));
      return accept(pad([0x11, 1, 6, fnSw, 64, 4, 0, 0], 20));
    };
    const hidpp2 = fresh();
    assert.equal((await hidpp2.readBattery(receiver)).capacity, 64);
    on = false;
    await assert.rejects(hidpp2.readBattery(receiver), /^Error: device is not answering$/);

    // Unplugged: the channel itself fails, which must reach the poller as it is.
    exchange.exchange = async () => { throw new Error('could not read data from device'); };
    await assert.rejects(fresh().readBattery(receiver), /could not read data/);
  } finally {
    exchange.exchange = original;
    delete require.cache[require.resolve('../src/main/hid/drivers/hidpp')];
  }
});

// The G913 TKL (slot 1, 0x1001 at index 7) and G502 X (slot 2, 0x1004 at index 6) on one receiver,
// with the readings recorded while investigating #210: 0x102d = 4141 mV, and 0x51 = 81%.
function twoDeviceReceiver(calls, { asleep = [] } = {}) {
  const features = { 1: { 0x1001: 7 }, 2: { 0x1004: 6 } };
  const readings = { 1: [0x10, 0x2d, 0x00], 2: [0x51, 0x08, 0x00, 0x00] };
  return async (channel, request, accept) => {
    const [, device, index, fnSw] = request;
    calls.push({ device, index });
    if (!features[device] || asleep.includes(device)) throw new Error('timeout waiting for battery response');
    if (index === 0) {
      const feature = (request[4] << 8) | request[5];
      return accept(pad([0x11, device, 0, fnSw, features[device][feature] || 0], 20));
    }
    return accept(pad([0x11, device, index, fnSw, ...readings[device]], 20));
  };
}
const RECEIVER_CHANNELS = [{ path: 'r', usagePage: 0xff00, usage: 0x02 }];
const childOnSlot = (slot, wpid) => ({ product: 'G502 X LS', vendorId: 0x046d, channels: RECEIVER_CHANNELS, receiver: { slot, wpid, kind: 2 } });

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

test('Logitech: each child of a receiver reads its own slot', async () => {
  const calls = [];
  await withExchange(twoDeviceReceiver(calls), async (hidpp2) => {
    const mouse = childOnSlot(2, 0x409f);
    const keyboard = { ...childOnSlot(1, 0x408e), product: 'G913 TKL' };
    assert.equal((await hidpp2.readBattery(mouse)).capacity, 81);
    assert.ok(!calls.some((c) => c.device === 1));
    assert.equal((await hidpp2.readBattery(keyboard)).voltageMv, 4141);
    assert.equal((await hidpp2.readBattery(mouse)).capacity, 81);
    assert.equal((await hidpp2.readBattery(keyboard)).voltageMv, 4141);
  });
});

test('Logitech: a child whose slot moved looks for its battery again', async () => {
  const calls = [];
  await withExchange(twoDeviceReceiver(calls), async (hidpp2) => {
    await hidpp2.readBattery(childOnSlot(2, 0x408e));
    calls.length = 0;
    await hidpp2.readBattery(childOnSlot(1, 0x408e));
    assert.ok(calls.some((c) => c.device === 1 && c.index === 0));
  });
});

test('Logitech: the receiver itself still reads its first device', async () => {
  await withExchange(twoDeviceReceiver([]), async (hidpp2) => {
    const receiver = { product: 'USB Receiver', vendorId: 0x046d, channels: RECEIVER_CHANNELS };
    assert.equal((await hidpp2.readBattery(receiver)).voltageMv, 4141);
  });
});

test('Logitech: a child that is asleep reads as not answering', async () => {
  await withExchange(twoDeviceReceiver([], { asleep: [2] }), async (hidpp2) => {
    await assert.rejects(hidpp2.readBattery(childOnSlot(2, 0x409f)), /^Error: device is not answering$/);
  });
});

test('DualShock 4 adapter with no controller on it reads as off, not as a low battery', () => {
  const usb = new Array(64).fill(0);
  usb[0] = 0x01;
  usb[31] = 0x04;
  assert.deepEqual(playstation.parseDualShock4(usb, false, true), { off: true });
  usb[31] = 0x00;
  usb[30] = 0x05;
  assert.deepEqual(playstation.parseDualShock4(usb, false, true), { capacity: 55, charging: false });
  usb[31] = 0x04; // a controller on its own cable never reports this; only the adapter is checked
  assert.deepEqual(playstation.parseDualShock4(usb), { capacity: 55, charging: false });
});

test('Audeze talks on the collection HeadsetControl uses first', () => {
  const order = audeze.candidates({ channels: [
    { path: 'consumer', usagePage: 0x0c, usage: 1 },
    { path: 'other', usagePage: 0xff00, usage: 1 },
    { path: 'command', usagePage: 0xff13, usage: 1 },
  ] }).map((c) => c.path);
  assert.deepEqual(order, ['command', 'other', 'consumer']);
});

const compx = require('../src/main/hid/drivers/compx');
const hexBytes = (text) => pad(text.split(' ').map((b) => parseInt(b, 16)), 20);
const withSum = (f) => { f[19] = f.slice(0, 19).reduce((a, b) => a + b, 0) & 0xff; return f; };

test('Compx keyboard receiver: requests carry the checksums the sources document', () => {
  assert.equal(compx.frame(0x4a, 0x00)[19], 0x5d); // AULA F87 Pro: 13 4A 00 ... 5D
  assert.equal(compx.frame(0x4a, 0x01)[19], 0x5e); // MCHOSE G75: 13 4A 01 ... 5E
  assert.equal(compx.frame(0x05, 0x01).length, 20);
});

test('Compx keyboard receiver: reads both battery answers captured on real keyboards', () => {
  // AULA F87 Pro, unplugged, 95%
  assert.deepEqual(compx.parseFrame(withSum(hexBytes('13 4A 01 00 02 5F 01'))), { capacity: 95, charging: false });
  // MCHOSE G75 Pro, 36%
  assert.deepEqual(compx.parseFrame(withSum(hexBytes('13 4A 01 00 02 24 01'))), { capacity: 36, charging: false });
  // Lingbao K98 push after the session, 100%
  assert.deepEqual(compx.parseFrame(withSum(hexBytes('13 0A 01 00 04 05 64 01'))), { capacity: 100, charging: false });
  // on external power
  assert.equal(compx.parseFrame(withSum(hexBytes('13 4A 01 00 02 64 10'))).charging, true);
  // the receiver's session answer (AULA F99 Pro)
  assert.deepEqual(compx.parseFrame(withSum(hexBytes('13 05 01 00 0A 03 00 00 00 01 58 01'))), { ack: true });
});

test('Compx keyboard receiver: wrong checksums, echoes and empty levels are not readings', () => {
  const real = withSum(hexBytes('13 4A 01 00 02 5F 01'));
  assert.equal(real[19], 0xc0, 'matches the captured frame');
  const corrupt = [...real];
  corrupt[19] = 0xc1;
  assert.equal(compx.parseFrame(corrupt), null);
  assert.equal(compx.parseFrame(compx.frame(0x4a, 0x00)), null, 'our own request echoed back');
  assert.equal(compx.parseFrame(withSum(hexBytes('13 4A 01 00 02 00 01'))), null);
});

test('the Compx keyboard receiver gets its own driver, not the Kysona mouse one', () => {
  const receiver = { vendorId: 0x3554, productId: 0xfa09, channels: [{ usagePage: 0x01, usage: 6 }, { usagePage: 0xff02, usage: 2 }, { usagePage: 0xff04, usage: 2 }] };
  assert.equal(detectDriver(receiver).id, 'compx');
  const vxe = { vendorId: 0x3554, productId: 0xf58a, channels: [{ usagePage: 0xff02, usage: 2 }] };
  assert.equal(detectDriver(vxe).id, 'kysona');
});

test('Corsair Bragi headsets read the battery in tenths, and know a missing headset', () => {
  const steps = entry(0x1b1c, 0x2a08).steps;
  assert.equal(entry(0x1b1c, 0x0a97), entry(0x1b1c, 0x2a08));
  const battery = steps[steps.length - 1];
  assert.deepEqual(battery.request.slice(0, 6), [0x00, 0x02, 0x09, 0x02, 0x0f, 0x00]);
  assert.equal(battery.request.length, 65);
  assert.deepEqual(battery.parse(frame([0x01, 0x01, 0x02, 0x00, 0x52, 0x03])), { capacity: 85 }); // 850 tenths
  assert.equal(battery.parse(frame([0x01, 0x01, 0x02, 0x00, 0x1c, 0x1b])), null); // someone else's answer
  assert.equal(battery.parse(frame([0x01, 0x00, 0x02, 0x05, 0x00, 0x00])).offline, true);
  assert.equal(battery.parse(frame([0x01, 0x01, 0x06, 0x00, 0x00, 0x00])), null); // a status push
  // The wake-up asks the receiver first, so a receiver reply is accepted there and not for the headset.
  assert.deepEqual(steps[0].parse(frame([0x01, 0x00, 0x02, 0x00, 0x13, 0x01])), {});
  assert.equal(steps[2].parse(frame([0x01, 0x00, 0x02, 0x00, 0x13, 0x01])), null);
  const se = entry(0x1b1c, 0x0a40).steps[0];
  assert.deepEqual(se.request.slice(0, 5), [0x02, 0x09, 0x02, 0x0f, 0x00]);
  assert.equal(se.request.length, 64);
  assert.deepEqual(se.parse(frame([0x01, 0x01, 0x02, 0x00, 0x5a, 0x00])), { capacity: 9 });
});

test('MCHOSE V9 PRO reads like the X9, and the Astro A50 Gen 4 checks the headset is linked first', () => {
  const v9 = entry(0x291d, 0x385d).steps[0];
  assert.deepEqual(v9.request.slice(0, 3), [0x55, 0x65, 0x01]);
  assert.deepEqual(v9.parse(frame([0x55, 0x65, 0x32, 0x02])), { capacity: 50 });
  assert.equal(v9.parse(frame([0x55, 0x65, 0x32, 0x05])), null);
  const [link, level] = entry(0x9886, 0x002c).steps;
  assert.deepEqual(link.parse(frame([0x02, 0x02, 0x01, 0x02])), {});
  assert.equal(link.parse(frame([0x02, 0x02, 0x01, 0x00])).offline, true);
  assert.deepEqual(level.parse(frame([0x02, 0x02, 0x01, 0x80 | 64])), { capacity: 64, charging: true });
  assert.equal(level.parse(frame([0x02, 0x01, 0x01, 0x00])), null);
});

test('mice on the Compx receiver chip use the VXE protocol, other chips with the same name do not', () => {
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  const compxLayout = [ch(1, 2), ch(1, 6), ch(0xff02, 2), ch(0xff04, 2), ch(0xff03, 0)];
  const device = (vendorId, productId, channels) => ({ vendorId, productId, channels });
  assert.equal(detectDriver(device(0x373b, 0x1085, compxLayout)).id, 'kysona'); // Linux hid-pulsar's ATK dongle
  assert.equal(detectDriver(device(0x260d, 0x1074, compxLayout)).id, 'kysona');
  assert.equal(detectDriver(device(0x25a7, 0xfa07, compxLayout)).id, 'kysona');
  const nearlink = [ch(1, 2), ch(1, 6), ch(0xffb1, 1), ch(0xffb2, 1)];
  assert.notEqual((detectDriver(device(0x373b, 0x108b, nearlink)) || {}).id, 'kysona');
  const noCommand = [ch(1, 2), ch(0xff01, 0), ch(0xff02, 2)];
  assert.notEqual((detectDriver(device(0x25a7, 0xfa70, noCommand)) || {}).id, 'kysona');
  assert.equal(detectDriver(device(0x3554, 0xf58a, [ch(0xff02, 2)])).id, 'kysona');
  assert.equal(detectDriver(device(0x3554, 0xfa09, compxLayout)).id, 'compx');
});

test('MCHOSE 2.4G keyboards read the base info block, on the collection with no usage', () => {
  const kb = entry(0x3837, 0x3033);
  const step = kb.steps[0];
  assert.deepEqual(step.request.slice(0, 9), [0x00, 0x55, 0x04, 0x00, 0x38, 0x38, 0x00, 0x00, 0x00]);
  assert.equal(step.request.length, 65);
  const reply = (b) => { const f = new Array(64).fill(0); f[0] = 0xaa; f[1] = 0x04; f[4] = 56; f[40] = b; return f; };
  assert.deepEqual(step.parse(reply(73)), { capacity: 73, charging: false });
  assert.deepEqual(step.parse(reply(0x80 | 40)), { capacity: 40, charging: true });
  assert.equal(step.parse([0xaa, 0x05, 0, 0, 56, 0, 0, ...new Array(57).fill(0)]), null);
  const channels = [{ usagePage: 1, usage: 6, path: 'kbd' }, { usagePage: 1, path: 'cmd' }, { usagePage: 0xff31, usage: 0x74, path: 'v' }];
  assert.deepEqual(channelsFor({ channels }, kb).map((c) => c.path), ['cmd']);
});

test('MCHOSE mice: the read-device request is inverted, and the level comes back inverted', () => {
  const mouse = require('../src/main/hid/drivers/mchose-mouse');
  const req = mouse.request();
  assert.equal(req[0], 0x11);
  assert.equal(req[1], 0x06 ^ 0xff);
  assert.ok(req.slice(2).every((b) => b === 0xff));
  assert.equal(req.length, 21);
  // vid 3837, pid 100b, firmware, link byte, level 62, charging
  const data = [0x37, 0x38, 0x0b, 0x10, 1, 2, 3, 4, 0x30, 62, 1, ...new Array(9).fill(0)];
  const raw = [0x11, 0x06 ^ 0xff, ...data.map((b) => b ^ 0xff)];
  assert.deepEqual(mouse.parseReply(raw), { capacity: 62, charging: true });
  raw[2 + 9] = 0 ^ 0xff;
  assert.equal(mouse.parseReply(raw).offline, true);
  assert.equal(mouse.parseReply([0x11, 0x04 ^ 0xff, ...data]), null); // another command's answer
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  const device = (vendorId, productId) => ({ vendorId, productId, channels: [ch(1, 2), ch(0xff0b, 0x104), ch(0xff01, 1)] });
  assert.equal(detectDriver(device(0x3837, 0x100b)).id, 'mchose-mouse');
  assert.equal(detectDriver(device(0x5253, 0x1021)).id, 'mchose-mouse');
  assert.notEqual((detectDriver(device(0x3837, 0x3033)) || {}).id, 'mchose-mouse');
});

test('Glorious and LAMZU mice answer in feature report 0, and know when the mouse sleeps', () => {
  const g = require('../src/main/hid/drivers/sinowealth');
  const req = g.request();
  assert.equal(req.length, 65);
  assert.deepEqual([req[0], req[3], req[4], req[6]], [0, 2, 2, 0x83]);
  const reply = (status, pct) => { const r = new Array(65).fill(0); r[1] = status; r[6] = 0x83; r[8] = pct; return r; };
  assert.deepEqual(g.parseReply(reply(0xa1, 57), false), { capacity: 57, charging: false });
  assert.deepEqual(g.parseReply(reply(0xa1, 80), true), { capacity: 80, charging: true });
  const charging = reply(0xa1, 66); charging[7] = 1;
  assert.deepEqual(g.parseReply(charging, false), { capacity: 66, charging: true });
  assert.equal(g.parseReply(reply(0xa4, 0), false).offline, true);
  assert.equal(g.parseReply(reply(0xa0, 0), false), null);
  const device = { vendorId: 0x258a, productId: 0x2023, channels: [{ usagePage: 0xffa0, usage: 1, interface: 1, path: 'a' }, { usagePage: 0xffff, usage: 1, interface: 2, path: 'b' }] };
  assert.equal(detectDriver(device).id, 'sinowealth');
  const layout = [{ usagePage: 1, usage: 2, path: 'm' }, { usagePage: 0xffa0, usage: 1, path: 'a' }, { usagePage: 0xffff, usage: 1, path: 'b' }, { usagePage: 0xffff, path: 'c' }];
  assert.equal(detectDriver({ vendorId: 0x373e, productId: 0x001e, channels: layout }).id, 'sinowealth'); // LAMZU Maya X 8K
  assert.equal(detectDriver({ vendorId: 0x2023, productId: 0xf013, channels: layout }).id, 'sinowealth'); // MCHOSE A5 2.4G
  assert.notEqual((detectDriver({ vendorId: 0x373e, productId: 0x001e, channels: layout.slice(0, 1) }) || {}).id, 'sinowealth');
});

test('the Beken/Xenta receiver broadcast is read, and the link-blink frame is not a reading', () => {
  const beken = require('../src/main/hid/drivers/beken');
  assert.deepEqual(beken.parseFrame([0x03, 0xe5, 0x40, 0x01, 77]), { capacity: 77, charging: false });
  assert.deepEqual(beken.parseFrame([0x03, 0xe5, 0x40, 0x03, 40]), { capacity: 40, charging: true });
  assert.equal(beken.parseFrame([0x03, 0xe5, 0x01, 0x00, 0x00]), null);
  assert.equal(beken.parseFrame([0x03, 0xe5, 0x40, 0x01, 0xc8]), null);
  // An Attack Shark X11 receiver (issue #175) sends 55 where others send e5, same layout.
  assert.deepEqual(beken.parseFrame([0x03, 0x55, 0x40, 0x01, 100]), { capacity: 100, charging: false });
  assert.equal(beken.parseFrame([0x03, 0x55, 0x01, 0x00, 0x00]), null);
  assert.equal(beken.parseFrame([0x03, 0x44, 0x40, 0x01, 50]), null);
  const channels = [{ usagePage: 1, usage: 2, path: 'm' }, { usagePage: 0x0a, path: 'v' }, { usagePage: 0x0b, path: 'w' }];
  assert.equal(detectDriver({ vendorId: 0x1d57, productId: 0xfa60, channels }).id, 'beken');
});

test('Logitech G535 tries the HID++ collection first, then the media-key one HeadsetControl uses', () => {
  const g535 = entry(0x046d, 0x0ac4);
  const channels = [{ usagePage: 0x0c, usage: 1, interface: 3, path: 'media' }, { usagePage: 0xff43, usage: 0x0202, interface: 3, path: 'hidpp' }];
  assert.deepEqual(channelsFor({ channels }, g535).map((c) => c.path), ['hidpp', 'media']);
});

test('ATK BitMouse receivers: the battery request is checksummed, and only an echo of it counts', () => {
  const bm = require('../src/main/hid/drivers/bitmouse');
  const req = bm.request(7);
  assert.equal(req.length, 64);
  assert.deepEqual(req.slice(0, 8), [0x08, 0x7d, 0x72, 0x02, 0x00, 0x01, 0x07, 0x01]);
  assert.equal(bm.request(15)[1], 0x85);
  const reply = (cmd, value) => { const f = new Array(64).fill(0); f[0] = 0x09; f[5] = cmd; f[7] = value; return f; };
  assert.equal(bm.parseReply(reply(7, 64), 7), 64);
  assert.equal(bm.parseReply(reply(15, 1), 7), null);
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  const nearlink = { vendorId: 0x373b, productId: 0x11dc, channels: [ch(0x0c, 1), ch(0xffb1, 1), ch(0xffb3, 1), ch(0xff05, 1), ch(1, 2), ch(1, 6)] };
  assert.equal(detectDriver(nearlink).id, 'bitmouse');
  const compx = { vendorId: 0x373b, productId: 0x101b, channels: [ch(0xff05, undefined), ch(0xff02, 2), ch(0xff04, 2), ch(1, 2)] };
  assert.equal(detectDriver(compx).id, 'kysona');
});

test('ATK X1 NearLink asks for power info on report 5 and matches the request code', () => {
  const x1 = entry(0x373b, 0x108b).steps[0];
  assert.deepEqual(x1.request.slice(0, 4), [0x05, 0x01, 0x00, 0x1a]);
  assert.deepEqual(x1.parse(frame([0x05, 0x01, 0x00, 0x1a, 0, 0, 0, 0, 71, 1])), { capacity: 71, charging: true });
  assert.equal(x1.parse(frame([0x05, 0x02, 0x00, 0x1a, 0, 0, 0, 0, 71, 1])), null);
  assert.equal(x1.parse(frame([0x05, 0x01, 0x00, 0x1a, 0, 0, 0, 0, 0, 0])).offline, true);
});

test('HyperX Cloud III, Cloud II Core and Cloud III S read the way auto94 documents', () => {
  const iii = entry(0x03f0, 0x05b7).steps[0];
  assert.deepEqual(iii.request.slice(0, 3), [0x66, 0x89, 0x00]);
  assert.equal(iii.request.length, 52);
  assert.deepEqual(iii.parse(frame([0x66, 0x89, 0, 0, 72])), { capacity: 72 });
  assert.equal(iii.parse(frame([0x66, 0x0d, 0x0f, 0x53, 0x49])), null);
  assert.equal(entry(0x03f0, 0x0995).steps[0].parse(frame([0x66, 0x89, 0, 0, 0xff])).offline, true);
  const s = entry(0x03f0, 0x06be).steps[0];
  assert.deepEqual(s.parse(frame([0x0c, 0x02, 0x03, 0x01, 0x00, 0x06, 40])), { capacity: 40 });
  assert.equal(s.parse(frame([0x0c, 0x02, 0x03, 0x01, 0x00, 0x06, 0xff])).offline, true);
  assert.ok(entry(0x03f0, 0x0d93)); // Cloud Stinger 2 Wireless
  { // #206: its collection is not on interface 0, and its reports are 20 bytes
    const stinger = entry(0x03f0, 0x0d93);
    assert.equal(stinger.name, 'HyperX Cloud Stinger 2 Wireless');
    assert.equal(stinger.channel.interface, undefined);
    assert.equal(stinger.steps[0].request.length, 20);
    const reply = [0x06, 0xff, 0xbb, 0x02, 0, 0, 0, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.deepEqual(stinger.steps[0].parse(reply), { capacity: 87 });
    assert.equal(entry(0x03f0, 0x018b).channel.interface, 0);
  }
});

test('YJX-chip receivers answer the gmouse battery request on 0xFF01/0x0010', () => {
  const yjx = require('../src/main/hid/drivers/yjx');
  assert.deepEqual(yjx.REQUEST.slice(0, 9), [0x00, 0x55, 0x30, 0xa5, 0x0b, 0x2e, 0x01, 0x01, 0x01]);
  assert.equal(yjx.REQUEST.length, 65);
  assert.deepEqual(yjx.parseReply([0xaa, 0x30, 0, 0, 0, 0, 0, 0, 70, 1]), { capacity: 70, charging: true });
  assert.equal(yjx.parseReply([0xaa, 0xfa, 0, 0, 0, 0, 0, 0, 70, 1]), null);
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  assert.equal(detectDriver({ vendorId: 0xa8a5, productId: 0x2255, channels: [ch(1, 2), ch(0xffa5, 0x88), ch(0xff01, 0x10)] }).id, 'yjx');
  assert.equal(detectDriver({ vendorId: 0x249a, productId: 0x5c2f, channels: [ch(1, 2), ch(0xff01, 0x10)] }).id, 'yjx');
});

test('G3 A revisions use Gmouse by branded model name on the vendor channel', () => {
  const yjx = require('../src/main/hid/drivers/yjx');
  const device = (fields = {}) => ({
    vendorId: 0x3837, productId: 0x9999, product: 'MCHOSE G3 A',
    channels: [{ usagePage: 1, usage: 2 }, { usagePage: 0xff01, usage: 0x10 }],
    ...fields,
  });
  for (const fields of [
    { product: 'G3A' },
    { product: 'g3 a Mouse' },
    { vendorId: 0x9999, manufacturer: 'MCHOSE', product: 'G3A Mouse' },
    { vendorId: 0x9999, product: 'mchose g3a' },
    { vendorId: 0x9999, manufacturer: '迈从', product: 'G3 A' },
  ]) {
    assert.equal(detectDriver(device(fields)).id, 'yjx', JSON.stringify(fields));
  }
  for (const fields of [
    { vendorId: 0x9999, product: 'OtherBrand G3A', manufacturer: 'OtherBrand' },
    { product: 'MCHOSE G3 Ultra' },
    { product: 'MCHOSE G3AB' },
    { product: '' },
    { channels: [{ usagePage: 1, usage: 2 }] },
    { channels: [{ usagePage: 0xff01, usage: 1 }] },
  ]) {
    assert.equal(yjx.matches(device(fields)), false, JSON.stringify(fields));
  }
  const realtek = device({ productId: 0x4150, product: 'MCHOSE A5 Ultra' });
  assert.equal(detectDriver(realtek).id, 'mchose-mouse');
});

test('G3 A checks online status before accepting a receiver battery cached while off', async () => {
  const exchange = require('../src/main/hid/drivers/exchange');
  const original = exchange.exchange;
  const driverPath = require.resolve('../src/main/hid/drivers/yjx');
  const cached = require.cache[driverPath];
  let online = false;
  const commands = [];
  exchange.exchange = async (channel, request, accept) => {
    commands.push(request[2]);
    if (request[2] === 0xed && online === null) throw new Error('timeout waiting for battery response');
    if (request[2] === 0xed) return accept([0xaa, 0xed, 0, 0, 0, 0, 0, 0, online ? 2 : 1]);
    return accept([0xaa, 0x30, 0, 0, 0, 0, 0, 0, 68, 0]);
  };
  delete require.cache[driverPath];
  try {
    const yjx = require(driverPath);
    const device = { vendorId: 0x3837, productId: 0x9999, product: 'G3 A', channels: [{ path: 'g3a', usagePage: 0xff01, usage: 0x10 }] };
    await assert.rejects(yjx.readBattery(device), /^Error: mouse is off$/);
    assert.deepEqual(commands, [0xed]);
    online = true;
    commands.length = 0;
    assert.deepEqual(await yjx.readBattery(device), { capacity: 68, charging: false });
    assert.deepEqual(commands, [0xed, 0x30]);
    online = null;
    commands.length = 0;
    const legacy = { ...device, vendorId: 0xa8a5, productId: 0x2255 };
    assert.deepEqual(await yjx.readBattery(legacy), { capacity: 68, charging: false });
    assert.deepEqual(commands, [0xed, 0x30]);
    commands.length = 0;
    await yjx.readBattery({ ...legacy, product: 'Wireless Receiver' });
    assert.deepEqual(commands, [0x30]);
    assert.equal(yjx.parseStatus([0xaa, 0xed]), null);
    assert.equal(yjx.parseStatus([0xaa, 0x30, 0, 0, 0, 0, 0, 0, 2]), null);
    assert.equal(yjx.parseStatus([0xaa, 0xed, 0, 0, 0, 0, 0, 0, 255]), null);
  } finally {
    exchange.exchange = original;
    require.cache[driverPath] = cached;
  }
});

test('Ultra-Link 8K (Keychron and SKN) asks b3 06 and reads level | charging at byte 20', () => {
  for (const vendorId of [0x3434, 0x362d]) {
    const step = entry(vendorId, 0xd028).steps[0];
    assert.deepEqual(step.request.slice(0, 3), [0xb3, 0x06, 0x00]);
    assert.equal(step.request.length, 64);
    // From HaloBattery issue #373: an M6 8K at 99%, then on its charger.
    const reply = [0xb4, 0x06, 0x00, 0x44, 0x44, 0x04, 0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x80, 0x0c, 0x88, 0x13, 0x15, 0x05, 0x04, 0x0a, 0x63, 0x00];
    assert.deepEqual(step.parse(frame(reply)), { capacity: 99, charging: false });
    reply[20] = 0xe3;
    assert.deepEqual(step.parse(frame(reply)), { capacity: 99, charging: true });
    assert.equal(step.parse(frame([0xb3, 0x06, ...new Array(30).fill(0)])), null); // an echo
  }
});

test('Beken receivers also send 03 55 40 and fa55 is listened to', () => {
  const beken = require('../src/main/hid/drivers/beken');
  assert.deepEqual(beken.parseFrame([0x03, 0x55, 0x40, 0x01, 0x64]), { capacity: 100, charging: false });
  assert.equal(beken.parseFrame([0x03, 0x56, 0x40, 0x01, 0x64]), null);
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  assert.equal(detectDriver({ vendorId: 0x1d57, productId: 0xfa55, channels: [ch(1, 2), ch(0x0a, 1)] }).id, 'beken');
});

test('ATK Holtek receivers answer get-config 82 with level | charging at byte 8', () => {
  const atk = require('../src/main/hid/drivers/atk-holtek');
  assert.deepEqual(atk.REQUEST, [0x00, 0x82, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(atk.parseReply([0x82, 3, 1, 0, 0, 0, 0, 0, 83, 1]), { capacity: 83, charging: false });
  assert.deepEqual(atk.parseReply([0x82, 3, 1, 0, 0, 0, 0, 0, 0x80 | 50, 1]), { capacity: 50, charging: true });
  assert.equal(atk.parseReply([0x82, 3, 1, 0, 0, 0, 0, 0, 0, 0]).offline, true);
  assert.equal(atk.parseReply([0x07, 0xa1, 1, 0, 3, 2, 0, 0x1f, 0, 0x65]), null);
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  const nano = { vendorId: 0x373b, productId: 0x1178, channels: [ch(0xff10, 1), ch(1, 2), ch(1, 6), ch(0xff00, 1), ch(0x0c, 1), ch(0xff11, 1)] };
  assert.equal(detectDriver(nano).id, 'atkHoltek');
});

test('HyperX Cloud Flight S asks BB 02 and reads byte 7 of the echo', () => {
  const step = entry(0x0951, 0x16ea).steps[0];
  assert.deepEqual(step.request.slice(0, 17), [0x06, 0x00, 0x02, 0x00, 0x9a, 0x00, 0x00, 0x68, 0x4a, 0x8e, 0x0a, 0x00, 0x00, 0x00, 0xbb, 0x02, 0x00]);
  assert.equal(step.request.length, 62);
  assert.deepEqual(step.parse(frame([0x0b, 0, 0xbb, 0x02, 0, 0, 0, 73])), { capacity: 73 });
  assert.equal(step.parse(frame([0x0b, 0, 0xbb, 0x03, 1, 0, 0, 0])), null);
  assert.equal(step.parse(frame([0x0a, 0, 0xbb, 0x02, 0, 0, 0, 73])), null);
  assert.equal(step.parse(frame([0x0b, 0, 0xbb, 0x02, 0, 0, 0, 0])).offline, true);
});

test('Razer BlackShark V3 asks class 0x21 with the XOR byte and reads byte 13', () => {
  const step = entry(0x1532, 0x0577).steps[0];
  assert.deepEqual(step.request.slice(0, 11), [0x02, 0x00, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x80, 0x21]);
  assert.equal(step.request[62], 0xc7); // as Joule logs it
  assert.equal(step.request.length, 64);
  const reply = [0x02, 0x02, 0x60, 0, 0, 0, 0x05, 0, 0, 0x80, 0x21, 0x01, 0x01, 35];
  assert.deepEqual(step.parse(frame(reply)), { capacity: 35 });
  assert.equal(step.parse(frame([0x02, 0x02, 0x60, 0, 0, 0, 0x05, 0, 0, 0x80, 0x21, 0x01, 0x01, 0xff])).offline, true);
  // From the issue #21 scan: class 0x60, not the battery.
  assert.equal(step.parse(frame([0x02, 0x02, 0x60, 0, 0, 0, 0x0a, 0, 0, 0x80, 0x60, 0x01, 0x06, 0x08])), null);
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  assert.equal(detectDriver({ vendorId: 0x1532, productId: 0x0577, channels: [ch(0x0c, 1), ch(0xff13, 1), ch(0x0b, 5), ch(0xff14, 1)] }).id, 'tabled');
});

test('MCHOSE V9 Pro 2 speaks the MC protocol, and the X9 reads charging, full and asleep', () => {
  const v9p2 = entry(0x3837, 0x6011);
  assert.deepEqual(v9p2.channel, { usagePage: 0xff07, usage: 0x0222 });
  const step = v9p2.steps[0];
  assert.deepEqual(step.request.slice(0, 9), [0x55, 0xaa, 0x01, 0x00, 0x01, 0x00, 0x01, 0x0b, 0x00]);
  assert.equal(step.request.length, 64);
  assert.deepEqual(step.parse(frame([0x55, 0xaa, 0x01, 0x00, 0x03, 0x00, 0x01, 0x0b, 0x01, 80])), { capacity: 80, charging: false });
  assert.deepEqual(step.parse(frame([0x55, 0xaa, 0x01, 0x00, 0x03, 0x00, 0x04, 0x22, 0x01, 0x80 | 45])), { capacity: 45, charging: true });
  assert.equal(step.parse(frame([0x55, 0xaa, 0x01, 0x00, 0x03, 0x00, 0x01, 0x0b, 0x00, 0])).offline, true);
  assert.equal(step.parse(frame([0x55, 0xaa, 0x01, 0x00, 0x03, 0x00, 0x01, 0x0c, 0x01, 50])), null);
  const x9 = entry(0x3837, 0x6045).steps[0];
  assert.deepEqual(x9.parse(frame([0x55, 0x65, 0x32, 0x03])), { capacity: 50, charging: true });
  assert.deepEqual(x9.parse(frame([0x55, 0x65, 0x64, 0x04])), { capacity: 100, charging: false });
  assert.equal(x9.parse(frame([0x55, 0x65, 0x32, 26])).offline, true);
  assert.equal(x9.parse(frame([0x55, 0x65, 0x32, 0x05])), null);
});

test('the MCHOSE A7 V2 Pro receiver (3837:100a) is read like the A7 V2 Ultra', () => {
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  const device = { vendorId: 0x3837, productId: 0x100a, channels: [ch(1, 2), ch(1, 6), ch(0xff0b, 0x104), ch(0xff01, 1), ch(0x0c, 1)] };
  assert.equal(detectDriver(device).id, 'mchose-mouse');
});

test('Akko 8K receivers and others with the 0xFF1C/0x0092 collection ask with report 4, command 0x1A', () => {
  const akko = require('../src/main/hid/drivers/akko');
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  assert.equal(detectDriver({ vendorId: 0x38ee, productId: 0x0024, channels: [ch(1, 2), ch(0xff1c, 0x92), ch(0xff01, 1)] }).id, 'akko');
  assert.deepEqual(akko.REQUEST.slice(0, 6), [0x04, 0x00, 0x00, 0x1a, 0x06, 0x00]);
  assert.equal(akko.REQUEST.length, 8);
  assert.deepEqual(akko.parseReply([0x04, 0x1c, 0x00, 0x1a, 0x02, 0, 0, 0, 0x5d, 0]), { capacity: 93, charging: false });
  assert.deepEqual(akko.parseReply([0x04, 0x1c, 0x00, 0x1a, 0x02, 0, 0, 0, 60, 1]), { capacity: 60, charging: true });
  assert.equal(akko.parseReply([0x04, 0x1c, 0x00, 0x1a, 0x02, 0, 0, 0, 0, 0]).offline, true);
  assert.equal(akko.parseReply([0x04, 0x1c, 0x00, 0x1b, 0x02, 0, 0, 0, 50, 0]), null);
});

test('VGN Dragonfly 3 uses the VXE protocol, VGN YJX mice use YJX, and LAMZU 0x37B0 mice use the Glorious one', () => {
  const ch = (usagePage, usage) => ({ usagePage, usage, path: `${usagePage}:${usage}` });
  const compxLayout = [ch(1, 2), ch(0xff02, 2), ch(0xff04, 2)];
  assert.equal(detectDriver({ vendorId: 0x391d, productId: 0x101d, channels: compxLayout }).id, 'kysona');
  assert.equal(detectDriver({ vendorId: 0x391d, productId: 0x1a1a, channels: compxLayout }).id, 'kysona');
  assert.notEqual((detectDriver({ vendorId: 0x391d, productId: 0x9999, channels: compxLayout }) || {}).id, 'kysona');
  assert.equal(detectDriver({ vendorId: 0x391d, productId: 0x1a01, channels: [ch(0xff01, 0x10)] }).id, 'yjx');
  assert.equal(detectDriver({ vendorId: 0x37b0, productId: 0x0001, channels: [ch(0xffa0, 1), ch(0xffff, 1)] }).id, 'sinowealth');
});

test('ROG Claymore II asks 12 01 and the 1EA7 receiver answers at register 0x94 or in its heartbeat', () => {
  const rog = entry(0x0b05, 0x196b).steps[0];
  assert.deepEqual(rog.request.slice(0, 3), [0x00, 0x12, 0x01]);
  assert.deepEqual(rog.parse(frame([0x12, 0x01, 0, 0, 0, 0x4d, 0, 0, 1])), { capacity: 77, charging: true });
  assert.equal(rog.parse(frame([0x12, 0x01, 0, 0, 0, 0xff, 0xaa, 0, 0])).offline, true);
  assert.equal(rog.parse(frame([0x12, 0x02, 0, 0, 0, 50, 0, 0, 0])), null);
  const mouse = entry(0x1ea7, 0x0064).steps[0];
  assert.deepEqual(mouse.request, [0xb5, 0x05, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(mouse.parse([0xb5, 0x05, 0x94, 0x04, 0, 0, 63, 0]), { capacity: 63 });
  assert.equal(mouse.parse([0xb5, 0x05, 0x93, 0x04, 0, 0, 63, 0]), null);
  assert.deepEqual(mouse.parse([0xb5, 0x67, 1, 2, 3, 4, 1, 88]), { capacity: 88 });
});

test('ASUS ROG mice, MSI VERSA 300, Waizowl OGM 8K and the Void v2 on its cable', () => {
  const gladius = entry(0x0b05, 0x1a72).steps[0];
  assert.deepEqual(gladius.request.slice(0, 3), [0x00, 0x12, 0x07]);
  assert.deepEqual(gladius.parse(frame([0x12, 0x07, 0, 0, 66, 0, 0, 0, 0, 1])), { capacity: 66, charging: true });
  assert.equal(gladius.parse(frame([0xff, 0xaa, 0, 0, 0, 0, 0, 0, 0, 0])).offline, true);
  assert.equal(gladius.parse(frame([0x12, 0x07, 0, 0, 0, 0, 0, 0, 0, 0])).offline, true);
  assert.equal(entry(0x0b05, 0x1ace).steps[0].parse(frame([0x03, 0xff, 0xaa, 0, 0, 0, 0, 0, 0, 0, 0])).offline, true);
  assert.equal(entry(0x0b05, 0x196b).steps[0].parse(frame([0xff, 0xaa, 0, 0, 0, 0, 0, 0, 0])).offline, true);
  const asleep = new Array(16).fill(0); asleep[0] = 0x0f; asleep[1] = 0x20;
  assert.equal(entry(0x0db0, 0x9e22).steps[0].parse(asleep).offline, true);
  const omni = entry(0x0b05, 0x1ace).steps[0];
  assert.deepEqual(omni.request.slice(0, 3), [0x03, 0x12, 0x07]);
  assert.deepEqual(omni.parse(frame([0x03, 0x12, 0x07, 0, 0, 40, 0, 0, 0, 0, 0])), { capacity: 40, charging: false });
  const versa = entry(0x0db0, 0x9e22).steps[0];
  const v = new Array(16).fill(0); v[0] = 0x0f; v[1] = 0x20; v[14] = 0x80 | 58;
  assert.deepEqual(versa.parse(v), { capacity: 58, charging: true });
  const ogm = entry(0x1915, 0x0728).steps[0];
  assert.equal(ogm.request.length, 65);
  assert.equal(ogm.request.slice(1).reduce((a, b) => a + b, 0) & 0xff, 0xa1);
  const reply = new Array(64).fill(0); reply[0] = 0x01; reply[2] = 0x8c; reply[3] = 0x01; reply[6] = 72;
  reply[63] = (0xa1 - reply.slice(0, 63).reduce((a, b) => a + b, 0)) & 0xff;
  assert.deepEqual(ogm.parse(reply), { capacity: 72 });
  reply[63] = (reply[63] + 1) & 0xff;
  assert.equal(ogm.parse(reply), null);
  assert.equal(entry(0x1b1c, 0x2a09).steps.length, 1);
});
