// Akko 8K receivers, Telink mice and Wobkey keyboards (38ee:0024, 38ee:000f; issues #226, #9) and other mice on the same platform with
// the 0xFF1C/0x0092 collection (Telink 320f:226f in issue #193 sends the same frames). Read from
// Akko's own web driver (driver.akkogear.com), which asks every 5 seconds:
//
//   output report 4: 04 00 00 1A 06 00 00 00 ...  (64 bytes)
//   input report 4:  04 .. .. 1A .. .. .. .. <percent> <charging>
//
// A level of 0 over the receiver means the mouse is off.
const { exchange, pad } = require('./exchange');

// Eight bytes: hidapi pads a write to the report's real length, and one longer than it fails.
const REQUEST = pad([0x04, 0x00, 0x00, 0x1a, 0x06], 8);
// Wobkey's driver for the Telink mice on the same collection (issues #11, #65, #134, #193) fills in
// bytes 1-2 as the 16-bit sum of the command bytes; Akko's leaves them 0. Telink firmware may want it.
const REQUEST_SUMMED = pad([0x04, 0x20, 0x00, 0x1a, 0x06], 8);
const channelOf = (d) => d.channels.find((c) => c.usagePage === 0xff1c && c.usage === 0x92);

function matches(logicalDevice) {
  return !!channelOf(logicalDevice);
}

function parseReply(f) {
  if (f.length < 10 || f[0] !== 0x04 || f[3] !== 0x1a) return null;
  if (f[8] === 0 || f[8] > 100) return { offline: true };
  return { capacity: f[8], charging: f[9] === 1 };
}

async function readBattery(logicalDevice) {
  const channel = channelOf(logicalDevice);
  if (!channel) throw new Error('no command channel');
  let reading;
  try {
    reading = await exchange(channel, REQUEST, parseReply, 2000)
      .catch((e) => (/^timeout/.test(e.message) ? exchange(channel, REQUEST_SUMMED, parseReply, 2000) : Promise.reject(e)));
  } catch (e) {
    if (/^timeout/.test(e.message)) throw new Error('mouse is not answering');
    throw e;
  }
  if (reading.offline) throw new Error('mouse is off');
  return reading;
}

module.exports = { id: 'akko', matches, readBattery, parseReply, REQUEST, REQUEST_SUMMED };
