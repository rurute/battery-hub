// SONY INZONE Buds over its USB dongle (054c:0ec2). The battery GET and its reply follow the
// protocol notes of openinzone (github.com/penguinwokrs/openinzone), inzone-buds-battery-tray,
// InzoneBattery and InzoneBudsBattery, and were checked on real hardware.
//
// Request on the command collection (0xFF04/0x0001), report 0x02, 64 bytes:
//   02 0C | 01 00 FC 08 96 C3 41 04 01 <TID lo> <TID hi> <checksum>
//   41 = to the earbuds (4) from the PC (1), 04 = battery event, 01 = GET
// Reply:
//   02 12 04 FF 0F 00 96 C3 14 04 10 <TID lo> <TID hi> | LS LL RS RR CS CC | checksum
//   10 = answer to a GET; each part is a status byte and a level (0-100, 0xFF = not reported)
//
// INZONE Hub talks on the same collection, so a reply only counts when its event, type, TID and
// checksum all match. A Hub battery reply that happens to carry our TID can't be told apart, but it
// holds the same earbuds' levels.
const exchange = require('./exchange');

const { pad } = exchange;

const REPORT_ID = 0x02;
const REQUEST_HEAD = [REPORT_ID, 0x0c, 0x01, 0x00, 0xfc, 0x08, 0x96, 0xc3, 0x41, 0x04, 0x01];
const REQUEST_LENGTH = 64;
const BATTERY_EVENT = 0x04;
const GET_ANSWER = 0x10;
const REPLY_LENGTH = 20;
const FIRST_TID = 0x4000; // away from the small numbers INZONE Hub uses
const SONY = 0x054c;
const DONGLE = 0x0ec2;
const REPLY_MS = 1000;
const ATTEMPTS = 2; // a reply can go missing just after the earbuds go into the case
const TIMEOUT = /^timeout/;

const lowByte = (bytes) => bytes.reduce((a, b) => a + b, 0) & 0xff;

function request(tid) {
  const body = [...REQUEST_HEAD, tid & 0xff, (tid >> 8) & 0xff];
  return pad([...body, lowByte(body.slice(6))], REQUEST_LENGTH);
}

const level = (value) => (value <= 100 ? value : null);

// { left, right, case } from our reply to this TID, or null for any other frame.
function parseReply(frame, tid) {
  if (frame.length < REPLY_LENGTH || frame[0] !== REPORT_ID) return null;
  if (frame[9] !== BATTERY_EVENT || frame[10] !== GET_ANSWER) return null;
  if (frame[11] !== (tid & 0xff) || frame[12] !== ((tid >> 8) & 0xff)) return null;
  if (frame[19] !== lowByte(frame.slice(5, 19))) return null;
  return { left: level(frame[14]), right: level(frame[16]), case: level(frame[18]) };
}

let tidNext = FIRST_TID;
function nextTid() {
  const tid = tidNext;
  tidNext = tid >= 0xffff ? 1 : tid + 1;
  return tid;
}

function _resetTid(value = FIRST_TID) {
  tidNext = value;
}

const commandChannel = (logicalDevice) => logicalDevice.channels.find((c) => c.usagePage === 0xff04 && c.usage === 0x0001);

function matches(logicalDevice) {
  return logicalDevice.vendorId === SONY && logicalDevice.productId === DONGLE && !!commandChannel(logicalDevice);
}

// The card shows the lower earbud. With neither earbud reporting, or no reply at all (the case is
// closed), the earbuds are treated as switched off, as the poller does for other headsets.
async function readBattery(logicalDevice) {
  const channel = commandChannel(logicalDevice);
  if (!channel) throw new Error('no command channel');
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const tid = nextTid();
    let parts;
    try {
      parts = await exchange.exchange(channel, request(tid), (f) => parseReply(f, tid), REPLY_MS);
    } catch (e) {
      if (TIMEOUT.test(e.message)) continue;
      throw e;
    }
    const earbuds = [parts.left, parts.right].filter((v) => v !== null);
    if (!earbuds.length) throw new Error('headset is off');
    // Charging can't be read. It is reported as false rather than null, because the poller would
    // otherwise guess it from a rising level, and the level jumps whenever the lower earbud goes
    // into the case.
    return { capacity: Math.min(...earbuds), charging: false, parts };
  }
  throw new Error('headset is off');
}

module.exports = { id: 'inzone', matches, readBattery, request, parseReply, nextTid, _resetTid };
