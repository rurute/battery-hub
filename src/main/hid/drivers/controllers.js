// Game controllers whose battery SDL (libsdl-org/SDL, src/joystick/hidapi) and Linux read over HID.
// None of these switches a controller's mode: either the battery is already in the reports it sends,
// or a read-only info request asks for it.
//
//   Flydigi Vader 4/5 Pro, Apex 4/5/6 (issues #25, #125)  SDL_hidapi_flydigi.c, padctl vader5.toml
//   8BitDo Ultimate 2 Wireless / BT, Ultimate 3             SDL_hidapi_8bitdo.c (powerstate block)
//   Steam Controller (2015 receiver)                        Linux hid-steam.c steam_do_battery_event
//   Steam Controller (2026)                                 SDL_hidapi_steam_triton.c, hid-steam.c ibex
//   NVIDIA SHIELD controller                                SDL_hidapi_shield.c
//   Amazon Luna over Bluetooth                              SDL_hidapi_luna.c
//   SInput pads (Hand Held Legend ProGCC and others)        SDL_hidapi_sinput.c
const session = require('../session');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (d, page, usage) => d.channels.find((c) => c.usagePage === page && (usage === undefined || c.usage === usage));

// Reads frames for up to ms, asking with request (if any) every repoke ms, until parse accepts one.
async function listen(channel, parse, { ms = 2000, request = null, repoke = 700 } = {}) {
  const dev = await session.acquire(channel.path);
  const queued = (await session.readQueued(channel.path, dev)).map(parse).filter(Boolean);
  if (queued.length && !request) return queued[queued.length - 1];
  const deadline = Date.now() + ms;
  let next = 0;
  while (Date.now() < deadline) {
    if (request && Date.now() >= next) {
      for (const r of [].concat(typeof request === 'function' ? request() : [request])) await session.write(channel.path, dev, r);
      next = Date.now() + repoke;
    }
    const reading = parse(await session.read(channel.path, dev, 100));
    if (reading) return reading;
  }
  return null;
}

// ---- Flydigi: GET_INFO (5a a5 01 02 03) on 0xFFA0/0x0001. Never ACQUIRE or SET_STATUS: those take
// the pad from Flydigi's Space Station. Reply r[11]: high nibble 0 battery, 1 charging, 2 full;
// low nibble the level, x10 on the Apex 6, x20 on the others.
const FLYDIGI = 0x37d7;
const FLYDIGI_PIDS = new Set([0x2401, 0x2501, 0x2502]);
function flydigiRequest(productId) {
  const id = productId === 0x2501 ? 0x03 : 0x00; // the Apex 4/5 numbers its reports
  return [[id, 0x5a, 0xa5, 0x01, 0x02, 0x03], [id, 0x5a, 0xa5, 0x01, 0x02, 0x00]]; // padctl's form, then SDL's
}
function parseFlydigi(f, productId) {
  const r = f[1] === 0x5a && f[2] === 0xa5 ? f.slice(1) : f;
  if (r.length < 12 || r[0] !== 0x5a || r[1] !== 0xa5 || r[2] !== 0x01) return null;
  const status = r[11] >> 4;
  if (status > 2) return null;
  if (status === 2) return { capacity: 100, charging: false };
  const level = (r[11] & 0x0f) * (productId === 0x2502 ? 10 : 20);
  return level >= 1 && level <= 100 ? { capacity: level, charging: status === 1 } : null;
}

// ---- 8BitDo in D-input mode: f[14] bit 7 charging, bits 0-6 percent, on firmware that sends 34-byte
// reports. The Pro 2/3 and SN30/SF30 Pro need a mode switch first, so they're left out.
const EIGHTBITDO = 0x2dc8;
const EIGHTBITDO_PIDS = new Set([0x6012, 0x6011, 0x202f]);
function parse8BitDo(f) {
  if (f.length < 15 || ![0x01, 0x03, 0x04].includes(f[0])) return null;
  const level = f[14] & 0x7f;
  if (level < 1 || level > 100) return null;
  return { capacity: level, charging: level < 100 && !!(f[14] & 0x80) };
}

// ---- Steam Controller (2015) on its receiver: status message 01 00 04 .. with the percent at f[14];
// 01 00 03 .. 01 means the controller went away.
function parseSteam2015(f) {
  if (f.length < 15 || f[0] !== 0x01 || f[1] !== 0x00) return null;
  if (f[2] === 0x03 && f[4] === 0x01) return { offline: true };
  if (f[2] !== 0x04 || f[14] < 1 || f[14] > 100) return null;
  return { capacity: f[14] };
}

// ---- Steam Controller (2026): input report 0x43, f[1] 1 discharging / 2 charging / 4 done, f[2] percent.
function parseSteam2026(f) {
  if (f.length < 3 || f[0] !== 0x43 || f[2] < 1 || f[2] > 100) return null;
  if (![1, 2, 4].includes(f[1])) return null;
  return { capacity: f[2], charging: f[1] === 2 };
}

// ---- NVIDIA SHIELD: output report 4, command 7 (battery); the answer is report 3, level 0-5 at f[5].
let shieldSeq = 0;
const shieldRequest = () => [0x04, 0x07, (shieldSeq = (shieldSeq + 1) & 0xff)];
function parseShield(f) {
  if (f.length < 6 || f[0] !== 0x03 || f[1] !== 0x07 || f[5] > 5) return null;
  return { capacity: f[5] * 20 }; // SDL maps level 0 to 0 %
}

// ---- Amazon Luna over Bluetooth: report 4, f[1] 0-255.
function parseLuna(f) {
  if (f.length < 2 || f[0] !== 0x04 || f[1] === 0) return null;
  return { capacity: Math.round((f[1] / 255) * 100) };
}

// ---- SInput: report 1, f[1] plug state (2 charging, 3 charged, 4 on battery), f[2] percent.
// Status 3 is "charged", which SDL shows as 100 whatever byte 2 says.
function parseSInput(f) {
  if (f.length < 3 || f[0] !== 0x01 || ![2, 3, 4].includes(f[1])) return null;
  if (f[1] === 3) return { capacity: 100, charging: false };
  if (f[2] < 1 || f[2] > 100) return null;
  return { capacity: f[2], charging: f[1] === 2 };
}
const SINPUT = new Set(['2e8a:10c6', '2e8a:10df', '2e8a:10dd', '2e8a:10e0', '2e8a:10e5', '38d2:1014']);

const key = (d) => `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;

// Which controller this is, and how to read it: { channel, read(channel) } or null.
function plan(d) {
  const pad = has(d, 0x01, 0x05) || has(d, 0x01, 0x04);
  if (d.vendorId === FLYDIGI && FLYDIGI_PIDS.has(d.productId)) {
    const channel = has(d, 0xffa0, 0x01);
    let turn = 0;
    const requests = flydigiRequest(d.productId);
    return channel && { channel, read: (c) => listen(c, (f) => parseFlydigi(f, d.productId), { ms: 1500, request: () => [requests[turn++ % 2]], repoke: 500 }) };
  }
  if (d.vendorId === EIGHTBITDO && EIGHTBITDO_PIDS.has(d.productId)) return pad && { channel: pad, read: (c) => listen(c, parse8BitDo, { ms: 1500 }) };
  if (d.vendorId === 0x28de && d.productId === 0x1142) {
    const channel = has(d, 0xff00);
    return channel && { channel, read: (c) => listen(c, parseSteam2015, { ms: 3000 }) };
  }
  if (d.vendorId === 0x28de && d.productId >= 0x1302 && d.productId <= 0x1305) {
    const channel = d.channels.find((c) => c.usagePage >= 0xff00) || pad;
    return channel && { channel, read: (c) => listen(c, parseSteam2026, { ms: 3000 }) };
  }
  if (d.vendorId === 0x0955 && (d.productId === 0x7210 || d.productId === 0x7214)) {
    const channel = pad || d.channels[0];
    return channel && { channel, read: (c) => listen(c, parseShield, { ms: 1500, request: shieldRequest }) };
  }
  if (d.vendorId === 0x0171 && d.productId === 0x0419) return pad && { channel: pad, read: (c) => listen(c, parseLuna, { ms: 2000 }) };
  if (SINPUT.has(key(d))) return pad && { channel: pad, read: (c) => listen(c, parseSInput, { ms: 1500 }) };
  return null;
}

function matches(d) {
  return !!plan(d);
}

async function readBattery(d) {
  const p = plan(d);
  if (!p) throw new Error('no controller channel');
  const reading = await p.read(p.channel);
  if (!reading) throw new Error('controller is not answering');
  if (reading.offline) throw new Error('controller is off');
  return reading;
}

module.exports = { id: 'controllers', matches, readBattery, parseFlydigi, parse8BitDo, parseSteam2015, parseSteam2026, parseShield, parseLuna, parseSInput, flydigiRequest, sleep };
