// MCHOSE mice on RealTek receivers: A7 V2 Ultra, A5 Ultra, K7 Ultra, A7 Ultra (issues #54, #68,
// #77, #80, #130, #142, #161). Read from MCHOSE's own web driver (M HUB, mchose.com.cn), which
// picks these by their 0xFF01 or 0xFF0B collection and talks to them in feature reports whose
// bytes after the report id are all inverted (xor 0xff):
//
//   request  report 0x11: 06 00 ... (20 bytes)               "read device" (11 06)
//   reply    report 0x11: <~06> then, inverted: vid(2) pid(2) firmware(4) mode/link, battery, charge
//
// So after the report id and the echoed command, byte 9 of the inverted data is the level and
// byte 10 the charge state (1 charging, 2 full). A level of 0 is the receiver answering without
// its mouse, which M HUB shows as "disconnected".
const session = require('../session');

const MCHOSE = 0x3837;
const MCHOSE_ALT = 0x5253; // the A7 Ultra's other vendor id, which M HUB matches on its own
// Product ids M HUB lists with these collections next to the reported ones.
const PRODUCT_IDS = new Set([0x1001, 0x4150, 0x4022, 0x100b, 0x100c]);
const PAGES = [0xff01, 0xff0b];
const REPORT_ID = 0x11;
const READ_DEVICE = 0x06;
const DATA_LENGTH = 20;
const ANSWER_ATTEMPTS = 6;
const ANSWER_WAIT_MS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const channelsOf = (logicalDevice) => logicalDevice.channels.filter((c) => PAGES.includes(c.usagePage));

function matches(logicalDevice) {
  const known = (logicalDevice.vendorId === MCHOSE && PRODUCT_IDS.has(logicalDevice.productId)) || logicalDevice.vendorId === MCHOSE_ALT;
  return known && channelsOf(logicalDevice).length > 0;
}

function request() {
  const data = new Array(DATA_LENGTH).fill(0);
  data[0] = READ_DEVICE;
  return [REPORT_ID, ...data.map((b) => b ^ 0xff)];
}

// A reading from the raw feature report (report id first), null if it isn't the answer to 11 06.
function parseReply(raw) {
  if (raw.length < 13 || raw[0] !== REPORT_ID || (raw[1] ^ 0xff) !== READ_DEVICE) return null;
  const data = raw.slice(2).map((b) => b ^ 0xff);
  const level = data[9];
  if (level === 0) return { offline: true };
  if (level > 100) return null;
  return { capacity: level, charging: data[10] === 1 };
}

async function readFrom(channel) {
  const dev = await session.acquire(channel.path);
  await session.sendFeatureReport(channel.path, dev, request());
  for (let i = 0; i < ANSWER_ATTEMPTS; i++) {
    await sleep(ANSWER_WAIT_MS);
    const reading = parseReply(await session.getFeatureReport(channel.path, dev, REPORT_ID, DATA_LENGTH + 1));
    if (reading && reading.offline) throw new Error('mouse is off');
    if (reading) return reading;
  }
  throw new Error('timeout waiting for battery response');
}

async function readBattery(logicalDevice) {
  let lastError = new Error('no command channel');
  for (const channel of channelsOf(logicalDevice)) {
    try {
      return await readFrom(channel);
    } catch (e) {
      lastError = e;
      if (/is off$/.test(e.message)) break; // the receiver answered: no other collection will do better
    }
  }
  throw lastError;
}

module.exports = { id: 'mchose-mouse', matches, readBattery, request, parseReply };
