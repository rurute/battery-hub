// Mice on YJX-chip receivers (issues #85, #112, #157), read the way MCHOSE's "gmouse" web driver
// (mchose.com.cn/gmouse, getBatteryInfo) reads its G-series mice on the same platform. MCHOSE's
// M HUB lists one of these receivers, a8a5:2255, by name. The driver opens the collection
// 0xFF01/0x0010 and writes an unnumbered 64-byte report:
//
//   55 30 a5 0b 2e 01 01 01 00 ...      read battery
//   reply aa 30 .. .. .. .. .. .. <level> <charging>
const { exchange, pad } = require('./exchange');

const VENDORS = new Set([0xa8a4, 0xa8a5, 0xa8a6, 0x249a]);
const REQUEST = pad([0x00, 0x55, 0x30, 0xa5, 0x0b, 0x2e, 0x01, 0x01, 0x01], 65);

const channelOf = (d) => d.channels.find((c) => c.usagePage === 0xff01 && c.usage === 0x10);

function isG3a(logicalDevice) {
  const { vendorId, product, manufacturer } = logicalDevice;
  const mchose = vendorId === 0x3837 || vendorId === 0xa8a4 || vendorId === 0xa8a5
    || /mchose|迈从/i.test(manufacturer + ' ' + product);
  // G3 A revisions share Gmouse, but can have different receiver product ids.
  return mchose && /\bg3\s*a\b/i.test(product);
}

function matches(logicalDevice) {
  return (VENDORS.has(logicalDevice.vendorId) || isG3a(logicalDevice)) && !!channelOf(logicalDevice);
}

// The receiver keeps returning its last battery reading after the mouse switches off.
function parseStatus(f) {
  if (f.length < 9 || f[0] !== 0xaa || f[1] !== 0xed || (f[8] !== 1 && f[8] !== 2)) return null;
  return f[8] === 2;
}

function parseReply(f) {
  if (f.length < 10 || f[0] !== 0xaa || f[1] !== 0x30) return null;
  if (f[8] === 0 || f[8] > 100) return { offline: true };
  return { capacity: f[8], charging: f[9] === 1 };
}

async function readBattery(logicalDevice) {
  const channel = channelOf(logicalDevice);
  if (!channel) throw new Error('no command channel');
  let reading;
  try {
    if (isG3a(logicalDevice)) {
      // Receivers that only answer the battery command can still provide a reading.
      const online = await exchange(channel, pad([0x00, 0x55, 0xed], 65), parseStatus).catch((e) => {
        if (/^timeout/.test(e.message)) return null;
        throw e;
      });
      if (online === false) throw new Error('mouse is off');
    }
    reading = await exchange(channel, REQUEST, parseReply);
  } catch (e) {
    if (/^timeout/.test(e.message)) throw new Error('mouse is not answering');
    throw e;
  }
  if (reading.offline) throw new Error('mouse is off');
  return reading;
}

module.exports = { id: 'yjx', matches, readBattery, parseReply, parseStatus, REQUEST };
