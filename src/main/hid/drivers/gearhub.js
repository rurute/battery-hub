// YICHIP/MicLink receivers (vendor 0x3151) with the 0xFFFF/0x0001 + 0xFFFF/0x0002 collections, as
// OpenMouse-Project's "GearHub-V5" driver reads them (measured on receiver 3151:402D; AJAZZ AJ179 PRO,
// Lingbao M5 Pro, Attack Shark R2). The receiver keeps both batteries, its keyboard's and its mouse's:
//   send feature 00 F7 (65 bytes) on 0xFFFF/0x0002, then get feature report 0:
//   00 <ready> <keyboard %> <mouse %> <keyboard link> <mouse link>   link 0 = connected
// Issues #110, #156 (mice), #147, #205 (keyboards), #231 (AJ159 APEX, 3151:4026).
const session = require('../session');

const VENDOR = 0x3151;
// 0x08 after F7 is the checksum newer firmware wants (0xFF - 0xF7; MonsGeek's driver and sharkfin, needed
// on the Attack Shark X820 Ultra receiver 3151:5006, HaloBattery #372); older firmware ignores it.
const REQUEST = [0x00, 0xf7, 0, 0, 0, 0, 0, 0, 0x08].concat(new Array(56).fill(0));
// Rongyuan dongles under other vendor ids, from MonsGeek's web app list (polled there with the same F7,
// on 0xFFFF/0x0002; they may not show 0xFFFF/0x0001): MSI, Trust, VGN receivers and keyboard dongles,
// and others. Vendor driver lists, not hardware-confirmed here.
const OTHER_DONGLES = new Set([
  '0db0:197e', '0db0:8e9a', '145f:0376', '145f:038d', '25aa:2008', '25aa:4008', '25aa:4018',
  '342d:e3e0', '342d:e3e1', '342d:e3e2', '342d:e3e6', '342d:e3e7', '342d:e3e8', '342d:e3f5', '342d:e3f6', '342d:e3f7', '342d:e3fb', '342d:e3fc', '342d:e3fd',
  '347a:a302', '347a:a305', '379a:1804', '379a:1807', '38a9:0002',
  '374a:a205', '374a:a217', '374a:a220', '374a:a223', '374a:a226', '374a:a229', '374a:a234', '374a:a237', '374a:a251', '374a:a263', '374a:a268', '374a:a311', '374a:a314', '374a:a319', '374a:a322', '374a:a329',
  '391d:1a04', '391d:1a08', '391d:1a0e', '391d:1a13', '391d:1a25', '391d:1a2b', '391d:1a41', '391d:1a4e', '391d:2a05', '391d:2a07', '391d:2a0f',
]);
const idOf = (d) => `${(d.vendorId || 0).toString(16).padStart(4, '0')}:${(d.productId || 0).toString(16).padStart(4, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const channelOf = (d) => d.channels.find((c) => c.usagePage === 0xffff && c.usage === 0x02);
const hasLayout = (d) => d.channels.some((c) => c.usagePage === 0xffff && c.usage === 0x01) && !!channelOf(d);

function matches(d) {
  if (OTHER_DONGLES.has(idOf(d))) return !!channelOf(d);
  return d.vendorId === VENDOR && hasLayout(d);
}

// 'mouse' or 'keyboard': which battery of the two this device is.
// The receiver also says what is paired (byte 7: 1 keyboard, 2 mouse, 3 both; MonsGeek's driver); with
// both, the name decides. Some firmware echoes the request (00 F7 ...): no reading.
function parseReply(f, kind) {
  if (f.length < 6 || f[1] === 0xf7 || f.slice(1, 6).every((b) => b === 0)) return null;
  const paired = f[7] === 1 ? 'keyboard' : f[7] === 2 ? 'mouse' : kind;
  const [level, link] = paired === 'keyboard' ? [f[2], f[4]] : [f[3], f[5]];
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
