// ATK mouse receivers on the "BitMouse" platform, NearLink and 2.4G (issues #60, #79, #93, #122).
// Read from ATK's own web driver (v3-hub.atkgear.com, the BITMOUSE controller), which lists these
// receivers on collection 0xFF05/0x0001:
//
//   output report 8, 63 bytes: <sum of bytes 1-62> 72 02 00 <target> <command> 01 00 ...
//     target 1 = the mouse behind the receiver; command 7 = battery level, 15 = charging state
//   input reply: the command is echoed at byte 5 (counting the report id), the value at byte 7
//
// ATK's Compx receivers share the vendor id but show 0xFF05 without a usage, and are left to the
// VXE driver.
const session = require('../session');

const ATK = 0x373b;
const PAGE = 0xff05;
const REPORT_ID = 0x08;
const LENGTH = 63;
const TARGET_MOUSE = 1;
const CMD_LEVEL = 7;
const CMD_CHARGING = 15;
const REPLY_MS = 800;
const READ_SLICE_MS = 50;

const channelOf = (d) => d.channels.find((c) => c.usagePage === PAGE && c.usage === 1);

function matches(logicalDevice) {
  return logicalDevice.vendorId === ATK && !!channelOf(logicalDevice);
}

function request(command) {
  const data = new Array(LENGTH).fill(0);
  data[1] = 0x72;
  data[2] = 0x02;
  data[4] = TARGET_MOUSE;
  data[5] = command;
  data[6] = 0x01;
  data[0] = data.slice(1).reduce((sum, b) => sum + b, 0) & 0xff;
  return [REPORT_ID, ...data];
}

// The value from a reply to this command, or null for any other frame.
function parseReply(frame, command) {
  if (frame.length < 8 || frame[5] !== command || frame[2] === 0xff) return null;
  return frame[7];
}

async function ask(channel, dev, command) {
  await session.readQueued(channel.path, dev);
  await session.write(channel.path, dev, request(command));
  const deadline = Date.now() + REPLY_MS;
  while (Date.now() < deadline) {
    const value = parseReply(await session.read(channel.path, dev, READ_SLICE_MS), command);
    if (value !== null) return value;
  }
  throw new Error('timeout waiting for battery response');
}

async function readBattery(logicalDevice) {
  const channel = channelOf(logicalDevice);
  if (!channel) throw new Error('no command channel');
  const dev = await session.acquire(channel.path);
  let level;
  try {
    level = await ask(channel, dev, CMD_LEVEL);
  } catch (e) {
    // The receiver stays quiet without its mouse.
    if (/^timeout/.test(e.message)) throw new Error('mouse is not answering');
    throw e;
  }
  if (level === 0 || level > 100) throw new Error('mouse is off');
  const charging = await ask(channel, dev, CMD_CHARGING).then((v) => v === 1, () => null);
  return { capacity: level, charging };
}

module.exports = { id: 'bitmouse', matches, readBattery, request, parseReply };
