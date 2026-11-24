// One Logitech Lightspeed receiver can hold several devices (a keyboard and a mouse). The receiver is
// one USB device, so the catalog sees it once; here it is split into one logical device per paired
// device, so each gets its own card. The receiver itself answers for its pairings (HID++ 1.0 register
// 0xB5) even while the devices sleep.
//
// A child's id is the receiver's id plus the device's wireless PID, never the slot, so a device that
// is paired again into another slot keeps its card.
const session = require('../session');

const LOGITECH = 0x046d;
const RECEIVER_PIDS = [0xc547]; // Lightspeed receivers this is known to work on
const KINDS = { 1: 'Logitech keyboard', 2: 'Logitech mouse' };

const hasChannel = (device, usage) => device.channels.some((c) => c.usagePage === 0xff00 && c.usage === usage);

function isTarget(device) {
  return device.vendorId === LOGITECH && RECEIVER_PIDS.includes(device.productId)
    && hasChannel(device, 0x01) && hasChannel(device, 0x02);
}

// Pairing info (0xB5 0x20+n): <sub> <?> <?> <wpid hi> <wpid lo> <?> <?> <kind>
function parsePairing(params) {
  const wpid = (params[3] << 8) | params[4];
  if (!wpid) return null;
  return { wpid, kind: params[7] };
}

// Device name (0xB5 0x40+n): <sub> <length> <ASCII...>
function parseName(params) {
  const length = params[1];
  if (!length || params.length < 2 + length) return null;
  return String.fromCharCode(...params.slice(2, 2 + length));
}

const wpidHex = (wpid) => wpid.toString(16).padStart(4, '0');

function childOf(parent, { slot, wpid, kind, name }) {
  const { expanded, ...base } = parent;
  return {
    ...base,
    id: `${parent.id}:${wpidHex(wpid)}`,
    product: name || KINDS[kind] || 'Logitech device',
    receiver: { slot, wpid, kind },
  };
}

// One exchange at a time per receiver: a listing and a battery read on the same receiver would
// each throw away the other's replies.
const locks = new Map(); // key -> tail of the chain
function serialize(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

const SLOTS = [1, 2, 3, 4, 5, 6];
const PAIRING = 0x20;
const NAME = 0x40;
const REGISTER_ERROR = /^register error/;
const TIMEOUT = /^timeout/;

// ask(sub) -> params of register 0xB5 at that sub-address. "answered" says the receiver replied for
// at least one slot; then a slot that only timed out is taken to be empty, since the receiver itself
// answers for paired devices even while they sleep.
async function scanReceiver(ask) {
  let answered = false;
  const devices = [];
  for (const slot of SLOTS) {
    let pairing;
    try {
      pairing = parsePairing(await ask(PAIRING + slot - 1));
      answered = true;
    } catch (e) {
      if (REGISTER_ERROR.test(e.message)) answered = true;
      continue; // empty, timed out, or the receiver could not be reached
    }
    if (!pairing) continue;
    let name = null;
    try { name = parseName(await ask(NAME + slot - 1)); } catch (_) {}
    devices.push({ slot, ...pairing, name });
  }
  return { answered, devices };
}


const cache = new Map(); // receiver id -> devices found on it, while it stays plugged in

// HID++ 1.0 long register read of 0xB5: sent as a short report, answered as a long one. The
// receiver's error answer is short, and Windows hands short and long reports to separate
// collections, so both are read.
const SHORT = 0x10;
const LONG = 0x11;
const RECEIVER_INDEX = 0xff;
const GET_LONG_REGISTER = 0x83;
const PAIRING_REGISTER = 0xb5;
const ERROR = 0x8f;
const REPLY_MS = 400;
const READ_SLICE_MS = 50;

const request = (sub) => [SHORT, RECEIVER_INDEX, GET_LONG_REGISTER, PAIRING_REGISTER, sub, 0x00, 0x00];

// The params of the receiver's answer to this sub-address; throws on its error answer.
function replyTo(frame, sub) {
  if (frame.length < 6 || frame[1] !== RECEIVER_INDEX) return null;
  if (frame[0] === SHORT && frame[2] === ERROR && frame[3] === GET_LONG_REGISTER && frame[4] === PAIRING_REGISTER) {
    throw new Error(`register error ${frame[5]}`);
  }
  if (frame[0] !== LONG || frame[2] !== GET_LONG_REGISTER || frame[3] !== PAIRING_REGISTER || frame[4] !== sub) return null;
  return frame.slice(4);
}

const channelOf = (device, usage) => device.channels.find((c) => c.usagePage === 0xff00 && c.usage === usage);

function realAsk(parent) {
  const short = channelOf(parent, 0x01);
  const long = channelOf(parent, 0x02);
  return async (sub) => {
    const ends = [[short.path, await session.acquire(short.path)], [long.path, await session.acquire(long.path)]];
    for (const [path, dev] of ends) await session.readQueued(path, dev); // a late reply to an old request is stale
    await session.write(short.path, ends[0][1], request(sub));
    const deadline = Date.now() + REPLY_MS;
    while (Date.now() < deadline) {
      for (const [path, dev] of ends) {
        const frame = await session.read(path, dev, READ_SLICE_MS);
        if (!frame.length) continue;
        const params = replyTo(frame, sub);
        if (params) return params;
      }
    }
    throw new Error('timeout waiting for register reply');
  };
}

async function expandReceivers(devices, { fresh = false, ask = realAsk } = {}) {
  for (const id of cache.keys()) {
    if (!devices.some((d) => d.id === id)) cache.delete(id);
  }
  const out = [];
  for (const device of devices) {
    if (!isTarget(device)) { out.push(device); continue; }
    if (fresh || !cache.has(device.id)) {
      const scan = await serialize(channelOf(device, 0x02).path, () => scanReceiver(ask(device))).catch(() => ({ answered: false }));
      if (scan.answered && scan.devices.length) cache.set(device.id, scan.devices);
      else if (scan.answered) cache.delete(device.id);
    }
    const found = cache.get(device.id);
    if (!found) { out.push(device); continue; }
    out.push({ ...device, expanded: true }, ...found.map((f) => childOf(device, f)));
  }
  return out;
}

function _reset() {
  cache.clear();
  locks.clear();
}

module.exports = {
  RECEIVER_PIDS, isTarget, parsePairing, parseName, childOf, serialize, scanReceiver, expandReceivers, request, replyTo, _reset,
};
