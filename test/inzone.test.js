// SONY INZONE Buds over its USB dongle, checked against a reply captured on real hardware.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return {};
  return load.call(this, request, ...rest);
};
const inzone = require('../src/main/hid/drivers/inzone');
Module._load = load;

// Ears in, TID 1: left 99, right 99, case 96.
const REPLY = [0x02, 0x12, 0x04, 0xff, 0x0f, 0x00, 0x96, 0xc3, 0x14, 0x04, 0x10, 0x01, 0x00, 0x00, 0x63, 0x00, 0x63, 0xff, 0x60, 0xa7];
const withSum = (f) => { const g = f.slice(); g[19] = g.slice(5, 19).reduce((a, b) => a + b, 0) & 0xff; return g; };

test('inzone: the battery request for TID 1 matches the capture', () => {
  const r = inzone.request(1);
  assert.equal(r.length, 64);
  assert.deepEqual(r.slice(0, 14), [0x02, 0x0c, 0x01, 0x00, 0xfc, 0x08, 0x96, 0xc3, 0x41, 0x04, 0x01, 0x01, 0x00, 0xa0]);
  assert.ok(r.slice(14).every((b) => b === 0));
});

test('inzone: the TID goes in little-endian and changes the checksum', () => {
  const r = inzone.request(0x4001);
  assert.deepEqual(r.slice(11, 14), [0x01, 0x40, (0x96 + 0xc3 + 0x41 + 0x04 + 0x01 + 0x01 + 0x40) & 0xff]);
});

test('inzone: the captured reply reads left 99, right 99, case 96', () => {
  assert.deepEqual(inzone.parseReply(REPLY, 1), { left: 99, right: 99, case: 96 });
});

test('inzone: an unreported part is null', () => {
  const f = REPLY.slice(); f[16] = 0xff;
  assert.deepEqual(inzone.parseReply(withSum(f), 1), { left: 99, right: null, case: 96 });
});

test('inzone: a level above 100 that is not 0xFF counts as unreported', () => {
  const f = REPLY.slice(); f[14] = 0x65;
  assert.equal(inzone.parseReply(withSum(f), 1).left, null);
});

test('inzone: frames that are not our battery reply are skipped', () => {
  assert.equal(inzone.parseReply(REPLY, 2), null, 'other TID');
  const ev = REPLY.slice(); ev[9] = 0x01; assert.equal(inzone.parseReply(withSum(ev), 1), null, 'other event');
  const ty = REPLY.slice(); ty[10] = 0x20; assert.equal(inzone.parseReply(withSum(ty), 1), null, 'notification type');
  const bad = REPLY.slice(); bad[19] = 0x00; assert.equal(inzone.parseReply(bad, 1), null, 'bad checksum');
  assert.equal(inzone.parseReply(REPLY.slice(0, 19), 1), null, 'short frame');
  const id = REPLY.slice(); id[0] = 0x07; assert.equal(inzone.parseReply(id, 1), null, 'other report id');
});

test('inzone: TIDs count up from 0x4000 and wrap from 0xFFFF to 1', () => {
  inzone._resetTid();
  assert.equal(inzone.nextTid(), 0x4000);
  assert.equal(inzone.nextTid(), 0x4001);
  inzone._resetTid(0xffff);
  assert.equal(inzone.nextTid(), 0xffff);
  assert.equal(inzone.nextTid(), 1);
});

// ---------- reading ----------
const { detectDriver } = require('../src/main/hid/drivers');
const exchange = require('../src/main/hid/drivers/exchange');

const BUDS = { id: 'b', vendorId: 0x054c, productId: 0x0ec2, channels: [{ path: 'p3', usagePage: 0xff04, usage: 0x0001 }, { path: 'p1', usagePage: 0xff13, usage: 0x0001 }] };
const replyFor = (tid, { left = 0x63, right = 0x63, kase = 0x60 } = {}) => {
  const f = REPLY.slice();
  f[11] = tid & 0xff; f[12] = (tid >> 8) & 0xff; f[14] = left; f[16] = right; f[18] = kase;
  return withSum(f);
};

// Each call takes the next script: a list of frames fed to accept, 'timeout', or an Error to throw.
async function withScript(scripts, fn) {
  const calls = [];
  const original = exchange.exchange;
  exchange.exchange = async (channel, request, accept, timeoutMs) => {
    calls.push({ path: channel.path, request, timeoutMs });
    const script = scripts[calls.length - 1];
    if (script instanceof Error) throw script;
    for (const f of Array.isArray(script) ? script : []) {
      const result = accept(f);
      if (result !== null && result !== undefined) return result;
    }
    throw new Error('timeout waiting for battery response');
  };
  try {
    inzone._resetTid(1);
    await fn(calls);
  } finally {
    exchange.exchange = original;
    inzone._resetTid();
  }
}

test('inzone: matches the dongle by id and command collection only', () => {
  assert.equal(inzone.matches(BUDS), true);
  assert.equal(inzone.matches({ ...BUDS, channels: [BUDS.channels[1]] }), false);
  assert.equal(inzone.matches({ ...BUDS, productId: 0x0ce6 }), false);
});

test('inzone: the driver list picks inzone for the buds and playstation for a DualSense', () => {
  assert.equal(detectDriver(BUDS).id, 'inzone');
  assert.equal(detectDriver({ vendorId: 0x054c, productId: 0x0ce6, channels: [{ path: 'd', usagePage: 0x0001, usage: 0x0005 }] }).id, 'playstation');
});

test('inzone: reads the captured reply after skipping a reply to INZONE Hub', async () => {
  const hub = replyFor(2);
  await withScript([[hub, REPLY]], async (calls) => {
    assert.deepEqual(await inzone.readBattery(BUDS), { capacity: 99, charging: false, parts: { left: 99, right: 99, case: 96 } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, 'p3');
    assert.equal(calls[0].timeoutMs, 1000);
  });
});

test('inzone: the card shows the lower earbud', async () => {
  await withScript([[replyFor(1, { right: 0x50 })]], async () => {
    assert.equal((await inzone.readBattery(BUDS)).capacity, 80);
  });
});

test('inzone: one earbud reported is enough', async () => {
  await withScript([[replyFor(1, { right: 0xff })]], async () => {
    const reading = await inzone.readBattery(BUDS);
    assert.equal(reading.capacity, 99);
    assert.equal(reading.parts.right, null);
  });
});

test('inzone: no earbud reported means the headset is off', async () => {
  await withScript([[replyFor(1, { left: 0xff, right: 0xff })]], async () => {
    await assert.rejects(inzone.readBattery(BUDS), /^Error: headset is off$/);
  });
});

test('inzone: a missed reply is asked again with a new TID', async () => {
  await withScript(['timeout', [replyFor(2)]], async (calls) => {
    assert.equal((await inzone.readBattery(BUDS)).capacity, 99);
    assert.equal(calls.length, 2);
    assert.notDeepEqual(calls[0].request.slice(11, 13), calls[1].request.slice(11, 13));
  });
});

test('inzone: two missed replies mean the headset is off', async () => {
  await withScript(['timeout', 'timeout'], async (calls) => {
    await assert.rejects(inzone.readBattery(BUDS), /^Error: headset is off$/);
    assert.equal(calls.length, 2);
  });
});

test('inzone: a failed write is reported as it is', async () => {
  await withScript([new Error('could not write')], async (calls) => {
    await assert.rejects(inzone.readBattery(BUDS), /could not write/);
    assert.equal(calls.length, 1);
  });
});

// The poller guesses charging from a rising level when a reading says null. The card follows the
// lower earbud, so putting that earbud in the case makes the level jump to the other one, which must
// not read as charging.
test('inzone: a jump to the other earbud is never left to be guessed as charging', async () => {
  await withScript([[replyFor(1, { left: 0x32 })], [replyFor(2, { left: 0xff })]], async () => {
    const before = await inzone.readBattery(BUDS);
    const after = await inzone.readBattery(BUDS);
    assert.deepEqual([before.capacity, after.capacity], [50, 99]);
    assert.strictEqual(before.charging, false);
    assert.strictEqual(after.charging, false);
  });
});

// The dongle calls itself "Hid Interface", so the icon comes from the driver, as for MCHOSE and Audeze.
test('inzone: the buds get the headset icon whatever the dongle calls itself', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'icons.js'), 'utf8'), context);
  assert.equal(vm.runInContext("iconFor('Hid Interface', 'inzone')", context), 'headset');
  assert.equal(vm.runInContext("iconFor('Hid Interface', null)", context), 'plug');
  assert.equal(vm.runInContext("iconFor('Wireless Controller', 'playstation')", context), 'controller');
});
