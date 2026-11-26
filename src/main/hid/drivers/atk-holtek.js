// ATK mouse receivers on the Holtek platform (issue #168, "ATK 8K Nano Dongle" 373b:1178), read
// the way ATK's own web driver (v3-hub.atkgear.com, the HOLTEK mouse controller) reads them. It
// lists three receivers on collection 0xFF10/0x0001: 1K dongle 0x10f0, 8K dongle 0x10f1 and
// 8K Nano dongle 0x1178.
//
//   feature report 0 (unnumbered), 8 bytes: 82 00 00 00 00 00 00 00    82 = get config data
//   input reply: 82 <rate> <dpi stage> <mode> <brightness> <speed> <color> <reserved>
//                <battery: level | 0x80 while charging> <link status>
const session = require('../session');

const ATK = 0x373b;
const PRODUCTS = new Set([0x10f0, 0x10f1, 0x1178]);
const GET_CONFIG = 0x82;
const REPLY_MS = 1500;
const READ_SLICE_MS = 100;

const channelOf = (d) => d.channels.find((c) => c.usagePage === 0xff10 && c.usage === 1);

function matches(logicalDevice) {
  return logicalDevice.vendorId === ATK && PRODUCTS.has(logicalDevice.productId) && !!channelOf(logicalDevice);
}

const REQUEST = [0x00, GET_CONFIG, 0, 0, 0, 0, 0, 0, 0]; // report id 0, then 8 bytes

// A reading, { offline } when the mouse isn't there, or null for any other frame.
function parseReply(f) {
  if (f.length < 9 || f[0] !== GET_CONFIG) return null;
  const level = f[8] & 0x7f;
  if (level === 0 || level > 100) return { offline: true };
  return { capacity: level, charging: f[8] >= 0x80 };
}

async function readBattery(logicalDevice) {
  const channel = channelOf(logicalDevice);
  if (!channel) throw new Error('no command channel');
  const dev = await session.acquire(channel.path);
  await session.readQueued(channel.path, dev);
  await session.sendFeatureReport(channel.path, dev, REQUEST);
  const deadline = Date.now() + REPLY_MS;
  while (Date.now() < deadline) {
    const reading = parseReply(await session.read(channel.path, dev, READ_SLICE_MS));
    if (reading && reading.offline) throw new Error('mouse is off');
    if (reading) return reading;
  }
  throw new Error('mouse is not answering');
}

module.exports = { id: 'atkHoltek', matches, readBattery, parseReply, REQUEST };
