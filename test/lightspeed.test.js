// One Lightspeed receiver, several devices: each paired device gets its own card.
// Byte fixtures are what the G913 TKL / G502 X receiver (046d:c547) sent during fork Issue #2.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-hid') return {};
  return load.call(this, request, ...rest);
};
const lightspeed = require('../src/main/hid/drivers/lightspeed');
const { identityOf, planMerges } = require('../src/main/identity');
Module._load = load;

const hex = (t) => t.split(' ').map((b) => parseInt(b, 16));

test('pairing info: wireless PID and kind from the bytes the G913 TKL / G502 X receiver sent', () => {
  assert.deepEqual(lightspeed.parsePairing(hex('20 07 08 40 8e 11 00 01 b3')), { wpid: 0x408e, kind: 1 });
  assert.deepEqual(lightspeed.parsePairing(hex('21 08 08 40 9f 11 00 02 b1')), { wpid: 0x409f, kind: 2 });
  assert.equal(lightspeed.parsePairing(hex('22 00 00 00 00 00 00 00')), null);
});

test('device name: length then ASCII', () => {
  const name = [0x40, 8, ...Buffer.from('G913 TKL')];
  assert.equal(lightspeed.parseName(name), 'G913 TKL');
  assert.equal(lightspeed.parseName([0x41, 0]), null);
});

test('a child keeps its id across slots and takes the receiver short name', () => {
  const parent = { id: '1133:50503:ABC', vendorId: 0x046d, productId: 0xc547, serialNumber: 'ABC', product: 'USB Receiver', manufacturer: 'Logitech', channels: [] };
  const a = lightspeed.childOf(parent, { slot: 1, wpid: 0x408e, kind: 1, name: 'G913 TKL' });
  const b = lightspeed.childOf(parent, { slot: 2, wpid: 0x408e, kind: 1, name: 'G913 TKL' });
  assert.equal(a.id, '1133:50503:ABC:408e');
  assert.equal(a.id, b.id);
  assert.equal(a.product, 'G913 TKL');
  assert.deepEqual(a.receiver, { slot: 1, wpid: 0x408e, kind: 1 });
  assert.equal(a.identity, undefined);
  assert.equal(lightspeed.childOf(parent, { slot: 2, wpid: 0x409f, kind: 2, name: null }).product, 'Logitech mouse');
});

test('only the c547 receiver with both HID++ collections is a target', () => {
  const ch = [{ usagePage: 0xff00, usage: 1 }, { usagePage: 0xff00, usage: 2 }];
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc547, channels: ch }), true);
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc548, channels: ch }), false);
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc547, channels: [ch[1]] }), false);
});

test('children of a receiver whose serial looks like a Bluetooth address are never merged', () => {
  const serial = '0123456789ab';
  const live = { id: `1133:50503:${serial}:408e`, serialNumber: serial };
  assert.equal(identityOf(live), null);
  const saved = { a: { id: `1133:50503:${serial}:408e` }, b: { id: `1133:50503:${serial}:409f` } };
  assert.equal(identityOf(saved.a), null);
  assert.deepEqual(planMerges(saved), []);
  const livePair = { a: { id: `1133:50503:${serial}:408e`, serialNumber: serial }, b: { id: `1133:50503:${serial}:409f`, serialNumber: serial } };
  assert.deepEqual(planMerges(livePair), []);
  assert.equal(identityOf({ id: `1133:50503:${serial}` }), `mac:${serial}`); // unchanged for others
});

// ---- expanding a receiver into its devices ----

const RECEIVER = {
  id: '1133:50503:ABC', vendorId: 0x046d, productId: 0xc547, serialNumber: 'ABC', product: 'USB Receiver', manufacturer: 'Logitech',
  channels: [{ path: 'short', usagePage: 0xff00, usage: 1 }, { path: 'long', usagePage: 0xff00, usage: 2 }],
};
const KEYBOARD = { pairing: hex('20 07 08 40 8e 11 00 01 b3'), name: [0x40, 8, ...Buffer.from('G913 TKL')] };
const MOUSE = { pairing: hex('21 08 08 40 9f 11 00 02 b1'), name: [0x41, 9, ...Buffer.from('G502 X LS')] };

// Answers per sub-address; anything not listed is an empty slot (the receiver's 0x8F error).
function receiverAnswering(slots, calls = []) {
  const table = {};
  slots.forEach((dev, i) => {
    if (!dev) return;
    table[0x20 + i] = [0x20 + i, ...dev.pairing.slice(1)];
    table[0x40 + i] = [0x40 + i, ...dev.name.slice(1)];
  });
  return () => async (sub) => {
    calls.push(sub);
    if (table[sub]) return table[sub];
    throw new Error('register error 9');
  };
}
const failing = (message, calls = []) => () => async (sub) => { calls.push(sub); throw new Error(message); };

test('a receiver lists one child per paired device, after the receiver itself', async () => {
  lightspeed._reset();
  const out = await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([KEYBOARD, MOUSE]) });
  assert.deepEqual(out.map((d) => d.id), ['1133:50503:ABC', '1133:50503:ABC:408e', '1133:50503:ABC:409f']);
  assert.equal(out[0].expanded, true);
  assert.deepEqual(out.slice(1).map((d) => d.receiver.slot), [1, 2]);
  assert.deepEqual(out.slice(1).map((d) => d.product), ['G913 TKL', 'G502 X LS']);
  assert.equal(out[1].expanded, undefined);
});

test('non-target devices are never asked', async () => {
  lightspeed._reset();
  const calls = [];
  const bolt = { ...RECEIVER, id: '1133:50504:B', productId: 0xc548 };
  const other = { ...RECEIVER, id: '4660:1:C', vendorId: 0x1234, productId: 0xc547 };
  const out = await lightspeed.expandReceivers([bolt, other], { ask: receiverAnswering([KEYBOARD], calls) });
  assert.deepEqual(calls, []);
  assert.deepEqual(out, [bolt, other]);
});

test('a receiver with nothing paired is returned as it is', async () => {
  lightspeed._reset();
  const out = await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([]) });
  assert.deepEqual(out, [RECEIVER]);
});

test('a second listing does not ask again, a fresh one does', async () => {
  lightspeed._reset();
  const calls = [];
  const ask = receiverAnswering([KEYBOARD, MOUSE], calls);
  await lightspeed.expandReceivers([RECEIVER], { ask });
  const asked = calls.length;
  const again = await lightspeed.expandReceivers([RECEIVER], { ask });
  assert.equal(calls.length, asked);
  assert.equal(again.length, 3);
  await lightspeed.expandReceivers([RECEIVER], { ask, fresh: true });
  assert.ok(calls.length > asked);
});

test('slots swapped on a fresh listing keep the same child ids', async () => {
  lightspeed._reset();
  const first = await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([KEYBOARD, MOUSE]) });
  const swapped = await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([MOUSE, KEYBOARD]), fresh: true });
  const slotOf = (list, id) => list.find((d) => d.id === id).receiver.slot;
  assert.deepEqual(swapped.map((d) => d.id).sort(), first.map((d) => d.id).sort());
  assert.equal(slotOf(swapped, '1133:50503:ABC:408e'), 2);
  assert.equal(slotOf(swapped, '1133:50503:ABC:409f'), 1);
});

test('no answer keeps the previous children', async () => {
  lightspeed._reset();
  await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([KEYBOARD, MOUSE]) });
  const out = await lightspeed.expandReceivers([RECEIVER], { ask: failing('timeout waiting for register reply'), fresh: true });
  assert.deepEqual(out.map((d) => d.id), ['1133:50503:ABC', '1133:50503:ABC:408e', '1133:50503:ABC:409f']);
});

test('an I/O failure keeps the previous children', async () => {
  lightspeed._reset();
  assert.deepEqual(await lightspeed.expandReceivers([RECEIVER], { ask: failing('could not write') }), [RECEIVER]);
  await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([KEYBOARD]), fresh: true });
  const out = await lightspeed.expandReceivers([RECEIVER], { ask: failing('could not write'), fresh: true });
  assert.deepEqual(out.map((d) => d.id), ['1133:50503:ABC', '1133:50503:ABC:408e']);
});

test('unpairing everything drops the children', async () => {
  lightspeed._reset();
  await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([KEYBOARD, MOUSE]) });
  assert.deepEqual(await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([]), fresh: true }), [RECEIVER]);
  assert.deepEqual(await lightspeed.expandReceivers([RECEIVER], { ask: receiverAnswering([KEYBOARD]) }).then((l) => l.length), 2);
});

test('an unplugged receiver is forgotten', async () => {
  lightspeed._reset();
  const calls = [];
  const ask = receiverAnswering([KEYBOARD], calls);
  await lightspeed.expandReceivers([RECEIVER], { ask });
  await lightspeed.expandReceivers([], { ask });
  const asked = calls.length;
  await lightspeed.expandReceivers([RECEIVER], { ask });
  assert.ok(calls.length > asked);
});

test('serialize runs calls on one key one at a time', async () => {
  lightspeed._reset();
  const log = [];
  const step = (name, fail) => async () => {
    log.push(`${name}+`);
    await new Promise((r) => setTimeout(r, 10));
    log.push(`${name}-`);
    if (fail) throw new Error('boom');
  };
  const a = lightspeed.serialize('k', step('a', true));
  const b = lightspeed.serialize('k', step('b'));
  const c = lightspeed.serialize('other', step('c'));
  await assert.rejects(a, /boom/);
  await b;
  await c;
  const order = log.filter((e) => e[0] !== 'c');
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-']);
  assert.ok(log.indexOf('c+') < log.indexOf('a-')); // another key does not wait
});
