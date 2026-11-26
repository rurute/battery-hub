// Battery protocol for VXE / Kysona-family wireless mice (shared OEM firmware).
// Reverse-engineered from Linux's in-tree driver: drivers/hid/hid-kysona.c
// Request: report 0x08, subcommand 0x04 (BATTERY_REPORT_ID), fixed trailing checksum 0x49.
// Response arrives async on the same 0xFF02 collection:
//   byte[6]  = capacity percent (0-100)
//   byte[7]  = charging flag (0/1)
//   byte[8-9] = voltage in mV, big-endian
//
// Linux now runs this family in drivers/hid/hid-pulsar.c, which also asks the receiver whether it
// has the mouse at all (CMD_STATUS): subcommand 0x03, checksum 0x4a. byte[6] of the answer is 1
// while the mouse is connected and 0 when it isn't. A switched-off mouse never answers the battery
// request, so without this it could only look asleep. Checked on a VXE R1 Pro: 0 within a second of
// switching it off, 1 again on switching it on.
const { findChannel } = require('../catalog');
const session = require('../session');
const compx = require('./compx');

const USAGE_PAGE_COMMAND = 0xFF02;
const BATTERY_REQUEST = [0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x49];
const STATUS_REQUEST = [0x08, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x4a];
const FRAME_LENGTH = 17;
const OFF_ANSWERS = 2; // "not connected" this many times in a row; one can catch the switch moving
const RESPONSE_TIMEOUT_MS = 4000;
const REPOKE_MS = 500; // this firmware often ignores a single request; poke until it answers
const READ_SLICE_MS = 100;

const KNOWN_VENDOR_IDS = new Set([0x3554]); // VXE
// Other brands on the same Compx receiver chip: ATK/MADLIONS (0x373B, which Linux's hid-pulsar
// lists for the VXE R1 SE dongle 373b:1085), and receivers that call themselves Compx under
// 0x25A7 and 0x260D. They're only claimed with the chip's own layout, the command collection
// 0xFF02/0x0002 next to 0xFF04/0x0002: the same name sits on other chips (NearLink, 0xFFB1).
const COMPX_CHIP_VENDOR_IDS = new Set([0x373b, 0x25a7, 0x260d]);
const hasCollection = (logicalDevice, usagePage, usage) => logicalDevice.channels.some((c) => c.usagePage === usagePage && c.usage === usage);
const hasCompxLayout = (logicalDevice) => hasCollection(logicalDevice, 0xff02, 0x0002) && hasCollection(logicalDevice, 0xff04, 0x0002);

function matches(logicalDevice) {
  if (compx.matches(logicalDevice)) return false;
  if (KNOWN_VENDOR_IDS.has(logicalDevice.vendorId)) return !!findChannel(logicalDevice, USAGE_PAGE_COMMAND);
  return COMPX_CHIP_VENDOR_IDS.has(logicalDevice.vendorId) && hasCompxLayout(logicalDevice);
}

// Turn one raw frame into a reading, or null if it isn't a usable battery frame.
function parseFrame(arr) {
  if (arr[0] !== 0x08 || arr[1] !== 0x04) return null;
  const capacity = arr[6];
  // firmware sends a zeroed "not ready yet" frame sometimes; keep waiting for a real one
  if (!(capacity > 0 && capacity <= 100)) return null;
  return { capacity, charging: !!arr[7], voltageMv: (arr[8] << 8) | arr[9] };
}

// The receiver's answer to the status request: true while it has the mouse, false when it
// doesn't, null for any other frame. The checksum is checked as Linux does.
function parseStatus(arr) {
  if (arr.length < FRAME_LENGTH || arr[0] !== 0x08 || arr[1] !== 0x03 || arr[6] > 1) return null;
  let sum = 0;
  for (let i = 0; i < FRAME_LENGTH - 1; i++) sum += arr[i];
  if (((0x55 - sum) & 0xff) !== arr[FRAME_LENGTH - 1]) return null;
  return arr[6] === 1;
}

// The command collection first, then the other vendor collections, in case a receiver in this
// family refuses the request on 0xFF02. (The Compx keyboard receiver that first showed this turned out
// to speak another protocol, which has its own driver now.)
function commandChannels(logicalDevice) {
  const main = findChannel(logicalDevice, USAGE_PAGE_COMMAND);
  const others = logicalDevice.channels.filter((c) => c !== main && c.usagePage >= 0xff00);
  return main ? [main, ...others] : [];
}

async function readBattery(logicalDevice) {
  // Cards added before the Compx keyboard receiver had its own driver are saved under this one.
  if (compx.matches(logicalDevice)) return compx.readBattery(logicalDevice);
  const channels = commandChannels(logicalDevice);
  if (!channels.length) throw new Error('no command channel');
  // A channel that refuses the request, or has no input report and doesn't answer through feature
  // reports either, passes to the next one. If none answers, the error names what each one said, so
  // a device report shows where it failed.
  const failures = [];
  for (const channel of channels) {
    try {
      return await readFrom(channel);
    } catch (e) {
      if (!/cannot write|could not read/i.test(e.message)) throw e;
      failures.push({ channel, error: e });
    }
  }
  if (failures.length === 1) throw failures[0].error;
  const name = (c) => `${c.usagePage.toString(16)}:${c.usage === undefined ? '----' : c.usage.toString(16).padStart(4, '0')}`;
  throw new Error(failures.map((f) => `${name(f.channel)} ${f.error.message}`).join('; '));
}

// Some receivers in this family, such as 25a7:fa07 (Redragon M901P-KS, issue #92) and 25a7:fa7c
// (AJAZZ AJ199, issue #196), have report 8 only as a 17-byte feature report, so the command
// collection has no input report and every read fails. Those are asked with SetFeature and
// answered with GetFeature. A path is remembered as feature-only once a read fails there and
// forgotten again if the feature way fails too.
const featureOnly = new Set();
const FEATURE_WAIT_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sameBytes = (a, b) => a.length >= b.length && b.every((x, i) => a[i] === x);

async function readFrom(channel) {
  if (featureOnly.has(channel.path)) return readByFeature(channel);
  try {
    return await readByInput(channel);
  } catch (e) {
    if (!/could not read/i.test(e.message)) throw e;
    featureOnly.add(channel.path);
    try {
      return await readByFeature(channel);
    } catch (featureError) {
      if (featureError.message === 'mouse is off') throw featureError;
      // Not a feature-only receiver either: report what went wrong both ways.
      throw new Error(`${e.message} (feature reports: ${featureError.message})`);
    }
  }
}

// The answer can take a moment, so it is read a few times before the request is sent again.
const FEATURE_READS = 4;
async function askByFeature(channel, dev, request) {
  await session.sendFeatureReport(channel.path, dev, request);
  for (let i = 0; i < FEATURE_READS; i++) {
    await sleep(FEATURE_WAIT_MS);
    const answer = await session.getFeatureReport(channel.path, dev, request[0], FRAME_LENGTH);
    if (!sameBytes(answer, request)) return answer; // our own request read back is no answer
  }
  return [];
}

async function readByFeature(channel) {
  try {
    const dev = await session.acquire(channel.path);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let offInARow = 0;
    while (Date.now() < deadline) {
      const status = parseStatus(await askByFeature(channel, dev, STATUS_REQUEST));
      if (status === false) {
        if (++offInARow >= OFF_ANSWERS) throw new Error('mouse is off');
      } else {
        offInARow = 0;
        const reading = parseFrame(await askByFeature(channel, dev, BATTERY_REQUEST));
        if (reading) return reading;
      }
      await sleep(REPOKE_MS);
    }
    throw new Error('timeout waiting for battery response');
  } catch (e) {
    if (e.message !== 'mouse is off') featureOnly.delete(channel.path);
    throw e;
  }
}

async function readByInput(channel) {
  const dev = await session.acquire(channel.path);
  await session.readQueued(channel.path, dev); // a late reply to an old request is stale

  // Ask whether the receiver has the mouse, and for the battery only while it says yes. A battery
  // request makes the receiver try to reach the mouse, and while it tries, its status answer can say
  // "connected" for a mouse that is asleep or off (seen on a VXE R1 Pro), so the status question goes
  // on until the battery answers. A receiver that never answers it gets the battery request anyway.
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  let nextPoke = 0;
  let pokes = 0;
  let connected = null; // the latest status answer
  let offInARow = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextPoke) {
      await dev.write(STATUS_REQUEST);
      if (connected || (connected === null && pokes > 0)) await dev.write(BATTERY_REQUEST);
      pokes += 1;
      nextPoke = Date.now() + REPOKE_MS;
    }
    const frame = await session.read(channel.path, dev, READ_SLICE_MS);
    const reading = parseFrame(frame);
    if (reading) return reading;
    const status = parseStatus(frame);
    if (status === true) {
      if (!connected) nextPoke = 0; // ask for the battery straight away
      connected = true;
      offInARow = 0;
    } else if (status === false) {
      connected = false;
      if (++offInARow >= OFF_ANSWERS) throw new Error('mouse is off');
    }
  }
  throw new Error('timeout waiting for battery response');
}

// The mouse reappears under another product id while charging over its cable.
module.exports = { id: 'kysona', hasWiredIdentity: true, matches, parseFrame, parseStatus, readBattery };
