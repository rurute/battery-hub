// Nintendo Switch Pro Controllers and the many clones that copy them (057e:2009; issue #232: YUYIU),
// plus Joy-Cons, over Bluetooth. Sources: dekuNukem/Nintendo_Switch_Reverse_Engineering
// (bluetooth_hid_notes.md, bluetooth_hid_subcommands_notes.md) and Linux's hid-nintendo.c
// (joycon_parse_battery_status).
//
// In its default mode the controller sends simple report 0x3F, which has no battery. Every answer
// to a subcommand (report 0x21) and every full report (0x30) does, in byte 2: bits 7-5 are the
// level, 0 (critical) to 4 (full), and bit 4 is set while charging. So the controller is asked for
// its device info (subcommand 0x02), which changes nothing on it, through output report 0x01:
//
//   01 <counter> 00 01 40 40 00 01 40 40 02     (the 8 bytes after the counter are "no rumble")
//
// Only five steps, so the level reads 100, 75, 50, 25 or 10.
const { exchange, pad } = require('./exchange');

const VENDOR = 0x057e;
const PRODUCTS = new Set([0x2009, 0x2006, 0x2007]); // Pro Controller, Joy-Con (L), Joy-Con (R)
const LEVELS = [10, 25, 50, 75, 100];
const DEVICE_INFO = 0x02;
// Only the bytes that matter: hidapi pads a short write to the report's real length, while a write
// longer than it fails, and clones don't all declare the same length.
const LENGTH = 11;

const channelOf = (d) => d.channels.find((c) => c.usagePage === 0x01 && (c.usage === 0x05 || c.usage === 0x04));

function matches(logicalDevice) {
  return logicalDevice.vendorId === VENDOR && PRODUCTS.has(logicalDevice.productId) && !!channelOf(logicalDevice);
}

let counter = 0;
function request() {
  counter = (counter + 1) & 0x0f;
  return pad([0x01, counter, 0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40, DEVICE_INFO], LENGTH);
}

// A reading from report 0x21 or 0x30, or null for any other report.
function parseReport(f) {
  if (f.length < 3 || (f[0] !== 0x21 && f[0] !== 0x30)) return null;
  const level = f[2] >> 5;
  if (level > 4) return null;
  return { capacity: LEVELS[level], charging: !!(f[2] & 0x10) };
}

async function readBattery(logicalDevice) {
  const channel = channelOf(logicalDevice);
  if (!channel) throw new Error('no gamepad channel');
  try {
    return await exchange(channel, request(), parseReport, 2000);
  } catch (e) {
    if (/^timeout/.test(e.message)) throw new Error('controller is not answering');
    throw e;
  }
}

module.exports = { id: 'nintendo', matches, readBattery, parseReport, request };
