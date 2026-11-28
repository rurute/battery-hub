const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// A scripted stand-in for node-hid's HIDAsync. reads holds what each dev.read() returns: an
// array is a frame, an Error rejects, and when it runs out the read times out with no data.
class FakeDevice {
  constructor() {
    this.reads = [];
    this.writes = 0;
    this.sent = []; // the command byte of each write
    this.closes = 0;
    this.writeError = null;
    this.feature = null;
    this.inFlight = 0;
    this.maxInFlight = 0;
  }

  async track(fn) {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setImmediate(r));
    this.inFlight -= 1;
    return fn();
  }

  read() {
    return this.track(() => {
      const next = this.reads.shift();
      if (next instanceof Error) throw next;
      return Buffer.from(next || []);
    });
  }

  write(bytes) {
    return this.track(() => {
      this.writes += 1;
      this.sent.push(bytes && bytes[1]);
      if (this.writeError) throw this.writeError;
      return 17;
    });
  }

  getFeatureReport() {
    return this.track(() => {
      if (this.featureError) throw this.featureError;
      if (this.features) return Buffer.from(this.features.shift() || this.lastFeatureSent || []);
      return Buffer.from(this.feature);
    });
  }

  sendFeatureReport(bytes) {
    return this.track(() => {
      this.featuresSent = (this.featuresSent || []).concat([bytes[1]]);
      this.lastFeatureSent = bytes;
      return bytes.length;
    });
  }

  async close() { this.closes += 1; }
}

const devices = new Map();
let opens = 0;
let openError = null;
const fakeHid = {
  HIDAsync: {
    open: async (path) => {
      opens += 1;
      if (openError) throw openError;
      if (!devices.has(path)) devices.set(path, new FakeDevice());
      return devices.get(path);
    },
  },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return fakeHid;
  return load.call(this, request, ...rest);
};
const kysona = require('../src/main/hid/drivers/kysona');
const generic = require('../src/main/hid/drivers/generic');
const { findChannel } = require('../src/main/hid/catalog');
Module._load = load;

let nextPath = 0;
function mouse() {
  const path = `mouse-${nextPath += 1}`;
  const dev = new FakeDevice();
  devices.set(path, dev);
  return { dev, path, logical: { channels: [{ path, usagePage: 0xff02, usage: 2 }] } };
}
const reply = (capacity, charging = 0) => [8, 4, 0, 0, 0, 0, capacity, charging, 0x0f, 0xa0];
// Status answers exactly as a VXE R1 Pro receiver sent them, with the mouse on and off.
const hexFrame = (text) => text.split(' ').map((b) => parseInt(b, 16));
const statusOn = () => hexFrame('08 03 00 00 00 01 01 b5 b6 0d 00 00 00 00 00 00 d0');
const statusOff = () => hexFrame('08 03 00 00 00 01 00 b5 b6 0d 00 00 00 00 00 00 d1');

test('kysona: the receiver saying it has no mouse twice means the mouse is off', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], statusOff(), [], [], [], [], [], statusOff()];
  await assert.rejects(kysona.readBattery(logical), /^Error: mouse is off$/);
  assert.equal(dev.closes, 0);
});

test('kysona: one "no mouse" answer while the switch moves is not enough', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], statusOff(), statusOn(), statusOff(), reply(88)];
  assert.equal((await kysona.readBattery(logical)).capacity, 88);
});

test('kysona: a "connected" answer from a receiver busy reaching a sleeping mouse is not trusted', async () => {
  // As seen with two programs asking at once: "connected" first, then the truth.
  const { dev, logical } = mouse();
  dev.reads = [[], statusOn(), [], [], statusOff(), [], [], statusOff()];
  await assert.rejects(kysona.readBattery(logical), /^Error: mouse is off$/);
});

test('kysona: no battery request goes out while the receiver says it has no mouse', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], statusOff(), [], [], statusOff()];
  await assert.rejects(kysona.readBattery(logical), /mouse is off/);
  assert.ok(dev.sent.length > 0 && !dev.sent.includes(0x04), `sent ${dev.sent}`);
});

test('kysona: once the receiver has the mouse, the battery is asked for straight away', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], statusOn(), [], reply(77)];
  assert.equal((await kysona.readBattery(logical)).capacity, 77);
  assert.deepEqual(dev.sent, [0x03, 0x03, 0x04]);
});

test('kysona: a battery answer wins over a stale "no mouse"', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], statusOff(), reply(90)];
  assert.equal((await kysona.readBattery(logical)).capacity, 90);
});

test('kysona: a receiver whose command report is a feature report is asked with feature reports (#92, #196)', async () => {
  const { dev, logical } = mouse();
  dev.reads = [new Error('could not read data from device')];
  dev.features = [statusOn(), reply(80).concat(new Array(7).fill(0))];
  assert.equal((await kysona.readBattery(logical)).capacity, 80);
  assert.deepEqual(dev.featuresSent, [0x03, 0x04]);
});

test('kysona: on a feature-only receiver, our own request read back is not taken for "no mouse"', async () => {
  const { dev, logical } = mouse();
  dev.reads = [new Error('could not read data from device')];
  dev.features = [null, null, statusOn(), reply(64).concat(new Array(7).fill(0))];
  assert.equal((await kysona.readBattery(logical)).capacity, 64);
});

test('kysona: when the command collection fails both ways, the next vendor collection is asked and the error names both', async () => {
  const first = mouse();
  first.dev.reads = [new Error('could not read data from device')];
  first.dev.featureError = new Error('could not get feature report');
  const second = mouse();
  second.dev.reads = [[], reply(55)];
  const logical = { channels: [first.logical.channels[0], { ...second.logical.channels[0], usagePage: 0xff04 }] };
  assert.equal((await kysona.readBattery(logical)).capacity, 55);

  const a = mouse();
  a.dev.reads = [new Error('could not read data from device')];
  a.dev.featureError = new Error('could not get feature report');
  const b = mouse();
  b.dev.writeError = new Error('Cannot write to hid device');
  const both = { channels: [a.logical.channels[0], { ...b.logical.channels[0], usagePage: 0xff03, usage: undefined }] };
  await assert.rejects(kysona.readBattery(both), /^Error: ff02:0002 could not read data from device \(feature reports: could not get feature report\); ff03:---- Cannot write/);
});

test('kysona: status answers are checked like Linux checks them', () => {
  assert.equal(kysona.parseStatus(statusOn()), true);
  assert.equal(kysona.parseStatus(statusOff()), false);
  const corrupt = statusOff();
  corrupt[16] = 0xd0; // checksum of the "on" frame
  assert.equal(kysona.parseStatus(corrupt), null);
  assert.equal(kysona.parseStatus(reply(50)), null);
  assert.equal(kysona.parseStatus([8, 3, 0, 0, 0, 1, 1]), null, 'too short to carry a checksum');
});

test('kysona: reads a reply and leaves the handle open for the next poll', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], reply(65, 1)];
  assert.deepEqual(await kysona.readBattery(logical), { capacity: 65, charging: true, voltageMv: 4000 });
  assert.equal(dev.closes, 0, 'closing here risks freeing memory the kernel is still using');

  const opensBefore = opens;
  dev.reads = [[], reply(64)];
  assert.equal((await kysona.readBattery(logical)).capacity, 64);
  assert.equal(opens, opensBefore, 'the second poll must reuse the handle');
});

test('kysona: never runs two operations on a handle at once', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], [], [], reply(50)];
  await kysona.readBattery(logical);
  assert.equal(dev.maxInFlight, 1);
});

test('kysona: discards a late reply left over from an earlier request', async () => {
  const { dev, logical } = mouse();
  dev.reads = [reply(99), [], reply(70)];
  assert.equal((await kysona.readBattery(logical)).capacity, 70);
});

test('kysona: skips zeroed not-ready frames', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[], reply(0), reply(42)];
  assert.equal((await kysona.readBattery(logical)).capacity, 42);
});

test('kysona: a rejected write fails the read, keeps the handle and stops writing', async () => {
  const { dev, logical } = mouse();
  dev.writeError = new Error('Cannot write to hid device');
  await assert.rejects(kysona.readBattery(logical), /Cannot write/);
  assert.equal(dev.closes, 0, 'a read may still be pending, so this handle must not be closed');
  assert.equal(dev.writes, 1);
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(dev.writes, 1, 'nothing may keep poking after the read has failed');
});

test('a failed read closes the handle, and the next poll opens a fresh one', async () => {
  const { dev, logical } = mouse();
  dev.reads = [new Error('could not read data from device')];
  dev.featureError = new Error('could not get feature report'); // not a feature-only receiver either
  await assert.rejects(kysona.readBattery(logical), /could not read/);
  assert.equal(dev.closes, 2, 'a failed read or feature report leaves nothing pending, so these closes are safe');
  dev.featureError = null;

  const opensBefore = opens;
  dev.reads = [[], reply(30)];
  await kysona.readBattery(logical);
  assert.equal(opens, opensBefore + 1);
});

test('a failed open can be retried', async () => {
  const { dev, logical } = mouse();
  openError = new Error('cannot open device with path x');
  await assert.rejects(kysona.readBattery(logical), /cannot open/);
  openError = null;
  dev.reads = [[], reply(30)];
  assert.equal((await kysona.readBattery(logical)).capacity, 30);
});

const inputProfile = { usagePage: 0xff02, usage: 2, reportKind: 'input', reportId: 5, byteOffset: 2, scaleMin: 0, scaleMax: 100, trigger: null };

test('generic: uses the newest frame broadcast since the last poll', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[5, 1, 80], [9, 1, 11], [5, 1, 78]];
  assert.equal((await generic.readBattery(logical, inputProfile)).capacity, 78);
  assert.equal(dev.closes, 0);
});

test('generic: a rejected trigger write does not abort listening', async () => {
  const { dev, logical } = mouse();
  dev.writeError = new Error('Cannot write to hid device');
  dev.reads = [[], [], [5, 1, 60]];
  const profile = { ...inputProfile, trigger: [0, 0] };
  assert.equal((await generic.readBattery(logical, profile)).capacity, 60);
});

test('generic: an all-zero frame is not reported as 0%', async () => {
  const { dev, logical } = mouse();
  dev.reads = [[5, 0, 0], [], [5, 1, 55]];
  assert.equal((await generic.readBattery(logical, inputProfile)).capacity, 55);
});

test('generic: a feature report too short for the profile gives no reading, not NaN', async () => {
  const { dev, logical } = mouse();
  dev.feature = [5, 1];
  const profile = { ...inputProfile, reportKind: 'feature', readLength: 8, byteOffset: 6 };
  await assert.rejects(generic.readBattery(logical, profile), /waiting/);
  dev.feature = [5, 1, 0, 0, 0, 0, 72];
  assert.equal((await generic.readBattery(logical, profile)).capacity, 72);
});

test('findChannel: tells apart collections on the same usage page', () => {
  const device = { channels: [
    { path: 'keyboard', usagePage: 1, usage: 6 },
    { path: 'system', usagePage: 1, usage: 128 },
    { path: 'mouse', usagePage: 1, usage: 2 },
  ] };
  assert.equal(findChannel(device, 1, 128).path, 'system');
  assert.equal(findChannel(device, 1).path, 'keyboard', 'older profiles keep working');
  assert.equal(findChannel(device, 2), undefined);
});

test('generic: a failed feature report drops the handle, so a replugged device reads again', async () => {
  const { dev, logical } = mouse();
  const profile = { ...inputProfile, reportKind: 'feature', readLength: 8, byteOffset: 6 };
  dev.featureError = new Error('could not get feature report from device');
  await assert.rejects(generic.readBattery(logical, profile), /could not get feature report/);
  assert.equal(dev.closes, 1);
  const opensBefore = opens;
  dev.featureError = null;
  dev.feature = [5, 1, 0, 0, 0, 0, 44];
  assert.equal((await generic.readBattery(logical, profile)).capacity, 44);
  assert.equal(opens, opensBefore + 1, 'the next poll must open a fresh handle');
});

test('kysona: a receiver that refuses writes on 0xFF02 is tried on its other vendor collections', async () => {
  const main = new FakeDevice();
  const other = new FakeDevice();
  main.writeError = new Error('Cannot write to hid device');
  other.reads = [[], reply(66)];
  devices.set('fa09-ff02', main);
  devices.set('fa09-ff04', other);
  const logical = { channels: [
    { path: 'fa09-mouse', usagePage: 0x01, usage: 2 },
    { path: 'fa09-ff04', usagePage: 0xff04, usage: 2 },
    { path: 'fa09-ff02', usagePage: 0xff02, usage: 2 },
  ] };
  assert.equal((await kysona.readBattery(logical)).capacity, 66);
  assert.equal(main.writes, 1, 'the command collection is still tried first');
});

test('kysona: when every collection refuses writes, that is the error reported', async () => {
  const main = new FakeDevice();
  main.writeError = new Error('Cannot write to hid device');
  devices.set('only-ff02', main);
  await assert.rejects(kysona.readBattery({ channels: [{ path: 'only-ff02', usagePage: 0xff02, usage: 2 }] }), /Cannot write/);
});

test('kysona: a card saved for the Compx keyboard receiver is read with the Compx protocol', async () => {
  const dev = new FakeDevice();
  const push = [0x13, 0x0a, 0x01, 0x00, 0x04, 0x05, 0x47, 0x01, ...new Array(11).fill(0)];
  push.push(push.reduce((a, b) => a + b, 0) & 0xff);
  dev.reads = [[], push];
  devices.set('fa09-cmd', dev);
  const receiver = { vendorId: 0x3554, productId: 0xfa09, channels: [{ path: 'fa09-cmd', usagePage: 0xff02, usage: 2 }] };
  assert.deepEqual(await kysona.readBattery(receiver), { capacity: 71, charging: false });
  assert.ok(dev.sent.includes(0x05) && dev.sent.includes(0x4a), 'session and battery requests in report 0x13 format');
});

// Redragon receivers: the request goes out as feature report 8 on 0xFF02, the answer comes back as
// input report 9 on 0xFF01 (issues #92, #224).
function redragon() {
  const command = mouse();
  command.dev.reads = [new Error('could not read data from device')];
  const answers = mouse();
  const logical = { channels: [command.logical.channels[0], { path: answers.path, usagePage: 0xff01, usage: undefined }] };
  return { command: command.dev, answers: answers.dev, logical };
}
const frame9 = (bytes) => { const f = bytes.concat(new Array(17 - bytes.length).fill(0)); f[16] = (0x55 - f.slice(0, 16).reduce((a, b) => a + b, 0)) & 0xff; return f; };

test('kysona: a Redragon receiver is asked on 0xFF02 and answers with report 9 on 0xFF01, level 0-10', async () => {
  const { command, answers, logical } = redragon();
  answers.reads = [[], frame9([9, 3, 0, 0, 0, 1, 1]), frame9([9, 4, 0, 0, 0x0a, 1, 8, 0])];
  const reading = await kysona.readBattery(logical);
  assert.deepEqual([reading.capacity, reading.charging], [80, false]);
  assert.deepEqual(command.featuresSent.slice(0, 2), [0x03, 0x04]);
});

test('kysona: report 9 with a percent level, and charging', () => {
  assert.deepEqual(kysona.parseFrame(frame9([9, 4, 0, 0, 0, 2, 64, 1])), { capacity: 64, charging: true });
  assert.deepEqual(kysona.parseFrame(frame9([9, 4, 0, 0, 0, 1, 0x85, 0])), { capacity: 50, charging: true });
  assert.equal(kysona.parseFrame(frame9([9, 4, 0, 0, 0, 1, 0, 0])), null);
  assert.equal(kysona.parseFrame(frame9([9, 0x0a, 0, 0, 0, 1, 5, 0])), null);
});

test('kysona: a Redragon receiver saying twice it has no mouse means the mouse is off', async () => {
  const { answers, logical } = redragon();
  answers.reads = [[], frame9([9, 3, 0, 0, 0, 1, 0]), frame9([9, 3, 0, 0, 0, 1, 0])];
  await assert.rejects(kysona.readBattery(logical), /^Error: mouse is off$/);
});

test('kysona: the VSG Aquila Fly receiver reads 0-10, and 100 on the cable is full, not charging (#224)', async () => {
  assert.deepEqual(kysona.parseFrame(frame9([9, 4, 0, 0, 0, 2, 6, 0]), true), { capacity: 60, charging: false });
  assert.deepEqual(kysona.parseFrame(frame9([9, 4, 0, 0, 0, 2, 8, 1]), true), { capacity: 80, charging: true });
  assert.deepEqual(kysona.parseFrame(frame9([9, 4, 0, 0, 0, 2, 10, 1]), true), { capacity: 100, charging: false });
  assert.deepEqual(kysona.parseFrame(frame9([9, 4, 0, 0, 0, 2, 6, 0])), { capacity: 6, charging: false });
  const { answers, logical } = redragon();
  logical.productId = 0xfa3f;
  answers.reads = [[], frame9([9, 4, 0, 0, 0, 2, 7, 0])];
  assert.equal((await kysona.readBattery(logical)).capacity, 70);
});

test('session: a failed write closes the handle only when no read is pending on it', async () => {
  const session = require('../src/main/hid/session');
  const quiet = mouse();
  const dev = await session.acquire(quiet.path);
  quiet.dev.reads = [[]]; // a read that timed out: hidapi leaves it running
  await session.read(quiet.path, dev, 10);
  quiet.dev.writeError = new Error('Cannot write to hid device');
  await assert.rejects(session.write(quiet.path, dev, [1]), /Cannot write/);
  assert.equal(quiet.dev.closes, 0, 'a read may still be pending');

  const idle = mouse();
  const dev2 = await session.acquire(idle.path);
  idle.dev.reads = [[0x01, 0x02]]; // the last read came back with data: nothing pending
  await session.read(idle.path, dev2, 10);
  idle.dev.writeError = new Error('Cannot write to hid device');
  await assert.rejects(session.write(idle.path, dev2, [1]), /Cannot write/);
  await new Promise((r) => setImmediate(r));
  assert.equal(idle.dev.closes, 1);
});

test('session: serialize runs calls with one key one after another, other keys alongside', async () => {
  const { serialize } = require('../src/main/hid/session');
  const log = [];
  const slow = (name, ms) => () => new Promise((r) => setTimeout(() => { log.push(name); r(name); }, ms));
  await Promise.all([serialize('a', slow('a1', 30)), serialize('a', slow('a2', 1)), serialize('b', slow('b1', 5))]);
  assert.deepEqual(log, ['b1', 'a1', 'a2']);
  await assert.rejects(serialize('a', () => Promise.reject(new Error('x'))), /x/);
  assert.equal(await serialize('a', () => 'after a failure'), 'after a failure');
});
