// Compx's shared 2.4G receiver 3554:fa09, used by several keyboards: AULA F87 Pro and F99 Pro,
// Lingbao K98 and MCHOSE G75. They share the collection 0xFF02/0x0002 with 20-byte report 0x13,
// and each answers the battery in one of two ways. Sources: dongfangshu/AulaF87ProBattery
// (docs/PROTOCOL.md) and evren-oct/vigil-watt (docs/hardware/aula.md, lingbao.md, mchose.md),
// both checked on real keyboards. Not tested here: nobody on this project has one.
//
//   every frame: 13 <command> <argument> ... <sum of bytes 0-18, low 8 bits>
//   open session 13 05 01   -> ack 13 05 01 00 0A 03 ...       (the receiver answers this)
//   battery push             13 0A 01 00 04 05 <percent> <flags> (K98, F99 Pro, after the session)
//   battery query 13 4A 00 / 13 4A 01 -> 13 4A 01 00 02 <percent> <state> (F87 Pro / G75)
//   flags and state: 0x10 set while on external power
//
// The AULA project found a plain write got no answer on battery power, and sends with
// HidD_SetOutputReport instead, so that is tried when a plain write gets nothing.
const { execFile } = require('child_process');
const path = require('path');
const session = require('../session');

const VENDOR = 0x3554;
const PRODUCT = 0xfa09;
const USAGE_PAGE = 0xff02;
const LENGTH = 20;
const PLAIN_MS = 1500;
const CONTROL_MS = 2000;
const REPOKE_MS = 500;
const READ_SLICE_MS = 100;
const SCRIPT = path.join(__dirname, '..', 'output-report.ps1');
const SCRIPT_TIMEOUT_MS = 6000;

function frame(command, argument) {
  const f = new Array(LENGTH).fill(0);
  f[0] = 0x13;
  f[1] = command;
  f[2] = argument;
  f[LENGTH - 1] = f.reduce((sum, b) => sum + b, 0) & 0xff;
  return f;
}
const SESSION = frame(0x05, 0x01);
const QUERIES = [frame(0x4a, 0x01), frame(0x4a, 0x00)];
const REQUESTS = [SESSION, ...QUERIES];

const channelOf = (logicalDevice) => logicalDevice.channels.find((c) => c.usagePage === USAGE_PAGE && (c.usage === undefined || c.usage === 2));

// MCHOSE's K87 (41e4:2001) and G98 Pro (41e4:2004) receivers send the same 13 4A frames (HaloBattery
// mchose_kb.py from MCHOSE's M HUB, #378 on hardware: 94 % on battery, 50 % charging on the cable).
const MCHOSE_KB = 0x41e4;
const MCHOSE_KB_PRODUCTS = new Set([0x2001, 0x2004]);
// VGN's "beiying" keyboard dongles, in its web driver with the same report 0x13 and 4A query: N75 V2
// 391d:2a01, V108 391d:2a02, V87 V2 258a:027b, V98pro V3 258a:024f / 027f. Only these ids: 258a is
// SinoWealth's, and other keyboards under it take flash writes on their command channel.
const VGN_KB = new Set(['391d:2a01', '391d:2a02', '258a:027b', '258a:024f', '258a:027f']);

function matches(logicalDevice) {
  const { vendorId, productId } = logicalDevice;
  const id = `${(vendorId || 0).toString(16).padStart(4, '0')}:${(productId || 0).toString(16).padStart(4, '0')}`;
  const known = (vendorId === VENDOR && productId === PRODUCT) || (vendorId === MCHOSE_KB && MCHOSE_KB_PRODUCTS.has(productId)) || VGN_KB.has(id);
  return known && !!channelOf(logicalDevice);
}

// A battery reading, { ack: true } for the receiver's session answer, or null for anything else.
function parseFrame(f) {
  if (f.length < LENGTH || f[0] !== 0x13) return null;
  let sum = 0;
  for (let i = 0; i < LENGTH - 1; i++) sum += f[i];
  if ((sum & 0xff) !== f[LENGTH - 1]) return null;
  let level = null;
  let flags = 0;
  if ((f[1] & 0x7f) === 0x4a && f[2] === 0x01 && f[3] === 0x00 && f[4] === 0x02) [level, flags] = [f[5], f[6]];
  else if (f[1] === 0x0a && f[2] === 0x01 && f[4] === 0x04 && f[5] === 0x05) [level, flags] = [f[6], f[7]];
  else if (f[1] === 0x05 && f[2] === 0x01 && f[4] === 0x0a) return { ack: true };
  if (level === null || level < 1 || level > 100) return null;
  return { capacity: level, charging: !!(flags & 0x10) };
}

function sendControl(channelPath) {
  const hex = REQUESTS.map((r) => r.map((b) => b.toString(16).padStart(2, '0')).join(''));
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, channelPath, hex.join(',')],
      { windowsHide: true, timeout: SCRIPT_TIMEOUT_MS }, (err) => (err ? reject(new Error('could not send to device')) : resolve()));
  });
}

// fa09 receivers that turned out to carry a mouse go straight to the mouse read: the keyboard session
// before it costs a PowerShell start and up to 13 s, past hid-client's 12 s limit.
const mouseReceivers = new Set();

async function readBattery(logicalDevice) {
  const channel = channelOf(logicalDevice);
  if (!channel) throw new Error('no command channel');
  if (mouseReceivers.has(channel.path)) {
    try {
      return await require('./kysona').readMouse(logicalDevice);
    } catch (e) {
      if (!/ is off$/.test(e.message)) mouseReceivers.delete(channel.path); // ask the keyboard way again next time
      throw e;
    }
  }
  const dev = await session.acquire(channel.path);
  await session.readQueued(channel.path, dev); // a late reply to an old request is stale

  let answered = false; // the receiver acknowledged the session, so it is there
  let writeError = null;
  const listen = async (more, poke) => {
    let nextPoke = 0;
    while (more()) {
      if (poke && Date.now() >= nextPoke) {
        for (const request of REQUESTS) {
          try { await dev.write(request); } catch (e) { writeError = e; }
        }
        nextPoke = Date.now() + REPOKE_MS;
      }
      const parsed = parseFrame(await session.read(channel.path, dev, READ_SLICE_MS));
      if (parsed && parsed.ack) answered = true;
      else if (parsed) return parsed;
    }
    return null;
  };

  const plainUntil = Date.now() + PLAIN_MS;
  const plain = await listen(() => Date.now() < plainUntil, true);
  if (plain) return plain;

  // The same requests as control transfers, read back on this handle while they go out. The
  // helper takes a moment to start, so the wait runs from when it has sent them.
  let controlError = null;
  let sentAt = null;
  const giveUpAt = Date.now() + SCRIPT_TIMEOUT_MS + CONTROL_MS;
  const sent = sendControl(channel.path).catch((e) => { controlError = e; }).then(() => { sentAt = Date.now(); });
  const control = await listen(() => Date.now() < giveUpAt && (sentAt === null || Date.now() < sentAt + CONTROL_MS), false);
  await sent;
  if (control) return control;
  if (answered) throw new Error('keyboard is not answering');
  // No session answer at all: 3554:fa09 also carries mice (issues #244, #190, #82, #116), which speak
  // the VXE mouse frame instead. Required here, not at the top, as kysona.js requires this file.
  if (logicalDevice.vendorId === VENDOR) {
    const reading = await require('./kysona').readMouse(logicalDevice);
    mouseReceivers.add(channel.path);
    return reading;
  }
  throw writeError || controlError || new Error('timeout waiting for battery response');
}

module.exports = { id: 'compx', matches, readBattery, parseFrame, frame };
