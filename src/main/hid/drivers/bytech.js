// BY Tech mice (vendor 0x372E; PIAO 372e:1014 in issue #201, EWEADN S9 372e:1026 in issue #140), as
// OpenMouse-Project's "bytech" driver reads them (IPI Float 88, PIAO). Feature report 3, 64 bytes, on
// 0xFF00/0x0001; byte 1 is the sum of the payload after it:
//   03 22 50 00 02 4F 81 ...      basic info
//   03 .. .. .. 02 .. <level>     level 0-100, or 0xE4 when full
const session = require('../session');

const VENDOR = 0x372e;
const REQUEST = [0x03, 0x22, 0x50, 0x00, 0x02, 0x4f, 0x81].concat(new Array(57).fill(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const channelOf = (d) => d.channels.find((c) => c.usagePage === 0xff00 && c.usage === 0x01);

function matches(d) {
  return d.vendorId === VENDOR && !!channelOf(d) && d.channels.some((c) => c.usagePage === 0xff06);
}

function parseReply(f) {
  if (f.length < 7 || f[0] !== 0x03 || f[4] !== 0x02) return null;
  if (f[6] === 0xe4) return { capacity: 100 };
  if (f[6] < 1 || f[6] > 100) return null;
  return { capacity: f[6] };
}

async function readBattery(d) {
  const channel = channelOf(d);
  if (!channel) throw new Error('no command channel');
  const dev = await session.acquire(channel.path);
  await session.sendFeatureReport(channel.path, dev, REQUEST);
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(40);
    const reading = parseReply(await session.getFeatureReport(channel.path, dev, 3, 64));
    if (reading) return reading;
  }
  throw new Error('mouse is not answering');
}

module.exports = { id: 'bytech', matches, readBattery, parseReply, REQUEST };
