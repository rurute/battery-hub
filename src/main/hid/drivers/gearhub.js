// YICHIP/MicLink receivers (vendor 0x3151) with the 0xFFFF/0x0001 + 0xFFFF/0x0002 collections, as
// OpenMouse-Project's "GearHub-V5" driver reads them (measured on receiver 3151:402D; AJAZZ AJ179 PRO,
// Lingbao M5 Pro, Attack Shark R2). The receiver keeps both batteries, its keyboard's and its mouse's:
//   send feature 00 F7 (65 bytes) on 0xFFFF/0x0002, then get feature report 0:
//   00 <ready> <keyboard %> <mouse %> <keyboard link> <mouse link>   link 0 = connected
// Issues #110, #156 (mice), #147, #205 (keyboards), #231 (AJ159 APEX, 3151:4026).
const session = require('../session');

const VENDOR = 0x3151;
const REQUEST = [0x00, 0xf7].concat(new Array(63).fill(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const channelOf = (d) => d.channels.find((c) => c.usagePage === 0xffff && c.usage === 0x02);
const hasLayout = (d) => d.channels.some((c) => c.usagePage === 0xffff && c.usage === 0x01) && !!channelOf(d);

function matches(d) {
  return d.vendorId === VENDOR && hasLayout(d);
}

// 'mouse' or 'keyboard': which battery of the two this device is.
function parseReply(f, kind) {
  if (f.length < 6 || f.slice(1, 6).every((b) => b === 0)) return null;
  const [level, link] = kind === 'keyboard' ? [f[2], f[4]] : [f[3], f[5]];
  if (link !== 0) return { offline: true };
  if (level < 1 || level > 100) return null;
  return { capacity: level };
}

const kindOf = (d) => (/keyboard|kb\b/i.test(`${d.product || ''}`) ? 'keyboard' : 'mouse');

async function readBattery(d) {
  const channel = channelOf(d);
  if (!channel) throw new Error('no command channel');
  const dev = await session.acquire(channel.path);
  for (let attempt = 0; attempt < 5; attempt++) {
    await session.sendFeatureReport(channel.path, dev, REQUEST);
    await sleep(15);
    const reading = parseReply(await session.getFeatureReport(channel.path, dev, 0, 65), kindOf(d));
    if (reading && reading.offline) throw new Error('mouse is off');
    if (reading) return reading;
    await sleep(40);
  }
  throw new Error('receiver is not answering');
}

module.exports = { id: 'gearhub', matches, readBattery, parseReply, REQUEST };
