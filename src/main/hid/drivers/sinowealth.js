// Mice on the receiver chip with a 0xFFA0 collection next to 0xFFFF ones, which answer the battery
// in feature report 0. Two independent sources read it the same way:
//   - mxw (github.com/korkje/mxw, src/report/battery.rs), reverse engineered from Glorious Core v1
//     for the Glorious Model O, O-, D and D- Wireless (issue #45)
//   - LAMZU's own web driver (lamzu.net, getBatPer), for the LAMZU Maya X and others (issue #146)
//
//   send feature report 0: 00 | 00 02 02 00 83 00 ... (64 bytes after the report id)
//   get  feature report 0: 1 status, 4 = 02, 6 = 0x83 echoed, 7 = charging, 8 = percent
//   status: a1 ready, a4 asleep (mxw), anything else not ready yet
//
// MCHOSE's A5 2.4G (issue #115) has the same collections, but nothing documents it, so it's
// tried the same way and only claimed with that layout.
const session = require('../session');

const GLORIOUS = 0x258a;
const GLORIOUS_MODELS = [[0x2011, 0x2022], [0x2013, 0x2024], [0x2012, 0x2023], [0x2014, 0x2025]]; // [wired, wireless]
const LAYOUT_VENDORS = new Set([0x373e /* LAMZU */, 0x2023 /* MCHOSE A5 2.4G */]);
const LENGTH = 65;
const ANSWER_ATTEMPTS = 6;
const ANSWER_WAIT_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWired = (d) => d.vendorId === GLORIOUS && GLORIOUS_MODELS.some(([wired]) => wired === d.productId);
const isGlorious = (d) => d.vendorId === GLORIOUS && GLORIOUS_MODELS.some((pair) => pair.includes(d.productId));
const hasLayout = (d) => d.channels.some((c) => c.usagePage === 0xffa0) && d.channels.some((c) => c.usagePage === 0xffff);
// The 64-byte feature report lives on a 0xFFFF collection (mxw opens interface 2).
const channelsOf = (d) => d.channels.filter((c) => c.usagePage === 0xffff || (isGlorious(d) && c.interface === 2))
  .sort((a, b) => (b.interface === 2) - (a.interface === 2));

function matches(logicalDevice) {
  if (isGlorious(logicalDevice)) return channelsOf(logicalDevice).length > 0;
  return LAYOUT_VENDORS.has(logicalDevice.vendorId) && hasLayout(logicalDevice);
}

function request() {
  const r = new Array(LENGTH).fill(0);
  r[3] = 0x02;
  r[4] = 0x02;
  r[6] = 0x83;
  return r;
}

// A reading, { offline } for a sleeping mouse, or null when the answer isn't ready.
function parseReply(raw, wired) {
  if (raw.length < 9 || raw[6] !== 0x83) return null;
  if (raw[1] === 0xa4) return { offline: true };
  if (raw[1] !== 0xa1) return null;
  return { capacity: Math.min(100, Math.max(1, raw[8])), charging: raw[7] === 1 || (wired && raw[8] < 100) };
}

async function readFrom(channel, wired) {
  const dev = await session.acquire(channel.path);
  await session.sendFeatureReport(channel.path, dev, request());
  for (let i = 0; i < ANSWER_ATTEMPTS; i++) {
    await sleep(ANSWER_WAIT_MS);
    const reading = parseReply(await session.getFeatureReport(channel.path, dev, 0x00, LENGTH), wired);
    if (reading && reading.offline) throw new Error('mouse is off');
    if (reading) return reading;
  }
  throw new Error('timeout waiting for battery response');
}

async function readBattery(logicalDevice) {
  let lastError = new Error('no command channel');
  for (const channel of channelsOf(logicalDevice)) {
    try {
      return await readFrom(channel, isWired(logicalDevice));
    } catch (e) {
      lastError = e;
      if (/is off$/.test(e.message)) break;
    }
  }
  throw lastError;
}

module.exports = { id: 'sinowealth', matches, readBattery, request, parseReply };
