// Devices with a simple request/response battery protocol, described as data.
//
// Headset protocols come from HeadsetControl (github.com/Sapd/HeadsetControl) and SteelSeries
// mice from rivalcfg (github.com/flozz/rivalcfg). Offsets match what hidapi returns.
//
//   channel : which HID collection to talk to; omitted means try the vendor collections
//   wired   : reached over its cable, so it can't be off
//   steps   : run in order; each parse returns part of a reading, { offline: true } if the
//             dongle answers but the device is off, or null to keep waiting for the right frame
const { pad, scale, fromVoltage } = require('./exchange');

const OFFLINE = { offline: true };
const STATUS_REQUEST = [0x00, 0xb0];
const clampPercent = (v) => Math.min(100, Math.max(0, v));

// ASUS ROG mice, as G-Helper reads them (AsusMouse.cs): 12 07 asks for the battery. The reply is
// 12 07 .. .. <level> .. .. .. .. <charging>, one byte later behind a report id; FF AA = asleep.
function asusMouse(f) {
  const o = f[0] === 0x03 ? 1 : 0;
  if (f[o] === 0xff && f[o + 1] === 0xaa) return OFFLINE; // asleep, or nothing paired to the receiver
  if (f.length < 10 + o || f[o] !== 0x12 || f[o + 1] !== 0x07) return null;
  const charging = f[o + 9] !== 0;
  if (f[o + 4] > 100 || (f[o + 4] === 0 && !charging)) return OFFLINE;
  return { capacity: f[o + 4], charging };
}

// ---- SteelSeries Arctis ----
const STEELSERIES = 0x1038;
const NOVA_CHANNEL = { usagePage: 0xffc0, usage: 0x01, interface: 3 };
const NOVA_DISCRETE_LEVELS = new Set([0x2202, 0x2206, 0x220a, 0x223a, 0x227a, 0x22a4]); // reports 0-4

function novaWireless(f) { // Nova 3P, Nova 5: byte 1 = link, 3 = percent, 4 = charging
  if (f.length < 5) return null;
  if (f[1] === 0x02) return OFFLINE;
  return { capacity: clampPercent(f[3]), charging: f[4] === 0x01 };
}

function nova7(f, productId) {
  if (f.length < 4) return null;
  if (f[3] === 0x00) return OFFLINE;
  const capacity = NOVA_DISCRETE_LEVELS.has(productId) ? scale(f[2], 0, 4) : clampPercent(f[2]);
  return { capacity, charging: f[3] === 0x01 || f[3] === 0x02 };
}

// ---- Logitech headsets: HID++ long report asking for the battery voltage ----
const LOGITECH = 0x046d;
const LOGITECH_CHANNEL = { usagePage: 0xff43, usage: 0x0202 };
const curve = (mv, pct) => mv.map((v, i) => [v, pct[i]]);
const G533_CURVE = curve([4200, 3850, 3790, 3750, 3680, 3330], [100, 50, 30, 20, 5, 0]);
const G535_CURVE = curve([4175, 3817, 3766, 3730, 3664, 3310], [100, 50, 30, 20, 5, 0]);
const G633_CURVE = curve([4100, 3950, 3850, 3750, 3650, 3500, 3450, 3300], [100, 80, 60, 40, 20, 10, 5, 0]);
const GPRO_CURVE = curve([4150, 3830, 3780, 3740, 3670, 3320], [100, 50, 30, 20, 5, 0]);

function hidppVoltageStep(command, points) {
  return {
    request: pad([0x11, 0xff, ...command], 20),
    parse(f) {
      if (f.length < 7 || f[0] !== 0x11) return null;
      // HeadsetControl reads an error answer as the headset being offline. Answers and errors
      // repeat the request's feature index and function, which keeps out G HUB's traffic.
      if (f[2] === 0xff) return f[3] === command[0] && f[4] === command[1] ? OFFLINE : null;
      if (f[2] !== command[0] || f[3] !== command[1]) return null;
      const mv = (f[4] << 8) | f[5];
      if (mv < points[points.length - 1][0]) return OFFLINE; // no real cell reads this low
      return { capacity: fromVoltage(mv, points), charging: f[6] === 0x03, voltageMv: mv };
    },
  };
}

// ---- HyperX ----
const HP = 0x03f0;
const KINGSTON = 0x0951;
const CLOUD_FLIGHT_CHARGING_MV = 0x100b;
const CLOUD_FLIGHT_CURVE = curve([3975, 3900, 3800, 3700, 3648, 0], [100, 80, 50, 25, 8, 0]);

function cloud2Step(command, parse, length = 52) {
  return {
    request: pad([0x06, 0xff, 0xbb, command, 0x00], length),
    parse(f) {
      if (f.length < 8 || f[0] !== 0x06 || f[1] !== 0xff || f[2] !== 0xbb || f[3] !== command) return null;
      return parse(f);
    },
  };
}

// ---- Corsair "Bragi" headsets: properties read with GET, from HeadsetControl's corsair_void_v2w
// and corsair_virtuoso_xt. A request goes to 0x08 (the receiver) or 0x09 (the headset behind it).
// Replies: [0] 0x01, [1] 0x00 receiver / 0x01 headset, [2] command echo, [3] status, [4..5] value.
// Status 0x05 ("no such property") is the receiver answering for a headset that isn't there.
// The battery is property 0x0f, in tenths of a percent. The reply doesn't repeat the property, so
// a value outside 1-1000 (another program's answer) is skipped, as HeadsetControl does.
const BRAGI_RECEIVER = 0x08;
const BRAGI_HEADSET = 0x09;
const BRAGI_GET = 0x02;

function bragiStep(prefix, target, property, parse) {
  const unnumbered = prefix.length > 0; // the newer receivers take a 65-byte write with a leading 0
  return {
    request: pad([...prefix, 0x02, target, BRAGI_GET, property, 0x00], unnumbered ? 65 : 64),
    parse(f) {
      if (f.length < 6 || f[0] !== 0x01 || f[2] !== BRAGI_GET) return null;
      if (f[1] !== (target === BRAGI_HEADSET ? 0x01 : 0x00)) return f[3] === 0x05 ? OFFLINE : null;
      if (f[3] === 0x05) return OFFLINE;
      return f[3] === 0x00 ? parse(f[4] | (f[5] << 8)) : null;
    },
  };
}
const bragiBattery = (value) => (value >= 1 && value <= 1000 ? { capacity: clampPercent(Math.round(value / 10)) } : null);

// OpenLinkHub's framing for Corsair mouse and keyboard dongles and for those devices on their cable
// (slipstream, k65plusWdongle and the *WU packages: transfer(), getBatterLevel()): 00 <target> 02
// <property>, 65 bytes; the reply is <source> 02 <error> <value lo> <value hi>. HaloBattery checked it
// on hardware: 01 02 00 e8 03 = 100 % on a K65 PLUS dongle, 01 02 00 26 02 = 55 % on a Dark Core RGB
// Pro SE. Error 5 = nothing behind the receiver. It differs from the headset framing (bragiStep), whose
// replies these devices' captures don't fit, so the headset framing stays only as a fallback.
// The answer comes from 00 for target 0x08 (the device itself) and from 01 for target 0x09 (the device
// behind the receiver), as HaloBattery checks it; a receiver's own answer to iCUE on this channel is
// not taken for the mouse.
function olhStep(target, property, parse) {
  const source = target - 0x08;
  return {
    request: pad([0x00, target, BRAGI_GET, property], 65),
    parse(f) {
      if (f.length < 5 || f[0] !== source || f[1] !== BRAGI_GET) return null;
      if (f[2] === 0x05) return OFFLINE;
      return f[2] === 0x00 ? parse(f[3] | (f[4] << 8)) : null;
    },
  };
}

function alphaStep(command, parse) {
  return {
    request: pad([0x21, 0xbb, command], 31),
    parse(f, productId, sofar) {
      if (f.length < 4 || f[0] !== 0x21 || f[1] !== 0xbb || f[2] !== command) return null;
      return parse(f, sofar || {});
    },
  };
}

// byte 1: charging flag on top, level in 5% steps from 1. rivalcfg reads a level outside 0-100
// (a raw 0 from the dongle) as the mouse being off.
function aeroxBattery(f) {
  if (f.length < 2) return null;
  const level = ((f[1] & 0x7f) - 1) * 5;
  if (level < 0 || level > 100) return OFFLINE;
  return { capacity: level, charging: !!(f[1] & 0x80) };
}

// Domain 0x80 asks a receiver for the headset behind it; 0x00 asks a headset on its own cable.
function razerHeadsetRequest(command, domain = 0x80) {
  const r = pad([0x02, 0x00, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, domain, command], 64);
  r[62] = r.slice(0, 62).reduce((x, b) => x ^ b, 0);
  return r;
}

// The same Razer frame from the BlackShark V2 HyperSpeed and Kraken V4 (HaloBattery #86 and the
// Kraken V4 owner; arkady-emelyanov/blackshark-battery dongle.rs; OpenRGB MR 3042). Their replies
// don't always carry the 02 at byte 1 the V3's do, so it isn't required; a cable may answer as 0x80.
function razerMediaTek(domain) {
  return {
    request: razerHeadsetRequest(0x21, domain),
    parse: (f) => (f.length < 14 || f[0] !== 0x02 || (f[2] & 0xe0) !== 0x60 || (f[9] !== domain && f[9] !== 0x80)
      || f[10] !== 0x21 || (f[11] !== 0x01 && f[11] !== 0x02) || f[12] !== 0x01 ? null
      : f[13] === 0 || f[13] > 100 ? OFFLINE : { capacity: f[13] }),
  };
}

// The "Avnera" feature exchange of several headset dongles: a request sent as feature report 0xFF,
// then feature report 0xFF read back until the answer is there (FF 01 = nothing fresh yet).
function avneraStep(request, parse, { wait = 50, tries = 5 } = {}) {
  return { via: 'feature', request: pad(request, 64), reportId: 0xff, length: 64, wait, tries, parse };
}
const LI_ION = curve([4150, 4000, 3900, 3800, 3700, 3600, 3500, 3320], [100, 85, 70, 55, 35, 20, 8, 0]);

// Logitech's newer headsets answer a fixed-index battery request on 0xFFA0 (HeadsetControl #581 for
// the G325, its logitech_gpro_x2_lightspeed legacy request for the PRO X 2).
const LOGITECH_CENTURION = { usagePage: 0xffa0, usage: 0x01, interface: 3 };

// Jabra's GN protocol: report 5, GET battery (0x46 = GET, 6 bytes) of 0x12 0x02. dst 0x04 is the
// headset behind a Link dongle, 0x08 a headset on its own USB. HeadsetControl jabra_gnp_protocol.hpp.
const JABRA_SEQ = 0x5a;
function jabraStep(dst) {
  return {
    request: pad([0x05, dst, 0x00, JABRA_SEQ, 0x46, 0x12, 0x02], 64),
    parse(f) {
      if (f.length < 9 || f[0] !== 0x05 || (f[4] >> 6) !== 3 || f[3] !== JABRA_SEQ) return null;
      if (f[5] === 0xfe) return [0xf3, 0xf4, 0xf5].includes(f[6]) ? OFFLINE : null;
      return f[8] >= 1 && f[8] <= 100 ? { capacity: f[8], charging: !!(f[7] & 0x01) } : null;
    },
  };
}

// MCHOSE's 55 65 status, as its M HUB reads it: 2 on battery, 3 charging, 4 full, 26 asleep. A 55 0A
// frame is the dongle saying the headset is off (HeadsetControl fifine_ht6, the same protocol).
function mchoseStatus(f) {
  if (f.length < 4 || f[0] !== 0x55) return null;
  if (f[1] === 0x0a) return OFFLINE;
  if (f[1] !== 0x65) return null;
  if (f[3] === 26) return OFFLINE;
  if (f[3] < 2 || f[3] > 4) return null;
  return { capacity: clampPercent(f[2]), charging: f[3] === 3 };
}

// Slipstream V2 reply: <endpoint> .. 01 02 <status> <lo> <hi>, tenths of a percent.
function slipstreamV2(endpoint) {
  return (f) => {
    if (f.length < 7 || f[0] !== endpoint || f[2] !== 0x01 || f[3] !== 0x02) return null;
    if (f[4] !== 0x00) return OFFLINE;
    return bragiBattery(f[5] | (f[6] << 8));
  };
}

function blackSharkV3x(command, parse) {
  const request = pad([0x07, 0x00, 0x03, 0x00, 0x00, 0x00, 0x02, 0x07, command], 64);
  request[62] = request.slice(3, 61).reduce((x, b) => x ^ b, 0);
  return {
    via: 'feature', request, reportId: 0x07, length: 64, wait: 50, tries: 4,
    parse(f) {
      if (f.length < 63 || f[0] !== 0x07 || f[1] !== 0x02 || f[2] !== 0x03 || f[7] !== 0x07 || f[8] !== command) return null;
      if (f[62] !== f.slice(3, 61).reduce((x, b) => x ^ b, 0)) return null;
      return parse(f[10]);
    },
  };
}

// Armoury Crate's steps for the Strix Go (HaloBattery asus.py), about 160 mV lower while charging.
// Millivolts outside what a Li-ion cell can read are a stray frame (HaloBattery's 2500-4500 check).
const MV_MIN = 2500;
const MV_MAX = 4500;

function strixGo(f) {
  if (f.length < 13 || f[0] !== 0xff) return null;
  if (f[1] === 0x00) return OFFLINE;
  if (f[1] !== 0x1b) return null;
  const charging = f[9] === 0x0a;
  const raw = f[11] | (f[12] << 8);
  if (raw < MV_MIN || raw > MV_MAX) return raw === 0 ? OFFLINE : null;
  const mv = raw - (charging ? 160 : 0);
  const capacity = mv >= 4100 ? 100 : mv >= 3800 ? 75 : mv >= 3700 ? 50 : mv >= 3500 ? 25 : 10;
  return { capacity, charging, voltageMv: mv };
}

function hyperxAlpha2Steps() {
  return [
    { request: pad([0x52, 0x01], 64), parse: (f) => (f.length < 3 || f[0] !== 0x53 || f[1] !== 0x01 ? null : f[2] ? {} : OFFLINE) },
    { request: pad([0x50, 0x02], 64), parse: (f) => (f.length < 4 || f[0] !== 0x51 || f[1] !== 0x02 || f[2] < 1 || f[2] > 100 ? null : { capacity: f[2], charging: f[3] === 1 }) },
  ];
}

// ROG keyboards' 12 01 reply (G-Helper AsusKeyboard.cs ParseBattery): 12 01 .. .. .. <level> .. ..
// <charging>, FF AA when asleep, at the start or where the level goes.
function asusKeyboard(f, levelAt) {
  if ((f[0] === 0xff && f[1] === 0xaa) || (f[0] === 0x12 && f[5] === 0xff && f[6] === 0xaa)) return OFFLINE;
  if (f.length < Math.max(9, levelAt + 1) || f[0] !== 0x12 || f[1] !== 0x01) return null;
  if (f[levelAt] < 1 || f[levelAt] > 100) return null;
  return { capacity: f[levelAt], charging: f[8] === 1 };
}

function lofreeFrame(command) {
  const f = new Array(17).fill(0);
  f[0] = 0x08; f[1] = command; f[5] = 0x80;
  f[16] = (0x55 - f.reduce((a, b) => a + b, 0)) & 0xff;
  return f;
}
function lofreeSteps() {
  return [
    { request: lofreeFrame(0x03), parse: (f) => (f.length < 7 || f[0] !== 0x08 || f[1] !== 0x03 ? null : f[6] === 1 ? {} : OFFLINE) },
    { request: lofreeFrame(0x04), parse: (f) => (f.length < 8 || f[0] !== 0x08 || f[1] !== 0x04 || f[6] < 1 || f[6] > 100 ? null : { capacity: f[6], charging: !!f[7] }) },
  ];
}

// The Nordic framing of Darmoshark's N5 and the OGM: every frame sums to 0xA1.
function nordicRequest(type, last) {
  return pad([0x00, type, 0x00, 0x81, 0x01], 64).concat([last]);
}
function nordicBattery(f) {
  if (f.length < 64 || (f[0] & 0x3f) !== 0x01 || f[3] !== 0x01) return null;
  if ((f.slice(0, 64).reduce((a, b) => a + b, 0) & 0xff) !== 0xa1) return null;
  const level = f[6] === 0x15 && f[7] === 0x19 ? f[11] : f[6];
  return level >= 1 && level <= 100 ? { capacity: level } : null;
}

function aerox3Gen2(opcode) {
  return (f) => (f.length < 3 || f[0] !== opcode || f[2] === 0xff || f[2] > 100 ? null : f[2] === 0 ? OFFLINE : { capacity: f[2], charging: f[1] === 1 });
}

function vaxeeStep(command, parse) {
  return {
    via: 'feature', request: pad([0x0e, 0xa5, command, 0x01, 0x01], 64), reportId: 0x0e, length: 64, wait: 100, tries: 3,
    parse: (f) => (f.length < 6 || f[0] !== 0x0e || f[1] !== 0xa5 || f[2] !== command ? null : parse(f[5])),
  };
}

function ninjutsoStep(command, parse) {
  return {
    via: 'feature', request: pad([0x06, command, 0x00, 0x00, 0x01], 16), reportId: 0x06, length: 16, wait: 30, tries: 4,
    parse: (f) => (f.length < 9 || f[0] !== 0x06 || f[1] !== command ? null : parse(f[8])),
  };
}

let deluxSeq = 0;
function deluxRequest() {
  deluxSeq = (deluxSeq + 1) & 0xff;
  return pad([0x0c, 0x01, 0x20, 0x00, deluxSeq], 33);
}

// ASUS ROG and TUF mice in G-Helper's lists (AsusMouse.cs, Models/*.cs) with a percent-level battery,
// read like the Gladius III AimPoint: 12 07 on interface N, page 0xFF01 when Windows shows it, else
// the interface's collection. Some take a 64-byte report (+ in G-Helper). [wireless, cable, name, iface, 64-byte cable]
const ASUS_MICE = [
  [0x1a1a, 0x1a18, 'ROG Chakram X', 0],
  [0x197f, 0x197d, 'ROG Gladius III Wireless', 0],
  [null, 0x1a70, 'ROG Gladius III AimPoint', 0],
  [0x1b0c, 0x1b0a, 'ROG Gladius III AimPoint EVA-02', 0],
  [0x1a94, 0x1a92, 'ROG Harpe Ace Aim Lab Edition', 0],
  [null, 0x1b67, 'ROG Harpe Ace Extreme', 0],
  [null, 0x1b63, 'ROG Harpe Ace Mini', 0, true],
  [null, 0x1c69, 'ROG Harpe II Ace', 0, true],
  [null, 0x1b16, 'ROG Keris II Ace', 0],
  [null, 0x1c0c, 'ROG Keris II Origin', 0, true],
  [null, 0x1d4c, 'ROG Keris II Origin', 0, true],
  [0x1a68, 0x1a66, 'ROG Keris Wireless AimPoint', 0],
  [0x1a24, null, 'ASUS MD200', 2],
  [0x1cd3, 0x1cd5, 'ProArt MD301', 3],
  [0x1979, 0x1977, 'ROG Spatha X', 0],
  [0x19f4, null, 'TUF Gaming M4 Wireless', 0],
  [0x1a8d, null, 'TX Gaming Mouse', 0],
  [0x1af5, 0x1af3, 'TX Gaming Mouse Mini', 0],
  [0x1c57, 0x1c56, 'TUF Gaming Mini Miku Edition', 0],
];
function asusMice() {
  const entries = [];
  for (const [wireless, cable, name, iface, short] of ASUS_MICE) {
    const channel = [{ usagePage: 0xff01, interface: iface }, { interface: iface }];
    if (wireless) entries.push({ name: `ASUS ${name}`, kind: 'mouse', vendorId: 0x0b05, productIds: [wireless], channel, steps: [{ request: pad([0x00, 0x12, 0x07], 65), parse: asusMouse }] });
    if (cable) entries.push({ name: `ASUS ${name} (cable)`, kind: 'mouse', wired: true, vendorId: 0x0b05, productIds: [cable], channel, steps: [{ request: pad([0x00, 0x12, 0x07], short ? 64 : 65), parse: asusMouse }] });
  }
  // The Harpe II Ace's SPEEDNOVA 8K receiver takes it as report 3, like the OMNI receiver (HaloBattery:
  // 03 12 07 00 00 35 02 14 fd 0e = 53 %).
  entries.push({ name: 'ASUS ROG Harpe II Ace (receiver)', kind: 'mouse', vendorId: 0x0b05, productIds: [0x1ad0], channel: { usagePage: 0xff01 }, steps: [{ request: pad([0x03, 0x12, 0x07], 64), parse: asusMouse }] });
  return entries;
}

function vgnKing() {
  return {
    request: pad([0x20, 0x11, 0x00, 0x28, 0x01, 0x00, 0x01, 0x00, 0x08], 64),
    parse: (f) => (f.length < 18 || f[0] !== 0x20 || f[8] !== 0x08 || f[17] < 1 || f[17] > 100 ? null : { capacity: f[17] }),
  };
}

function pulsarFusion2(register, parse) {
  const request = new Array(65).fill(0);
  request[2] = 0x08; request[3] = register; request[4] = 0x01;
  const sum = request.slice(1, 63).reduce((a, b) => a + b, 0);
  request[63] = sum & 0xff; request[64] = sum >> 8;
  return {
    via: 'feature', request, reportId: 0x00, length: 65, wait: 20, tries: 50,
    // Status 05 with the request echoed is the dongle with no mouse (pulsar-mouse-linux _transact).
    parse: (f) => (f.length < 8 || f[2] !== 0x08 || f[3] !== register ? null : f[1] === 0x05 ? OFFLINE : f[1] !== 0x01 ? null : parse(f[7])),
  };
}

const DEVICES = [
  // Headsets
  {
    name: 'SteelSeries Arctis 1', kind: 'headset', vendorId: STEELSERIES, productIds: [0x12b3, 0x12b6, 0x12d5, 0x12d7],
    channel: { usagePage: 0xff43, usage: 0x0202, interface: 3 },
    steps: [{ request: [0x06, 0x12], parse: (f) => (f.length < 4 ? null : f[2] === 0x01 ? OFFLINE : { capacity: clampPercent(f[3]) }) }],
  },
  {
    name: 'SteelSeries Arctis 7', kind: 'headset', vendorId: STEELSERIES, productIds: [0x1252, 0x1260, 0x1280, 0x12ad],
    channel: { usagePage: 0xff43, usage: 0x0202, interface: 5 },
    steps: [{ request: [0x06, 0x18], parse: (f) => (f.length < 3 ? null : { capacity: clampPercent(f[2]) }) }],
  },
  {
    name: 'SteelSeries Arctis 7+', kind: 'headset', vendorId: STEELSERIES, productIds: [0x220e, 0x2212, 0x2216, 0x2236],
    channel: NOVA_CHANNEL,
    steps: [{
      request: STATUS_REQUEST,
      parse: (f) => (f.length < 4 ? null : f[1] === 0x01 ? OFFLINE : { capacity: scale(f[2], 0, 4), charging: f[3] === 0x01 }),
    }],
  },
  {
    name: 'SteelSeries Arctis 9', kind: 'headset', vendorId: STEELSERIES, productIds: [0x12c2, 0x12c4],
    channel: { interface: 0 },
    steps: [{
      request: [0x00, 0x20],
      parse: (f) => (f.length < 5 ? null : f[4] === 0xff ? OFFLINE : { capacity: scale(f[3], 0x64, 0x9a), charging: f[4] === 0x01 }),
    }],
  },
  {
    // 2255 and 2264 are Nova 5X revisions in Arctis-Sound-Manager's nova_5.yaml (not seen by anyone here yet).
    name: 'SteelSeries Arctis Nova 3P/5', kind: 'headset', vendorId: STEELSERIES, productIds: [0x2269, 0x226d, 0x2232, 0x2253, 0x2255, 0x2264],
    channel: NOVA_CHANNEL, steps: [{ request: STATUS_REQUEST, parse: novaWireless }],
  },
  {
    name: 'SteelSeries Arctis Nova 7', kind: 'headset', vendorId: STEELSERIES,
    productIds: [0x2202, 0x2206, 0x223a, 0x2258, 0x227a, 0x227e, 0x229e, 0x22a1, 0x22a4, 0x22a5, 0x22a9, 0x22ad, 0x220a, 0x22a7, 0x2298],
    channel: NOVA_CHANNEL, steps: [{ request: STATUS_REQUEST, parse: nova7 }],
  },
  {
    name: 'SteelSeries Arctis Nova Pro Wireless', kind: 'headset', vendorId: STEELSERIES, productIds: [0x12e0, 0x12e5],
    channel: { interface: 4 },
    steps: [{
      request: pad([0x06, 0xb0], 31),
      parse: (f) => (f.length < 16 ? null : f[15] === 0x01 ? OFFLINE : { capacity: scale(f[6], 0, 8), charging: f[15] === 0x02 }),
    }],
  },
  {
    name: 'HyperX Cloud Alpha Wireless', kind: 'headset', vendorId: HP, productIds: [0x098d],
    steps: [
      alphaStep(0x03, (f) => (f[3] === 0x01 ? OFFLINE : {})),
      alphaStep(0x0c, (f) => ({ charging: f[3] === 0x01 })),
      // A level of 0 is not a reading: a headset that flat can't answer. HeadsetControl skips the
      // level while charging; with the headset off the dongle answers 0 too.
      alphaStep(0x0b, (f, sofar) => (f[3] > 0 ? { capacity: clampPercent(f[3]) } : sofar.charging ? {} : OFFLINE)),
    ],
  },
  {
    // 1749 is the Cloud Flight for PlayStation (franco314/hyperx-battery, on Windows; HyperHeadset #30).
    name: 'HyperX Cloud Flight', kind: 'headset', vendorId: KINGSTON, productIds: [0x16c4, 0x1723, 0x1749],
    steps: [{
      request: pad([0x21, 0xff, 0x05], 20),
      parse(f) {
        if (f.length !== 15 && f.length !== 20) return null;
        const mv = (f[3] << 8) | f[4];
        return { capacity: fromVoltage(mv, CLOUD_FLIGHT_CURVE), charging: mv > CLOUD_FLIGHT_CHARGING_MV, voltageMv: mv };
      },
    }],
  },
  {
    // The Cloud Flight under HP's vendor id (HyperHeadset #30: an owner's lsusb; the same code path there).
    name: 'HyperX Cloud Flight (HP)', kind: 'headset', vendorId: HP, productIds: [0x0e90],
    steps: [{
      request: pad([0x21, 0xff, 0x05], 20),
      parse(f) {
        if (f.length !== 15 && f.length !== 20) return null;
        const mv = (f[3] << 8) | f[4];
        return { capacity: fromVoltage(mv, CLOUD_FLIGHT_CURVE), charging: mv > CLOUD_FLIGHT_CHARGING_MV, voltageMv: mv };
      },
    }],
  },
  {
    // Issue #180. From windows-taskbar-battery PR #2 (tested on Windows against NGENUITY's level)
    // and nogenuity's classic.rs, which send the same bytes: report 06 with BB 02 at bytes 14-15;
    // the answer (report 0x0b, as the #180 scan saw on ff13) echoes BB 02 at bytes 2-3, level at 7.
    // 1718 is the Kingston-era Cloud II Wireless on the same protocol (HaloBattery #192, HeadsetControl
    // PR #519); 0b92 is only in HyperHeadset's list.
    name: 'HyperX Cloud Flight S', kind: 'headset', vendorId: KINGSTON, productIds: [0x16ea, 0x16eb, 0x1718, 0x0b92],
    channel: { usagePage: 0xff13, usage: 0x01 },
    steps: [{
      request: pad([0x06, 0x00, 0x02, 0x00, 0x9a, 0x00, 0x00, 0x68, 0x4a, 0x8e, 0x0a, 0x00, 0x00, 0x00, 0xbb, 0x02], 62),
      parse: (f) => (f.length < 8 || f[0] === 0x0a || f[2] !== 0xbb || f[3] !== 0x02 ? null
        : f[7] === 0 || f[7] > 100 ? OFFLINE : { capacity: f[7] }),
    }],
  },
  {
    // From auto94's HyperX-Cloud-2-Battery-Monitor (MainForm.cpp, tested on the Core on Windows):
    // write 66 89, the reply carries the level at byte 4 (issues #117, #145). The Cloud III answers
    // on 0xFF13/0x0001; for the Core that project takes the collection with the highest usage.
    name: 'HyperX Cloud III Wireless', kind: 'headset', vendorId: HP, productIds: [0x05b7, 0x0c9d, 0x0fcc], // 0fcc: other receiver (HaloBattery, HyperBatteryMonitor)
    channel: { usagePage: 0xff13, usage: 0x01 },
    steps: [{ request: pad([0x66, 0x89], 52), parse: (f) => (f.length < 5 || f[0] !== 0x66 || f[1] !== 0x89 ? null : f[4] > 100 ? OFFLINE : { capacity: f[4] }) }],
  },
  {
    // 0795 is the id it has while charging (HaloBattery #155, answers too); 069f is only in HyperHeadset.
    name: 'HyperX Cloud II Core Wireless', kind: 'headset', vendorId: HP, productIds: [0x0995, 0x0795, 0x069f],
    steps: [{ request: pad([0x66, 0x89], 52), parse: (f) => (f.length < 5 || f[0] !== 0x66 || f[1] !== 0x89 ? null : f[4] > 100 ? OFFLINE : { capacity: f[4] }) }],
  },
  {
    // Same project: 0c 02 03 01 00 06 on collection 0x01C0/0x0001, level at byte 6, 0xff while off
    // (issue #33).
    name: 'HyperX Cloud III S Wireless', kind: 'headset', vendorId: HP, productIds: [0x06be, 0x02cc], // 02cc: HaloBattery #106, 89 % = NGENUITY
    channel: { usagePage: 0x01c0, usage: 0x01 },
    steps: [{ request: pad([0x0c, 0x02, 0x03, 0x01, 0x00, 0x06], 52), parse: (f) => (f.length < 7 || f[0] !== 0x0c || f[5] !== 0x06 ? null : f[6] > 100 ? OFFLINE : { capacity: f[6] }) }],
  },
  {
    name: 'HyperX Cloud II Wireless', kind: 'headset', vendorId: HP, productIds: [0x0696, 0x018b],
    channel: { usagePage: 0xff90, usage: 0x0303, interface: 0 },
    steps: [
      cloud2Step(0x02, (f) => ({ capacity: clampPercent(f[7]) })),
      cloud2Step(0x03, (f) => ({ charging: f[4] === 1 })),
    ],
  },
  {
    // Read like the Cloud II Wireless (auto94's HyperX-Cloud-2-Battery-Monitor, HyperHeadset), but its
    // 0xFF90/0x0303 collection is not on interface 0, so the Cloud II entry never matched it (issue #206).
    // HyperHeadset probes every interface on Windows for the same reason.
    // Its reports are 20 bytes long (the scan in #206 and HyperHeadset's packets), not 52.
    name: 'HyperX Cloud Stinger 2 Wireless', kind: 'headset', vendorId: HP, productIds: [0x0d93],
    channel: { usagePage: 0xff90, usage: 0x0303 },
    steps: [
      cloud2Step(0x02, (f) => ({ capacity: clampPercent(f[7]) }), 20),
      cloud2Step(0x03, (f) => ({ charging: f[4] === 1 }), 20),
    ],
  },
  {
    // Woken the way HeadsetControl does it without switching to software mode (which pops in the
    // headset): the receiver's firmware and a heartbeat, then a heartbeat to the headset.
    name: 'Corsair Void Wireless v2, HS80 MAX, Virtuoso MAX', kind: 'headset', vendorId: 0x1b1c,
    // 2a03, 2a0f, 2a0c, 2a05, 2a12: Xbox and second ids of the same family in OpenLinkHub's devices.go.
    productIds: [0x2a08, 0x0a97, 0x2a02, 0x2a03, 0x2a0f, 0x2a0c, 0x2a05, 0x2a12],
    channel: { usagePage: 0xff42 },
    steps: [
      bragiStep([0x00], BRAGI_RECEIVER, 0x13, () => ({})),
      bragiStep([0x00], BRAGI_RECEIVER, 0x12, () => ({})),
      bragiStep([0x00], BRAGI_HEADSET, 0x12, () => ({})),
      bragiStep([0x00], BRAGI_HEADSET, 0x0f, bragiBattery),
    ],
  },
  {
    // Slipstream receivers (issue #46) relay to the mouse or keyboard behind them (target 0x09). With
    // several paired, this reads the first one only. 1b7f (Dark Core RGB Pro SE) and 1ba6 were checked
    // on hardware by HaloBattery; 1b81, 1b66, 1b65, 2b00 and 1b94 are the same dongles in ckb-next and
    // OpenLinkHub's tables.
    name: 'Corsair Slipstream receiver', kind: 'mouse', vendorId: 0x1b1c,
    productIds: [0x1bdc, 0x1b7f, 0x1ba6, 0x1b81, 0x1b66, 0x1b65, 0x2b00, 0x1b94],
    channel: { usagePage: 0xff42 },
    steps: [olhStep(BRAGI_HEADSET, 0x0f, bragiBattery)],
    fallbackSteps: [
      bragiStep([0x00], BRAGI_RECEIVER, 0x12, () => ({})),
      bragiStep([0x00], BRAGI_HEADSET, 0x0f, bragiBattery),
    ],
  },
  {
    // The K65 PLUS Wireless dongle (HaloBattery #154, on hardware: 01 02 00 e8 03 = 100 %).
    name: 'Corsair K65 PLUS Wireless (dongle)', kind: 'keyboard', vendorId: 0x1b1c, productIds: [0x2b07],
    channel: { usagePage: 0xff42, usage: 0x01 }, // the 0x0002 notice channel is never written
    steps: [olhStep(BRAGI_HEADSET, 0x0f, bragiBattery)],
  },
  {
    // Corsair wireless mice on their cable answer for themselves (target 0x08): OpenLinkHub's *WU
    // packages (m75WU and others). 1bb5 (M65 RGB Ultra Wireless) is checked on hardware by
    // HaloBattery #411; the others are the same packages in OpenLinkHub and ckb-next.
    name: 'Corsair wireless mice (cable)', kind: 'mouse', wired: true, vendorId: 0x1b1c,
    productIds: [0x1bb5, 0x1bd6, 0x1b80, 0x1b7e, 0x1b4c, 0x1b5e, 0x1bb8, 0x1bdb, 0x2b22, 0x1bf1, 0x2b08, 0x1bf2, 0x1bb2, 0x2b32, 0x2b2e, 0x1b98],
    channel: { usagePage: 0xff42, usage: 0x01 },
    steps: [olhStep(BRAGI_RECEIVER, 0x0f, bragiBattery)],
    fallbackSteps: [bragiStep([0x00], BRAGI_RECEIVER, 0x0f, bragiBattery)],
  },
  {
    // NIGHTSWORD v2 on its cable: OpenLinkHub nightswordv2WU sends the SABRE v3 PRO cable's Slipstream
    // V2 frame (512-byte reports there; hidapi pads the 65-byte write). Level in tenths at bytes 5-6.
    name: 'Corsair NIGHTSWORD v2 (cable)', kind: 'mouse', wired: true, vendorId: 0x1b1c, productIds: [0x2b1c],
    channel: { usagePage: 0xff42, usage: 0x01 },
    steps: [{ request: pad([0x00, 0x00, 0x01, 0x01, 0x02, 0x0f], 65), parse: slipstreamV2(0x00) }],
  },
  {
    // Corsair wireless keyboards on their cable (OpenLinkHub k70coretklWU, k100airWU, k70pmWU and
    // the K65 PLUS and MAKR 75 packages): target 0x08. The VANGUARD 96 and 99 AIR speak Slipstream V2
    // with a reply layout OpenLinkHub doesn't spell out, so they wait for a capture.
    name: 'Corsair wireless keyboards (cable)', kind: 'keyboard', wired: true, vendorId: 0x1b1c,
    productIds: [0x2b02, 0x2b10, 0x2b11, 0x2b23, 0x1bab, 0x1bb6, 0x2b04],
    channel: { usagePage: 0xff42, usage: 0x01 },
    steps: [olhStep(BRAGI_RECEIVER, 0x0f, bragiBattery)],
    fallbackSteps: [bragiStep([0x00], BRAGI_RECEIVER, 0x0f, bragiBattery)],
  },
  {
    // 0x0a40 is a Virtuoso SE receiver HeadsetControl doesn't list yet (issue #99); its scan shows
    // the same Bragi replies.
    name: 'Corsair Virtuoso SE and XT', kind: 'headset', vendorId: 0x1b1c,
    // 0a6b: the HS80 RGB Wireless receiver (HaloBattery, from ST1CKEL/HS80_Control); 0a3f: the Virtuoso
    // SE on its USB cable (OpenLinkHub virtuosoSEWU), which, like 0a3d, answers on 0x09
    // (HeadsetControl corsair_virtuoso_xt resolveTarget).
    productIds: [0x0a3e, 0x0a3d, 0x0a40, 0x0a64, 0x0a6b, 0x0a3f],
    channel: { usagePage: 0xff42, usage: 0x01 },
    steps: [bragiStep([], BRAGI_HEADSET, 0x0f, bragiBattery)],
  },
  {
    name: 'Corsair Void and Virtuoso', kind: 'headset', vendorId: 0x1b1c,
    productIds: [0x1b1c, 0x1b27, 0x0a14, 0x0a16, 0x0a17, 0x0a1d, 0x0a1a, 0x1b2a, 0x1b23, 0x1b29, 0x0a55, 0x0a51, 0x0a52, 0x0a38, 0x0a4f, 0x0a2b, 0x0a75, 0x0a56],
    channel: { usagePage: 0xffc5, usage: 0x01, interface: 3 },
    steps: [{
      request: [0xc9, 0x64],
      parse(f) {
        if (f.length < 5 || f[0] !== 100) return null;
        if (f[4] === 0) return OFFLINE;
        return { capacity: clampPercent(f[2] & 0x7f), charging: f[4] === 4 || f[4] === 5 };
      },
    }],
  },
  {
    name: 'MCHOSE X9', kind: 'headset', vendorId: 0x3837, productIds: [0x6045],
    channel: { usagePage: 0xff90, usage: 0x01 },
    steps: [{
      request: pad([0x55, 0x65, 0x01], 64),
      parse: mchoseStatus,
    }],
  },
  {
    // MCHOSE's "MC" headset protocol, as its M HUB web driver (buildMCFrame, createReadBatteryCommand)
    // and fuyue521/Wireless-Device-Battery-Monitor-CN (tested on a V9 Pro 2) send it (issue #229):
    //   55 AA 01 00 01 00 01 0B         read battery: start, version, flags, length, type 00 01, 0x0B
    //   55 AA 01 .. .. 00 01 0B <on> <level>   <on> 0 = asleep; level bit 7 = charging
    name: 'MCHOSE V9 Pro 2', kind: 'headset', vendorId: 0x3837, productIds: [0x6011],
    channel: { usagePage: 0xff07, usage: 0x0222 },
    steps: [{
      request: pad([0x55, 0xaa, 0x01, 0x00, 0x01, 0x00, 0x01, 0x0b, 0x00], 64),
      parse(f) {
        if (f.length < 10 || f[0] !== 0x55 || f[1] !== 0xaa || f[5] !== 0x00) return null;
        const reply = f[6] === 0x01 && f[7] === 0x0b;
        const pushed = f[6] === 0x04 && f[7] === 0x22;
        if (!reply && !pushed) return null;
        if (f[8] === 0) return OFFLINE;
        return { capacity: clampPercent(f[9] & 0x7f), charging: !!(f[9] & 0x80) };
      },
    }],
  },
  {
    // HeadsetControl logitech_astro_a50_gen4 (issue #35): one reply per request, 02 STATUS LEN
    // PAYLOAD, status 0x02 = ok with payload. The base keeps the last level after the headset is
    // off, so the link (0x54, bit 1) is asked first. Battery 0x7c: bit 7 charging, the rest percent.
    name: 'Astro A50 Gen 4', kind: 'headset', vendorId: 0x9886, productIds: [0x002c],
    channel: { usagePage: 0xff32, usage: 0x74 },
    steps: [
      { request: pad([0x02, 0x54, 0x00], 64), parse: (f) => (f.length < 4 || f[0] !== 0x02 || f[1] !== 0x02 ? null : f[3] & 0x02 ? {} : OFFLINE) },
      { request: pad([0x02, 0x7c, 0x00], 64), parse: (f) => (f.length < 4 || f[0] !== 0x02 || f[1] !== 0x02 ? null : { capacity: clampPercent(f[3] & 0x7f), charging: !!(f[3] & 0x80) }) },
    ],
  },
  {
    // HeadsetControl logitech_astro_a50 (Gen 5 base, issue #53): 02 0c LEN 00 CMD HANDLE ...;
    // battery is CMD 0x06, reply byte 6 = percent, byte 8 = docked/charging. Matched on CMD.
    name: 'Astro A50 Gen 5', kind: 'headset', vendorId: LOGITECH, productIds: [0x0b1c],
    channel: { usagePage: 0xff32 },
    steps: [{
      request: pad([0x02, 0x0c, 0x03, 0x00, 0x06, 0x0c], 64),
      parse: (f) => (f.length < 9 || f[0] !== 0x02 || f[1] !== 0x0c || f[4] !== 0x06 ? null : { capacity: clampPercent(f[6]), charging: f[8] !== 0 }),
    }],
  },
  {
    // MCHOSE keyboards on the 3837:3033 2.4G receiver (G75 V2, G87 V2, K87S, K99 V3; issue #50).
    // From MCHOSE's own web driver (mchose.com.cn, the "glw" family): an unnumbered 64-byte report
    // on the collection with no usage, 55 <command> 00 <sum of the next four> <size> <offset lo hi>
    // 00. Command 4 reads the base info; the reply starts aa 04, and its byte 32 (40 in the frame)
    // holds the level in the low 7 bits and charging in the top bit.
    name: 'MCHOSE G75 V2, G87 V2, K87S, K99 V3 (2.4G)', kind: 'keyboard', vendorId: 0x3837, productIds: [0x3033],
    channel: { usagePage: 0x01, usage: null },
    steps: [{
      request: pad([0x00, 0x55, 0x04, 0x00, 0x38, 0x38, 0x00, 0x00, 0x00], 65),
      parse: (f) => (f.length < 41 || f[0] !== 0xaa || f[1] !== 0x04 || f[5] !== 0 || f[6] !== 0 ? null
        : (f[40] & 0x7f) === 0 ? null : { capacity: clampPercent(f[40] & 0x7f), charging: !!(f[40] & 0x80) }),
    }],
  },
  {
    // ASUS ROG Claymore II (issue #212), as G-Helper reads it (seerge/g-helper, ClaymoreII.cs; an owner's
    // log in its issue #5482): unnumbered output 12 01 on interface 1 (0xFF00/0x0001). The reply,
    // without the report id, is 12 01 .. .. .. <percent> .. .. <charging>; FF AA means asleep.
    // Only 12 01 is sent: G-Helper's other commands on this keyboard change its settings.
    // The same 12 01 reads ROG keyboards G-Helper lists with a battery (AsusKeyboard.cs, Models/Azoth.cs,
    // StrixScopeII.cs, StrixScopeRX.cs); HaloBattery confirmed it on an Azoth and an Azoth X: Azoth 1a83 /
    // its dongle 1a85, Azoth X 1c24 / 1c25, Azoth Extreme 1b3f and SE 1cef, Strix Scope II 96 Wireless
    // 1aae, Scope II 96 RX 1b78, Scope RX TKL Wireless 1a07.
    name: 'ASUS ROG Claymore II, Azoth, Strix Scope', kind: 'keyboard', vendorId: 0x0b05,
    productIds: [0x196b, 0x1a83, 0x1a85, 0x1c24, 0x1c25, 0x1b3f, 0x1cef, 0x1aae, 0x1b78, 0x1a07],
    channel: { usagePage: 0xff00, usage: 0x01 },
    steps: [{ request: pad([0x00, 0x12, 0x01], 65), parse: (f) => asusKeyboard(f, 5) }],
  },
  {
    // The Falchion family puts the level at byte 10 (byte 5 is a 0-10 gauge there): Falchion 193c / its
    // dongle 193e, Falchion RX LP 1b04 (HaloBattery checked it on hardware).
    name: 'ASUS ROG Falchion', kind: 'keyboard', vendorId: 0x0b05, productIds: [0x193c, 0x193e, 0x1b04],
    channel: { usagePage: 0xff00, usage: 0x01 },
    steps: [{ request: pad([0x00, 0x12, 0x01], 65), parse: (f) => asusKeyboard(f, 10) }],
  },
  {
    // Lofree Flow Lite84 on its Compx receiver (HaloBattery lofree.py, from Lofree's own Control HUB;
    // #165 and #557 on hardware). The VXE frame with the keyboard flag 0x80 at byte 5, summing to 0x55:
    // 08 03 .. 80 .. CA asks if it is on (byte 6 = 1), 08 04 .. 80 .. C9 for the level (6) and charging (7).
    // Its receiver is 3554:fa0a, or Apple's 05ac:024f, both named "2.4G Wireless Receiver".
    name: 'Lofree Flow Lite84', kind: 'keyboard', vendorId: 0x3554, productIds: [0xfa0a], product: /^2\.4G Wireless Receiver$/i,
    channel: { usagePage: 0xff02, usage: 0x02 },
    steps: lofreeSteps(),
  },
  {
    name: 'Lofree Flow Lite84', kind: 'keyboard', vendorId: 0x05ac, productIds: [0x024f], product: /^2\.4G Wireless Receiver$/i,
    channel: { usagePage: 0xff02, usage: 0x02 },
    steps: lofreeSteps(),
  },
  {
    // Alienware Pro Wireless Gaming Keyboard receiver (HaloBattery alienware.py, a USBPcap of Alienware
    // Command Center; on hardware: 92 %, charging followed the cable): feature report 0E A1, answered
    // as input 0E A1 <level> <state>, state 0x04 = charging. The channel also pushes other 0E frames.
    name: 'Alienware Pro Wireless Keyboard', kind: 'keyboard', vendorId: 0x413c, productIds: [0x211d],
    channel: { usagePage: 0xff00, usage: 0x01 },
    steps: [{
      via: 'feature-input', request: pad([0x00, 0x0e, 0xa1], 65),
      parse(f) {
        const o = f[0] === 0x00 ? 1 : 0;
        if (f.length < o + 4 || f[o] !== 0x0e || f[o + 1] !== 0xa1 || f[o + 2] < 1 || f[o + 2] > 100) return null;
        return { capacity: f[o + 2], charging: f[o + 3] === 0x04 };
      },
    }],
  },
  {
    // Red Square Alumix TKL (HaloBattery redsquare.py, from conf.red-square.org; tested by its #460
    // reporter): report 7, settings READ (0x8B), the battery after sleep time and debounce. No charging.
    name: 'Red Square Alumix TKL', kind: 'keyboard', vendorId: 0x342d, productIds: [0xe411], product: /RSQ[ _]20055/i,
    channel: { usagePage: 0xff60, usage: 0x61 },
    steps: [{
      request: pad([0x07, 0x05, 0x01, 0x01, 0x0a, 0x07, 0x8b], 33),
      parse: (f) => (f.length < 10 || f[0] !== 0x07 || f[1] !== 0x05 || f[2] !== 0xa1 || f[6] !== 0x8b || f[9] < 1 || f[9] > 100 ? null
        : { capacity: f[9] }),
    }],
  },
  {
    // GANSS GS3075T on a SONiX 0c45:fefe receiver (HaloBattery gs3075t.py, level and charge measured by
    // its #379 reporter): AA 10 18 after the zero report id; the reply 55 10 18 has the level at byte 25
    // and 0x01 / 0x02 at 26 on the cable (full / charging). hidapi may keep the zero, so both offsets.
    name: 'GANSS GS3075T', kind: 'keyboard', vendorId: 0x0c45, productIds: [0xfefe], product: /GS3075T/i,
    channel: { usagePage: 0xff60, usage: 0x61 },
    steps: [{
      request: pad([0x00, 0xaa, 0x10, 0x18], 33),
      parse(f) {
        const o = f[0] === 0x00 && f[1] === 0x55 ? 1 : 0;
        if (f.length < o + 27 || f[o] !== 0x55 || f[o + 1] !== 0x10 || f[o + 2] !== 0x18) return null;
        const level = f[o + 25];
        return level >= 1 && level <= 100 ? { capacity: level, charging: f[o + 26] === 0x01 || f[o + 26] === 0x02 } : null;
      },
    }],
  },
  {
    // 2.4G mice on the 1EA7 receiver (issue #48), as TaskbarVitals reads them (raigor.cpp, checked on
    // a 1ea7:0066 dongle; 0064 is in its list): report B5 on 0xFFB5/0x0001, 8 bytes. B5 05 makes the
    // dongle send its registers as B5 05 <address> 04 ..; the one at address 0x94 has the percent in
    // byte 6. The heartbeat it sends on its own, B5 67 .. .. .. .. <state> <percent>, has it too.
    name: '2.4G mouse (1EA7 receiver)', kind: 'mouse', vendorId: 0x1ea7, productIds: [0x0064, 0x0066],
    channel: { usagePage: 0xffb5, usage: 0x01 },
    steps: [{
      request: [0xb5, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      parse(f) {
        if (f.length < 8 || f[0] !== 0xb5) return null;
        const level = f[1] === 0x05 && f[2] === 0x94 ? f[6] : f[1] === 0x67 ? f[7] : null;
        return level >= 1 && level <= 100 ? { capacity: level } : null;
      },
    }],
  },
  {
    // ASUS ROG mice (see asusMouse): the Gladius III AimPoint (issue #118) takes 12 07 unnumbered,
    // the ROG OMNI receiver (issue #86) as report 3.
    name: 'ASUS ROG Gladius III AimPoint', kind: 'mouse', vendorId: 0x0b05, productIds: [0x1a72],
    channel: { usagePage: 0xff01 },
    steps: [{ request: pad([0x00, 0x12, 0x07], 65), parse: asusMouse }],
  },
  {
    name: 'ASUS ROG OMNI receiver', kind: 'mouse', vendorId: 0x0b05, productIds: [0x1ace],
    channel: { usagePage: 0xff01 },
    steps: [{ request: pad([0x03, 0x12, 0x07], 64), parse: asusMouse }],
  },
  {
    // MSI VERSA 300 Elite Wireless (issue #154): the battery query MSI's GM31 answers (0F 20) on
    // 0xFF0D/0x00B0. Reply 0F 20 ..., byte 14: bit 7 charging, the rest the percent. MSI Center's
    // 41 80 is never sent.
    name: 'MSI VERSA 300 Elite Wireless', kind: 'mouse', vendorId: 0x0db0, productIds: [0x9e22],
    channel: { usagePage: 0xff0d, usage: 0xb0 },
    steps: [{
      request: pad([0x00, 0x0f, 0x20], 65),
      parse(f) {
        if (f.length < 15 || f[0] !== 0x0f || f[1] !== 0x20 || (f[14] & 0x7f) > 100) return null;
        if (f[14] === 0) return OFFLINE; // level 0 and not charging: asleep or off
        return { capacity: f[14] & 0x7f, charging: !!(f[14] & 0x80) };
      },
    }],
  },
  {
    // Waizowl OGM 8K receiver (issue #169): the Nordic framing of Darmoshark's N5, whose frames all sum
    // to 0xA1; the frame the scan caught, 1f 00 81 01, does too. 41 00 81 01 asks for the base info;
    // the level is at byte 6, or at 11 when bytes 6-7 are 15 19.
    // 1915:0723 is the Darmoshark N5 receiver, the same frames (HaloBattery #430, 63 %).
    name: 'Waizowl OGM 8K', kind: 'mouse', vendorId: 0x1915, productIds: [0x0728, 0x0723],
    channel: { usagePage: 0xff0a, usage: 0x01 },
    steps: [{
      request: [0,65,0,129,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,222],
      parse(f) {
        if (f.length < 64 || (f[0] & 0x3f) !== 0x01 || f[3] !== 0x01) return null;
        if ((f.slice(0, 64).reduce((a, b) => a + b, 0) & 0xff) !== 0xa1) return null;
        const level = f[6] === 0x15 && f[7] === 0x19 ? f[11] : f[6];
        return level >= 1 && level <= 100 ? { capacity: level } : null;
      },
    }],
  },
  {
    // Corsair Void Wireless v2 on its cable (1b1c:2a09, issue #106): wired Bragi devices answer as
    // the receiver target (OpenLinkHub, hs80rgbWU).
    name: 'Corsair Void Wireless v2 (cable)', kind: 'headset', wired: true, vendorId: 0x1b1c, productIds: [0x2a09],
    channel: { usagePage: 0xff42 },
    steps: [bragiStep([0x00], BRAGI_RECEIVER, 0x0f, bragiBattery)],
  },
  {
    // The AULA F108 Pro's dongle uses Apple's vendor id (05ac:024f, issue #81), so it is matched on
    // its name. Same request and reply as the AULA receiver below (HaloBattery aula_f108.py, from
    // meitar/aula-driver; on Windows the reply 00 20 01 00 21 came when the keyboard showed 33 %).
    name: 'AULA F108 Pro (dongle)', kind: 'keyboard', vendorId: 0x05ac, productIds: [0x024f], product: /F108\s*Pro/i,
    channel: { usagePage: 0xff60, usage: 0x61 },
    steps: [{
      request: [0,32,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,33],
      parse: (f) => (f.length >= 4 && f[0] === 0x20 && f[1] === 0x01 && f[2] === 0x00 && f[3] >= 1 && f[3] <= 100 ? { capacity: f[3] } : null),
    }],
  },
  {
    // AULA and EWEADN keyboards on their SONiX 2.4G receiver 0c45:fefe (issues #109, #160 asked on the
    // cable, which has no battery command), as AulaToolkit and vigil-watt read them (checked on an X87):
    // output report 0, 20 01 and a last byte that sums the 31 before it; reply 20 01 00 <percent>.
    name: 'AULA, EWEADN keyboards (SONiX 2.4G receiver)', kind: 'keyboard', vendorId: 0x0c45, productIds: [0xfefe],
    channel: { usagePage: 0xff60, usage: 0x61 },
    steps: [{
      request: [0,32,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,33],
      parse: (f) => (f.length >= 4 && f[0] === 0x20 && f[1] === 0x01 && f[2] === 0x00 && f[3] >= 1 && f[3] <= 100 ? { capacity: f[3] } : null),
    }],
  },
  {
    // ATK X1 NearLink (issue #129), from ATK's web driver (v3-hub.atkgear.com, the Evision mouse
    // class, isEvisionWireless 0x108b/0x108c): report 5, <request code lo hi> 1a = power info. The
    // reply starts with the same request code; data from byte 7 holds the level, then charging.
    // ATK's hub reads the same power info for its other NearLink devices: the 8K NearLink dongle 1179,
    // A9 Ultimate NearLink 11b5, F1 NearLink 1156 (vendor driver, not hardware-confirmed).
    name: 'ATK X1 NearLink', kind: 'mouse', vendorId: 0x373b, productIds: [0x108b, 0x108c, 0x1179, 0x11b5, 0x1156],
    channel: [{ usagePage: 0xffb1 }, { usagePage: 0xffb2 }],
    steps: [{
      request: pad([0x05, 0x01, 0x00, 0x1a], 64),
      parse: (f) => (f.length < 10 || f[1] !== 0x01 || f[2] !== 0x00 ? null
        : f[8] === 0 || f[8] > 100 ? OFFLINE : { capacity: f[8], charging: f[9] > 0 }),
    }],
  },
  ...[[0x3434, 'Keychron Ultra-Link 8K', [0xd028]], [0x362d, 'SKN Ultra-Link 8K', [0xd028]],
    // VGN's "vgn-kc2" mice read the same b3 06 (its web driver; vendor driver decoded): cables and receivers.
    [0x391d, 'VGN (Keychron platform)', [0x103c, 0x103d, 0x1045, 0x1023, 0x1024, 0x1042, 0x1043, 0x1025, 0x1026, 0x1a35, 0x1a36, 0x1a3e, 0x1a20, 0x1a21, 0x1a3b, 0x1a3c, 0x1a22, 0x1a23]],
  ].map(([vendorId, name, productIds]) => ({
    // Keychron's 8K receiver, also sold under Keychron's SKN brand (issue #164). From the Linux
    // keychron-battery-dkms module and HaloBattery issue #373, checked there on a real M6 8K:
    // output report b3 06 on 0xFFC1, the reply b4 06 ... holds level | 0x80 (charging) at byte 20.
    // Windows refuses it as a feature report. Keyboards behind the receiver may not answer.
    name, kind: 'mouse', vendorId, productIds,
    channel: { usagePage: 0xffc1, usage: 0x01 },
    steps: [{
      request: pad([0xb3, 0x06], 64),
      parse: (f) => (f.length < 21 || f[0] !== 0xb4 || f[1] !== 0x06 ? null
        : (f[20] & 0x7f) === 0 || (f[20] & 0x7f) > 100 ? OFFLINE : { capacity: f[20] & 0x7f, charging: f[20] >= 0x80 }),
    }],
  })),
  {
    // Razer BlackShark V3 and V3 Pro, cable and dongle (issue #21). openrazer PR 2794 (from Synapse
    // captures), secbird (checked on a V3 Pro, both PIDs) and Joule (checked on a V3) agree:
    // output report 2 on 0xFF14, 64 bytes, XOR of bytes 0-61 in byte 62:
    //   02 00 60 00 00 00 04 00 00 80 21 00 00 ... <xor>    class 0x21 = battery
    //   reply 02 02 60 00 00 00 05 00 00 80 21 01 01 <level> (01 = reply, 02 = the headset's own push)
    // 0xff means the radio link isn't up. Asking every ~2 s is reported to drop the link; our poll
    // is a minute by default and never under 10 s.
    name: 'Razer BlackShark V3', kind: 'headset', vendorId: 0x1532, productIds: [0x0576, 0x0577, 0x0579, 0x057a],
    channel: { usagePage: 0xff14, usage: 0x01 },
    steps: [{
      request: razerHeadsetRequest(0x21),
      parse: (f) => (f.length < 14 || f[0] !== 0x02 || f[1] !== 0x02 || f[2] !== 0x60 || f[9] !== 0x80
        || f[10] !== 0x21 || (f[11] !== 0x01 && f[11] !== 0x02) || f[12] !== 0x01 ? null
        : f[13] === 0 || f[13] > 100 ? OFFLINE : { capacity: f[13] }),
    }],
  },
  {
    // The X9's protocol behind a C-Media dongle (HeadsetControl mchose_v9_pro, issue #43).
    name: 'MCHOSE V9 PRO', kind: 'headset', vendorId: 0x291d, productIds: [0x385d],
    channel: { usagePage: 0xff90 },
    steps: [{ request: pad([0x55, 0x65, 0x01], 64), parse: mchoseStatus }],
  },
  {
    name: 'Logitech G633, G733, G933', kind: 'headset', vendorId: LOGITECH, productIds: [0x0a5c, 0x0a89, 0x0a5b, 0x0a87, 0x0ab5, 0x0afe, 0x0b1f],
    channel: LOGITECH_CHANNEL, steps: [hidppVoltageStep([0x08, 0x0a], G633_CURVE)],
  },
  {
    name: 'Logitech G533', kind: 'headset', vendorId: LOGITECH, productIds: [0x0a66],
    channel: { ...LOGITECH_CHANNEL, interface: 3 }, steps: [hidppVoltageStep([0x07, 0x01], G533_CURVE)],
  },
  {
    name: 'Logitech G535', kind: 'headset', vendorId: LOGITECH, productIds: [0x0ac4],
    // HeadsetControl writes to the media-key collection, which Windows refused on one PC (issue
    // #143, "Cannot write to hid device"); the HID++ long collection comes first.
    channel: [LOGITECH_CHANNEL, { usagePage: 0x0c, usage: 0x01, interface: 3 }], steps: [hidppVoltageStep([0x05, 0x0d], G535_CURVE)],
  },
  {
    name: 'Logitech G PRO', kind: 'headset', vendorId: LOGITECH, productIds: [0x0aa7, 0x0aaa, 0x0aba, 0x0afb, 0x0afc],
    channel: LOGITECH_CHANNEL, steps: [hidppVoltageStep([0x06, 0x0d], GPRO_CURVE)],
  },

  {
    // FIFINE HT6 (HeadsetControl fifine_ht6.hpp, PR #628 on hardware): the MCHOSE X9 protocol.
    name: 'FIFINE HT6', kind: 'headset', vendorId: 0x3142, productIds: [0x00c3],
    channel: { usagePage: 0xff90, usage: 0x01 },
    steps: [{ request: pad([0x55, 0x65, 0x01, 0x00], 64), parse: mchoseStatus }],
  },
  {
    // Corsair HS80 RGB Wireless (0a69) and Virtuoso RGB Wireless XT (0a62) on their cable answer for
    // themselves (target 0x08): HaloBattery for the HS80, HeadsetControl corsair_virtuoso_xt resolveTarget.
    name: 'Corsair HS80 RGB, Virtuoso XT (cable)', kind: 'headset', wired: true, vendorId: 0x1b1c, productIds: [0x0a69, 0x0a62],
    channel: { usagePage: 0xff42, usage: 0x01 },
    steps: [bragiStep([], BRAGI_RECEIVER, 0x0f, bragiBattery)],
  },
  {
    // Corsair SABRE v3 PRO (issue #249), Slipstream V2: 00 <endpoint> 01 01 02 0F, 513 bytes to the
    // receiver (endpoint 1), 65 on the cable (endpoint 0); reply <endpoint> .. 01 02 <status> <lo> <hi>,
    // tenths. HaloBattery corsair.py sabre_v3 (#543: 01 00 01 02 00 ac 03 = 94 %).
    name: 'Corsair SABRE v3 PRO', kind: 'mouse', vendorId: 0x1b1c, productIds: [0x2b42],
    channel: { usagePage: 0xff42, usage: 0x01 },
    steps: [{ request: pad([0x00, 0x01, 0x01, 0x01, 0x02, 0x0f], 513), parse: slipstreamV2(0x01) }],
  },
  {
    name: 'Corsair SABRE v3 PRO (cable)', kind: 'mouse', wired: true, vendorId: 0x1b1c, productIds: [0x2b43],
    channel: { usagePage: 0xff42, usage: 0x01 },
    steps: [{ request: pad([0x00, 0x00, 0x01, 0x01, 0x02, 0x0f], 65), parse: slipstreamV2(0x00) }],
  },
  {
    name: 'Razer BlackShark V2 HyperSpeed, Kraken V4 (dongle)', kind: 'headset', vendorId: 0x1532, productIds: [0x0565, 0x056c],
    channel: { usagePage: 0xff14, usage: 0x01 },
    steps: [razerMediaTek(0x80)],
  },
  {
    // On the cable; the V2 HyperSpeed's dongle goes quiet while it is plugged in. 0567 is the Kraken V4
    // Pro headset on its cable (Sebax95's detector, the same frame Synapse sends); its dock is left out.
    name: 'Razer BlackShark V2 HyperSpeed, Kraken V4, Kraken V4 Pro (cable)', kind: 'headset', vendorId: 0x1532, productIds: [0x056e, 0x056b, 0x0567],
    channel: { usagePage: 0xff14, usage: 0x01 },
    steps: [razerMediaTek(0x00)],
  },
  {
    // Razer BlackShark V2 Pro (2020) and Nari: the Avnera exchange (HaloBattery blackshark2020.py with
    // real frames; Modzeleczek/RazerNariBatteryLevel). Reply FF 0F 05 FE ...: byte 11 power state
    // (09 charging, 06 charge complete), 12-13 millivolts big-endian, 0 when off.
    name: 'Razer BlackShark V2 Pro (2020), Nari', kind: 'headset', vendorId: 0x1532, productIds: [0x0528, 0x051c],
    channel: { usagePage: 0xff00, usage: 0x01 },
    steps: [avneraStep([0xff, 0x0a, 0x00, 0xfd, 0x04, 0x12, 0xf1, 0x02, 0x05], (f) => {
      if (f.length < 14 || f[0] !== 0xff || f[1] !== 0x0f || f[3] !== 0xfe) return null;
      const mv = (f[12] << 8) | f[13];
      if (mv === 0) return OFFLINE;
      if (f[11] === 0x06) return { capacity: 100, charging: false, voltageMv: mv };
      return { capacity: fromVoltage(mv, LI_ION), charging: f[11] === 0x09, voltageMv: mv };
    }, { wait: 100 })],
  },
  {
    // Razer BlackShark V3 X HyperSpeed, dongle and cable (HaloBattery blackshark_v3x.py, #280 on
    // hardware; everyoneexe/blackshark-linux PROTOCOL.md): feature report 7 on 0xFF82 only, XOR of
    // bytes 3-60 in byte 62. Command 0x80 is the level, 0x84 charging; byte 1 = 0x01 means busy.
    name: 'Razer BlackShark V3 X HyperSpeed', kind: 'headset', vendorId: 0x1532, productIds: [0x057d, 0x057c],
    channel: { usagePage: 0xff82, usage: 0x01 },
    steps: [blackSharkV3x(0x80, (v) => (v >= 1 && v <= 100 ? { capacity: v } : OFFLINE)), blackSharkV3x(0x84, (v) => ({ charging: v === 1 }))],
  },
  {
    // ASUS ROG Strix Go 2.4 (HaloBattery asus.py, frames from its #190 reporter): the Avnera exchange,
    // millivolts at 11-12, byte 9 0x0A charging, in Armoury Crate's steps.
    name: 'ASUS ROG Strix Go 2.4', kind: 'headset', vendorId: 0x0b05, productIds: [0x18d6],
    steps: [avneraStep([0xff, 0x08, 0x00, 0xfd, 0x04, 0x12, 0xf1, 0x03, 0x52, 0x01], strixGo, { wait: 35, tries: 3 })],
  },
  {
    name: 'ASUS ROG Strix Go 2.4 (cable)', kind: 'headset', wired: true, vendorId: 0x0b05, productIds: [0x18d7],
    steps: [avneraStep([0xff, 0x08, 0x00, 0xfd, 0x04, 0x12, 0xf1, 0x03, 0x52, 0x01], (f) => {
      const reading = strixGo(f);
      return reading && !reading.offline ? { ...reading, charging: true } : reading;
    }, { wait: 35, tries: 3 })],
  },
  {
    // ASUS TUF Gaming H3 Wireless (HaloBattery asus.py, its maintainer's headset: 3904 mV = 75 % in
    // Armoury Crate): FF 12 05 FE ... byte 9 0x05 charging / 0x03 battery / 0x0A no information yet.
    name: 'ASUS TUF Gaming H3 Wireless', kind: 'headset', vendorId: 0x0b05, productIds: [0x1963],
    steps: [avneraStep([0xff, 0x07, 0x00, 0xfd, 0x04, 0x0c, 0xf1, 0x02, 0x01], (f) => {
      if (f.length < 13 || f[0] !== 0xff || f[1] !== 0x12 || f[3] !== 0xfe || f[9] === 0x0a) return null;
      const mv = f[11] | (f[12] << 8);
      if (mv < MV_MIN || mv > MV_MAX) return mv === 0 ? OFFLINE : null;
      return { capacity: Math.min(100, Math.ceil(fromVoltage(mv, LI_ION) / 25) * 25), charging: f[9] === 0x05, voltageMv: mv };
    }, { wait: 50, tries: 4 })],
  },
  {
    // HyperX Cloud Core Wireless (HyperHeadset issue #59, the owner's Windows logs; HaloBattery
    // hyperx_cloud_core.py): only millivolts, so the level is the Cloud Flight's curve. The answer
    // lives about 30 ms, so it is read often.
    name: 'HyperX Cloud Core Wireless', kind: 'headset', vendorId: KINGSTON, productIds: [0x173f, 0x1740],
    channel: { usagePage: 0xff00, usage: 0x01 },
    steps: [avneraStep([0xff, 0x07, 0x00, 0xfd, 0x04, 0x0c, 0xf1, 0x02, 0x01, 0x04, 0xf0, 0x0c], (f) => {
      if (f.length < 13 || f[0] !== 0xff || f[1] !== 0x12 || f[3] !== 0xfe) return null;
      const mv = f[11] | (f[12] << 8);
      if (mv < MV_MIN || mv > MV_MAX) return mv === 0 ? OFFLINE : null;
      return { capacity: fromVoltage(mv, CLOUD_FLIGHT_CURVE), charging: f[9] === 0x05, voltageMv: mv };
    }, { wait: 20, tries: 8 })],
  },
  {
    // HyperX Cloud Alpha 2 Wireless (HeadsetControl hyperx_cloud_alpha_2_wireless.hpp, PR #590 on
    // Windows 11; HaloBattery): 52 01 asks if the headset is on (53 01 <on>), 50 02 for the battery
    // (51 02 <level> <charging>).
    name: 'HyperX Cloud Alpha 2 Wireless', kind: 'headset', vendorId: HP, productIds: [0x08be],
    channel: { usagePage: 0xff13, usage: 0xff00 },
    steps: hyperxAlpha2Steps(),
  },
  {
    // SteelSeries Arctis Nova Pro Omni (HeadsetControl PR #584, Windows) and Nova Elite (HaloBattery
    // #138: 31 % = GG): 01 B0 as report 1; level at 6, status at 15 (01 off, 02 charging, 08 on).
    // The Elite reports 0 % when the headset is off.
    name: 'SteelSeries Arctis Nova Pro Omni, Nova Elite', kind: 'headset', vendorId: STEELSERIES, productIds: [0x2290, 0x2244],
    channel: { usagePage: 0xffc0, usage: 0x01, interface: 3 },
    steps: [{
      request: pad([0x01, 0xb0], 64),
      parse: (f) => (f.length < 16 || f[0] !== 0x01 || f[1] !== 0xb0 ? null
        : f[6] > 100 ? null : f[15] === 0x01 || f[6] === 0 ? OFFLINE : { capacity: f[6], charging: f[15] === 0x02 }),
    }],
  },
  {
    // SteelSeries Arctis GameBuds (HeadsetControl steelseries_arctis_gamebuds.hpp; Arctis-Sound-Manager,
    // confirmed by a USB capture): 00 B0 -> B0 .. .. <left state> <right state> <left %> <right %>,
    // state 2 docked, 3 out of the case. The card shows the lower bud out of the case (HeadsetControl
    // counts only those); both docked reads as off.
    name: 'SteelSeries Arctis GameBuds', kind: 'headset', vendorId: STEELSERIES, productIds: [0x230a],
    channel: NOVA_CHANNEL,
    steps: [{
      request: STATUS_REQUEST,
      parse(f) {
        if (f.length < 7 || f[0] !== 0xb0) return null;
        const buds = [[f[3], f[5]], [f[4], f[6]]].filter(([state, level]) => state === 3 && level >= 1 && level <= 100);
        return buds.length ? { capacity: Math.min(...buds.map(([, level]) => level)), charging: false } : OFFLINE;
      },
    }],
  },
  {
    // Logitech G325 LIGHTSPEED (HeadsetControl #581, the owner's capture against G HUB; HaloBattery
    // #232): 50 23 0B 00 03 1A 00 03 00 07 0A, then 50 23 0B 00 03 10 00 06 00 07 0A <raw> <G HUB %> <state>.
    name: 'Logitech G325', kind: 'headset', vendorId: LOGITECH, productIds: [0x0b21],
    channel: LOGITECH_CENTURION,
    steps: [{
      request: pad([0x50, 0x23, 0x0b, 0x00, 0x03, 0x1a, 0x00, 0x03, 0x00, 0x07, 0x0a], 64),
      parse: (f) => (f.length < 14 || f[0] !== 0x50 || f[1] !== 0x23 || f[2] !== 0x0b || f[5] !== 0x10 || f[9] !== 0x07 ? null
        : f[12] >= 1 && f[12] <= 100 ? { capacity: f[12], charging: f[13] === 0x02 } : null),
    }],
  },
  {
    // Logitech G PRO X 2 LIGHTSPEED, HeadsetControl's fixed-index request (buildLegacyBatteryRequest,
    // parseLegacyBatteryResponse, isLegacyPowerOffPacket). 51 03 is the acknowledgement.
    name: 'Logitech G PRO X 2', kind: 'headset', vendorId: LOGITECH, productIds: [0x0af7],
    channel: LOGITECH_CENTURION,
    steps: [{
      request: pad([0x51, 0x08, 0x00, 0x03, 0x1a, 0x00, 0x03, 0x00, 0x04, 0x0a], 64),
      parse(f) {
        if (f.length < 13 || f[0] !== 0x51) return null;
        if (f[1] === 0x05 && f[6] === 0x00) return OFFLINE;
        if (f[1] !== 0x0b || f[8] !== 0x04) return null;
        return f[10] >= 1 && f[10] <= 100 ? { capacity: f[10], charging: f[12] === 0x02 } : null;
      },
    }],
  },
  {
    // Jabra Link 390 (HeadsetControl PR #632, 2e51 on Windows) and Link 380 (PR #596, 24c7).
    name: 'Jabra Link 390', kind: 'headset', vendorId: 0x0b0e, productIds: [0x2e50, 0x2e51, 0x2e56, 0x2e57],
    channel: { usagePage: 0xff00, usage: 0x05 }, steps: [jabraStep(0x04)],
  },
  {
    name: 'Jabra Link 380', kind: 'headset', vendorId: 0x0b0e, productIds: [0x24c7, 0x24c8, 0x24c9, 0x24ca, 0x24e9],
    channel: { usagePage: 0xff00, usage: 0x01 }, steps: [jabraStep(0x04)],
  },
  {
    // On their own USB: Evolve3 75 (HeadsetControl PR #632, 2548 on Windows), Evolve2 65 Flex (2519).
    name: 'Jabra Evolve3 75', kind: 'headset', vendorId: 0x0b0e, productIds: [0x2546, 0x2547, 0x2548],
    channel: { usagePage: 0xff00, usage: 0x05 }, steps: [jabraStep(0x08)],
  },
  {
    name: 'Jabra Evolve2 65 Flex', kind: 'headset', vendorId: 0x0b0e, productIds: [0x2517, 0x2518, 0x2519],
    channel: { usagePage: 0xff00, usage: 0x01 }, steps: [jabraStep(0x08)],
  },
  {
    // Lenovo Wireless VoIP Headset (HeadsetControl lenovo_wireless_voip.hpp, PR #497): feature report
    // 24 01, answered as input 27 01 <error> .. .. .. .. <level>.
    name: 'Lenovo Wireless VoIP Headset', kind: 'headset', vendorId: 0x17ef, productIds: [0xa07d],
    channel: { usagePage: 0xff07, usage: 0x0222 },
    steps: [{
      via: 'feature-input', request: pad([0x24, 0x01], 61),
      parse: (f) => (f.length < 8 || f[0] !== 0x27 || f[1] !== 0x01 ? null : f[2] !== 0 ? OFFLINE
        : f[7] >= 1 && f[7] <= 100 ? { capacity: f[7] } : null),
    }],
  },
  {
    // Plantronics / Poly BT600 dongle with a Voyager headset (HeadsetControl plantronics_bt600.hpp,
    // PR #536 checked live; HaloBattery #328 = Poly's app). Each read replays the attach first (it
    // changes nothing), then asks for the battery: level out of <count - 1> steps.
    name: 'Poly BT600 (Voyager headsets)', kind: 'headset', vendorId: 0x047f, productIds: [0x02ee, 0x02f7],
    channel: { usagePage: 0xffa2, usage: 0x03 },
    steps: [
      { noReply: true, wait: 100, request: [0x06, 0x01], parse: () => null },
      { noReply: true, wait: 150, request: pad([0x07, 0x01, 0x01, 0x10, 0x07, 0x00, 0x00, 0x00, 0x01, 0x01, 0x02], 64), parse: () => null },
      { noReply: true, wait: 150, request: pad([0x07, 0x01, 0x01, 0x10, 0x07, 0x20, 0x00, 0x00, 0x01, 0x01, 0x02], 64), parse: () => null },
      {
        request: pad([0x07, 0x01, 0x01, 0x10, 0x06, 0x20, 0x00, 0x00, 0x02, 0x0a, 0x1a], 64),
        parse(f) {
          if (f.length < 14 || f[0] !== 0x07 || f[1] !== 0x01 || f[2] !== 0x01 || f[3] !== 0x10) return null;
          if (f[8] !== 0x03 || f[9] !== 0x0a || f[10] !== 0x1a || f[12] < 2) return null;
          return { capacity: clampPercent(Math.round((f[11] / (f[12] - 1)) * 100)), charging: f[13] !== 0 };
        },
      },
    ],
  },
  {
    // JBL Quantum 810 and 910 (Visner-org/jbl-quantum-battery, tested): two read-only feature reports,
    // 0x68 = headset on, 0x49 = level in 5 % steps (kept from before when off, so 0x68 comes first).
    name: 'JBL Quantum 810, 910', kind: 'headset', vendorId: 0x0ecb, productIds: [0x2069, 0x2088],
    channel: { usagePage: 0xff13 },
    steps: [
      { via: 'feature', reportId: 0x68, length: 2, wait: 0, tries: 1, parse: (f) => (f[0] !== 0x68 ? null : f[1] === 1 ? {} : OFFLINE) },
      { via: 'feature', reportId: 0x49, length: 2, wait: 0, tries: 1, parse: (f) => (f[0] !== 0x49 || f[1] < 1 || f[1] > 100 ? null : { capacity: f[1] }) },
    ],
  },

  {
    // SteelSeries Apex Pro TKL Wireless (2023) and Apex Pro Mini Wireless dongles (GUHPY/SteelSeries-OpenGG
    // ApexProtocol.cs, aw2p/APEX protocol.py; replies seen on hardware): BC asks if the keyboard is
    // linked (BC 01), D2 for the battery, in the Aerox's 5 % steps (OpenGG notes the scale is unchecked).
    name: 'SteelSeries Apex Pro Wireless', kind: 'keyboard', vendorId: STEELSERIES, productIds: [0x1644, 0x1624],
    channel: { usagePage: 0xffc0, usage: 0x01, interface: 3 },
    steps: [
      { request: pad([0x00, 0xbc], 65), parse: (f) => (f.length < 2 || f[0] !== 0xbc ? null : f[1] === 0x01 ? {} : OFFLINE) },
      { request: pad([0x00, 0xd2], 65), parse: (f) => (f.length < 2 || f[0] !== 0xd2 ? null : aeroxBattery(f)) },
    ],
  },
  {
    name: 'SteelSeries Apex Pro TKL Wireless (cable)', kind: 'keyboard', wired: true, vendorId: STEELSERIES, productIds: [0x1646],
    channel: { usagePage: 0xffc0, usage: 0x01, interface: 3 },
    steps: [{ request: pad([0x00, 0x92], 65), parse: (f) => (f.length < 2 || f[0] !== 0x92 ? null : aeroxBattery(f)) }],
  },

  // Mice
  {
    // ATK "Hechi" mice (ATK's web hub, class Fr; vendor driver decoded, not hardware-confirmed): output
    // report 0B. 0B 14 asks if the mouse is awake (byte 4 = 0: asleep or off), 0B 13 for its info: byte 17
    // charging, 18 the level. ATK A9 PRO MAX 1147, its 1K dongle 1148 and 8K dongle 1196.
    name: 'ATK A9 PRO MAX (Hechi)', kind: 'mouse', vendorId: 0x373b, productIds: [0x1147, 0x1148, 0x1196],
    channel: { usagePage: 0xffa0, usage: 0x02 },
    steps: [
      { request: pad([0x0b, 0x14], 64), parse: (f) => (f.length < 5 || f[0] !== 0x0b || f[1] !== 0x14 ? null : f[4] === 0 ? OFFLINE : {}) },
      { request: pad([0x0b, 0x13], 64), parse: (f) => (f.length < 19 || f[0] !== 0x0b || f[1] !== 0x13 || f[18] < 1 || f[18] > 100 ? null : { capacity: f[18], charging: f[17] === 1 }) },
    ],
  },
  {
    // ATK "Waizowl" mice (ATK's web hub, class Qr; vendor driver decoded, not hardware-confirmed): report
    // 2, 0E 81 01 = get control data; byte 5 the level, 6 the state (1 charging, 2 asleep or not linked).
    // ATK's hub sends and reads it as FEATURE report 2 (class I$ promiseRun: sendFeatureReport, then
    // receiveFeatureReport); it checks only the command id, byte 3. ATK Duckbill ELITE 1282, 8K dongle 1283.
    name: 'ATK Duckbill ELITE (Waizowl)', kind: 'mouse', vendorId: 0x373b, productIds: [0x1282, 0x1283],
    channel: { usagePage: 0xff02, usage: 0x02 },
    steps: [{
      via: 'feature', request: pad([0x02, 0x0e, 0x81, 0x01], 64), reportId: 0x02, length: 64, wait: 20, tries: 5,
      parse: (f) => (f.length < 7 || f[0] !== 0x02 || f[3] !== 0x01 ? null
        : f[6] === 2 ? OFFLINE : f[5] < 1 || f[5] > 100 ? null : { capacity: f[5], charging: f[6] === 1 }),
    }],
  },
  {
    // MCHOSE's newer mice (M HUB newMouseFilters; vendor driver decoded, MyFinder implements it, not
    // hardware-confirmed): output report 4D 01 01 00 00 09 00 00 08 = read device info; the reply echoes
    // 00 09 at 4-5, byte 19 charge state, 20 the level (0 = not linked), FF at 8 = not ready yet.
    name: 'MCHOSE A5 V3, A7 V3, K7 V2, R7 Ultra, V7 Pro, G3 V3', kind: 'mouse', vendorId: 0x3837,
    productIds: [0x1014, 0x1016, 0x1018, 0x101c, 0x101d, 0x4026, 0x4027, 0x4028, 0x4029, 0x402a, 0x4030, 0x4031, 0x4032, 0x4033, 0x4034, 0x4035, 0x4037, 0x4038, 0x403a, 0x403b, 0x403d, 0x403e, 0x4041],
    channel: [{ usagePage: 0xff01 }, { usagePage: 0xff0b }],
    steps: [{
      request: pad([0x4d, 0x01, 0x01, 0x00, 0x00, 0x09, 0x00, 0x00, 0x08], 64),
      parse: (f) => (f.length < 21 || f[0] !== 0x4d || f[4] !== 0x00 || f[5] !== 0x09 || f[8] === 0xff ? null
        : f[20] === 0 || f[20] > 100 ? null : { capacity: f[20], charging: f[19] === 1 }), // M HUB retries a 0 before calling it off
    }],
  },
  {
    // VGN "ldMs" mice (VGN's web driver, class Wr; vendor driver decoded, not hardware-confirmed): report
    // A0, A0 02 25 = power, level at byte 3. Dragonfly F1 V2 Extreme 101b / receiver 1a18, Falcon3 Extreme
    // 102e / 1a2a, Falcon3 Extreme+ 1037 / 1a29.
    name: 'VGN Dragonfly F1 V2 Extreme, Falcon3 Extreme', kind: 'mouse', vendorId: 0x391d, productIds: [0x101b, 0x1a18, 0x102e, 0x1a2a, 0x1037, 0x1a29],
    channel: { usagePage: 0xffa0, usage: 0x02 },
    steps: [{ request: pad([0xa0, 0x02, 0x25], 33), parse: (f) => (f.length < 4 || f[0] !== 0xa0 || f[1] !== 0x02 || f[2] !== 0x25 || f[3] < 1 || f[3] > 100 ? null : { capacity: f[3] }) }],
  },
  {
    // VGN "king" mice (VGN's web driver, class Zd; vendor driver decoded, not hardware-confirmed): report
    // 0x20 with the user-config read 08; the reply echoes 08 at byte 8, the level at 17.
    name: 'VGN (king)', kind: 'mouse', vendorId: 0x372e, productIds: [0x10ac, 0x10ad],
    channel: { usagePage: 0xff10, usage: 0x10 },
    steps: [vgnKing()],
  },
  {
    name: 'VGN (king)', kind: 'mouse', vendorId: 0x9981, productIds: [0x6002, 0x7002],
    channel: { usagePage: 0xff10, usage: 0x10 },
    steps: [vgnKing()],
  },
  {
    // Pulsar's Sonix "Fusion2" dongles and mice (pulsar-mouse-linux feinmann8k.py, xlite_v4_wireless.py,
    // fusion2_8k_dongle.py, x3.py; on hardware: dongle 88 %, X3 on its cable 87 % and charging): feature
    // report 0 on interface 3, register 08/81 read with a 16-bit sum at the end; level at byte 6 (7 with
    // the report id), FF = the dongle has no mouse; register 83 gives charging.
    name: 'Pulsar Xlite V4, X3, Feinmann (Fusion2)', kind: 'mouse', vendorId: 0x3710, productIds: [0x5402, 0x5403, 0x5404, 0x3401, 0x3409, 0x3410],
    channel: { interface: 3 },
    steps: [pulsarFusion2(0x81, (v) => (v === 0xff ? OFFLINE : v >= 1 && v <= 100 ? { capacity: v } : null)), pulsarFusion2(0x83, (v) => ({ charging: v === 1 }))],
  },
  {
    // Zebronics' Compx receiver 3554:fc0a doesn't speak the VXE frame: it keeps the level in feature
    // report 6, 06 00 02 00 <counter> <percent> 14 80 (TaskbarVitals zebronics.cpp, a local capture).
    name: 'Zebronics receiver', kind: 'mouse', vendorId: 0x3554, productIds: [0xfc0a],
    channel: { usagePage: 0xff02, usage: 0x02 },
    steps: [{ via: 'feature', reportId: 0x06, length: 8, wait: 0, tries: 2, parse: (f) => (f.length < 6 || f[0] !== 0x06 || f[5] < 1 || f[5] > 100 ? null : { capacity: f[5] }) }],
  },
  {
    // Darmoshark N5 on its cable (HaloBattery #430, 63 %): the receiver's 41 00 81 01 as 01 00 81 01,
    // so the last byte is 0x1E to keep the frame's sum at 0xA1 (the receiver 1915:0723 is on the OGM entry).
    name: 'Darmoshark N5 (cable)', kind: 'mouse', wired: true, vendorId: 0x1915, productIds: [0x073c],
    channel: { usagePage: 0xff0a, usage: 0x01 },
    steps: [{ request: nordicRequest(0x01, 0x1e), parse: nordicBattery }],
  },
  {
    // SteelSeries Aerox 3 Wireless Gen 2 (rivalcfg branch device_aerox3_wireless_gen2; the #276 owner's
    // traces D2 00 61 00 = 97 %, 92 01 64 00): plain percent at byte 2, charging at 1, 0xFF = not known yet.
    name: 'SteelSeries Aerox 3 Wireless Gen 2', kind: 'mouse', vendorId: STEELSERIES, productIds: [0x1890],
    channel: { interface: 3 },
    steps: [{ request: [0x00, 0xd2], parse: aerox3Gen2(0xd2) }],
  },
  {
    name: 'SteelSeries Aerox 3 Wireless Gen 2 (cable)', kind: 'mouse', wired: true, vendorId: STEELSERIES, productIds: [0x1892],
    channel: { interface: 3 },
    steps: [{ request: [0x00, 0x92], parse: aerox3Gen2(0x92) }],
  },
  {
    // Rival 650 Wireless (rivalcfg rival650.py): the Rival 3 Wireless's request, on interface 0.
    name: 'SteelSeries Rival 650 Wireless', kind: 'mouse', vendorId: STEELSERIES, productIds: [0x1726],
    channel: { interface: 0 },
    steps: [{ request: [0x00, 0xaa, 0x01], parse: (f) => (f.length < 3 ? null : f[0] === 0 || f[0] > 100 ? OFFLINE : { capacity: f[0], charging: !!f[2] }) }],
  },
  {
    // The Rival 650 on its cable (172b): the same request; a silent read isn't the mouse being off.
    name: 'SteelSeries Rival 650 Wireless (cable)', kind: 'mouse', wired: true, vendorId: STEELSERIES, productIds: [0x172b],
    channel: { interface: 0 },
    steps: [{ request: [0x00, 0xaa, 0x01], parse: (f) => (f.length < 3 || f[0] === 0 || f[0] > 100 ? null : { capacity: f[0], charging: !!f[2] }) }],
  },
  {
    // Rival Pro (rivalcfg PR #294, captured from GG and tested by its author): 92 00 <mouse %> ...
    name: 'SteelSeries Rival Pro', kind: 'mouse', vendorId: STEELSERIES, productIds: [0x1880],
    channel: { interface: 2 },
    steps: [{ request: [0x00, 0x92], parse: (f) => (f.length < 3 || f[0] !== 0x92 || f[2] < 1 || f[2] > 100 ? null : { capacity: f[2] }) }],
  },
  ...asusMice(),
  {
    // HyperX Pulsefire Haste 2 Wireless and Haste 2 Core Wireless (NGENUITY's protocol; fuyue521's notes,
    // level = NGENUITY on 0ab5 and 0f98; HaloBattery hyperx_ngenuity.py): the Cloud Alpha 2's two steps
    // on 0xFF00/0x0001.
    name: 'HyperX Pulsefire Haste 2 Wireless', kind: 'mouse', vendorId: HP, productIds: [0x0f98, 0x0d97, 0x0ab5],
    channel: { usagePage: 0xff00, usage: 0x01 },
    steps: hyperxAlpha2Steps(),
  },
  {
    // HyperX Pulsefire Dart (santeri3700's reverse engineering, from captures): the heartbeat 00 51,
    // answered 51 00 00 03 <percent> <charging 1 / full 2>. 16e1 is the dongle, 16e2 the cable.
    name: 'HyperX Pulsefire Dart', kind: 'mouse', vendorId: KINGSTON, productIds: [0x16e1, 0x16e2],
    channel: [{ usagePage: 0xff00 }, { usagePage: 0xff13 }],
    steps: [{
      request: pad([0x00, 0x51], 65),
      parse: (f) => (f.length < 6 || f[0] !== 0x51 || f[4] < 1 || f[4] > 100 ? null : { capacity: f[4], charging: f[5] === 1 }),
    }],
  },
  {
    // MSI VERSA PRO WIRELESS (HaloBattery msi.py parse_pro_reply, tested by its reporter): 00 0D B0 01 .. 05
    // on 0x00FF/0x0001; reply byte 6 = 05, level at 8, 9 = 01 on external power.
    name: 'MSI VERSA PRO Wireless', kind: 'mouse', vendorId: 0x0db0, productIds: [0x1fc6],
    channel: { usagePage: 0x00ff, usage: 0x01 },
    steps: [{
      request: pad([0x00, 0x0d, 0xb0, 0x01, 0x00, 0x00, 0x00, 0x05], 65),
      parse: (f) => (f.length < 10 || f[6] !== 0x05 || f[8] < 1 || f[8] > 100 ? null : { capacity: f[8], charging: f[9] === 0x01 }),
    }],
  },
  {
    // NZXT Lift Elite Wireless (HaloBattery nzxt.py, a USBPcap of CAM, #148; both links confirmed):
    // 4E 02 81 00 B0, reply 4E 02 97 ...: level 16-bit at 17-18, charging bit 0 of byte 22. Silent while
    // NZXT CAM is open.
    name: 'NZXT Lift Elite Wireless', kind: 'mouse', vendorId: 0x1e71, productIds: [0x2101, 0x2129],
    channel: { usagePage: 0xffca, usage: 0x01 },
    steps: [{
      request: pad([0x4e, 0x02, 0x81, 0x00, 0xb0], 64),
      parse(f) {
        if (f.length < 27 || f[0] !== 0x4e || f[1] !== 0x02 || f[2] !== 0x97) return null;
        const level = f[17] | (f[18] << 8);
        return level >= 1 && level <= 100 ? { capacity: level, charging: !!(f[22] & 1) } : null;
      },
    }],
  },
  {
    // Cooler Master MM712 (checked by HaloBattery) and MM731 on their shared receiver 01b7 or cables
    // (syntactic-spice/coolermaster-usb-protocol, riVFerd/MM731-Controller): 46 81, reply 47 81 <model>
    // ... level at 10, charging at 11.
    name: 'Cooler Master MM712, MM731', kind: 'mouse', vendorId: 0x2516, productIds: [0x01b7, 0x0169, 0x0167],
    channel: { usagePage: 0xff0a, interface: 3 },
    steps: [{
      request: [0x00, 0x46, 0x81, 0x00],
      parse: (f) => (f.length < 12 || f[0] !== 0x47 || f[1] !== 0x81 || f[10] < 1 || f[10] > 100 ? null : { capacity: f[10], charging: !!f[11] }),
    }],
  },
  {
    // VAXEE wireless dongles (ryanlewis/mousebatt protocol.rs, stuffz/mouse-battery-monitor; HaloBattery
    // vaxee.py on an E1 Wireless): feature report 0E A5 0B 01 01 -> value at 5 in 5 % steps; 0x10 = charging.
    name: 'VAXEE wireless', kind: 'mouse', vendorId: 0x3057, productIds: [0x1001, 0x1002, 0x2001, 0x2002],
    channel: { usagePage: 0xff05 },
    steps: [vaxeeStep(0x0b, (v) => (v >= 1 && v <= 20 ? { capacity: v * 5 } : null)), vaxeeStep(0x10, (v) => ({ charging: v !== 0 }))],
  },
  {
    // CROCIRIS X7 receiver (TaskbarVitals crociris.cpp, from the vendor's WebHID hub; 97 % on hardware):
    // AA 12, reply 55 12 <len> 00 <charging> <percent> <full> <link>; link low nibble 1 = linked.
    name: 'CROCIRIS X7', kind: 'mouse', vendorId: 0x36f9, productIds: [0xaa20],
    channel: { usagePage: 0xff0a, usage: 0x01 },
    steps: [{
      request: pad([0x00, 0xaa, 0x12, 0x00, 0x00], 65),
      parse: (f) => (f.length < 8 || f[0] !== 0x55 || f[1] !== 0x12 ? null
        : (f[7] & 0x0f) !== 1 || f[5] === 0 ? OFFLINE : f[5] > 100 ? null : { capacity: f[5], charging: !!f[4] }),
    }],
  },
  {
    // DARKRIM SHADOW (TaskbarVitals docs/darkrim.md, from DARKRIM's app and hardware): a fixed request
    // with its CRC, reply FE 03 10 00 02 .. <b> at byte 11: low 7 bits percent, top bit charging.
    name: 'DARKRIM SHADOW', kind: 'mouse', vendorId: 0x3654, productIds: [0x6901],
    channel: { usagePage: 0xff02, usage: 0x02, interface: 3 },
    steps: [{
      request: pad([0x00, 0xfe, 0x03, 0x10, 0x00, 0x01, 0x00, 0x01, 0x02, 0x00, 0x01, 0x00, 0x9b, 0x15], 65),
      parse: (f) => (f.length < 12 || f[0] !== 0xfe || f[1] !== 0x03 || f[2] !== 0x10 || f[4] !== 0x02 || (f[11] & 0x7f) < 1 || (f[11] & 0x7f) > 100 ? null
        : { capacity: f[11] & 0x7f, charging: !!(f[11] & 0x80) }),
    }],
  },
  {
    // Ninjutso Sora V3 (OpenMouse's ninjutso codecs; HaloBattery: both links matched NinjaForce):
    // feature report 6, 16 bytes; 06 12 = level, 06 11 = charging; the value at byte 8.
    name: 'Ninjutso Sora V3', kind: 'mouse', vendorId: 0x093a, productIds: [0xeb02, 0xe010],
    channel: { usagePage: 0xff01 },
    steps: [ninjutsoStep(0x12, (v) => (v >= 1 && v <= 100 ? { capacity: v } : null)), ninjutsoStep(0x11, (v) => ({ charging: v === 1 }))],
  },
  {
    // Delux M800 Pro / Kmart wireless mouse receiver and cable (fuyue521 misc_mice.cpp; OpenMouse's kmart,
    // confirmed on 5b2f): feature report 0C 01 20 00 <sequence> (the sequence must change), level at 18,
    // state at 19 (1 charging, 2 full).
    name: 'Delux M800 Pro', kind: 'mouse', vendorId: 0x248a, productIds: [0x5b2f, 0x5b2e],
    channel: { usagePage: 0xff00, usage: 0x01 },
    steps: [{
      via: 'feature', request: deluxRequest, reportId: 0x0c, length: 33, wait: 50, tries: 4,
      parse: (f) => (f.length < 20 || f[0] !== 0x0c || f[2] !== 0x20 || f[18] < 1 || f[18] > 100 ? null : { capacity: f[18], charging: f[19] === 1 }),
    }],
  },
  {
    // Redragon M690 PRO receiver (OpenMouse redragon, verified on firmware 2.95/2.97; BrimDeck): feature
    // report 5, 8 bytes. 05 80 asks if the mouse is linked, 05 90 for the status: 05 90 11 <percent>.
    name: 'Redragon M690 PRO', kind: 'mouse', vendorId: 0x258a, productIds: [0x002f],
    channel: { usagePage: 0xff00, usage: 0x01, interface: 1 },
    steps: [
      { via: 'feature', request: pad([0x05, 0x80], 8), reportId: 0x05, length: 8, wait: 30, tries: 3, parse: (f) => (f[0] !== 0x05 || f[1] !== 0x80 ? null : f[2] === 1 ? {} : OFFLINE) },
      { via: 'feature', request: pad([0x05, 0x90], 8), reportId: 0x05, length: 8, wait: 30, tries: 3, parse: (f) => (f[0] !== 0x05 || f[1] !== 0x90 || f[2] !== 0x11 || f[3] < 1 || f[3] > 100 ? null : { capacity: f[3] }) },
    ],
  },
  {
    name: 'SteelSeries Rival 3 Wireless', kind: 'mouse', vendorId: STEELSERIES, productIds: [0x1830, 0x1872],
    channel: { interface: 3 },
    steps: [{ request: [0x00, 0xaa, 0x01], parse: (f) => (f.length < 3 ? null : f[0] > 100 ? OFFLINE : { capacity: f[0], charging: !!f[2] }) }],
  },
  {
    name: 'SteelSeries Aerox and Prime Wireless', kind: 'mouse', vendorId: STEELSERIES,
    productIds: [0x1838, 0x1878, 0x1852, 0x185c, 0x1860, 0x1858, 0x1874, 0x1840, 0x1848],
    channel: { interface: 3 },
    steps: [{
      request: [0x00, 0xd2],
      parse: aeroxBattery,
    }],
  },
  {
    name: 'SteelSeries Aerox and Prime Wireless (cable)', kind: 'mouse', wired: true, vendorId: STEELSERIES,
    productIds: [0x183a, 0x187a, 0x1854, 0x185e, 0x1862, 0x185a, 0x1876, 0x1842, 0x184a],
    channel: { interface: 3 },
    steps: [{ request: [0x00, 0x92], parse: aeroxBattery }],
  },
];

// An entry with `product` (a regex on the HID product string) only claims a device whose name fits:
// for ids a maker shares between products, or borrows from another company (Apple's 05ac).
// Such entries come before any entry for the same ids without one.
function find(logicalDevice) {
  const name = String(logicalDevice.product || '');
  return DEVICES.find((d) => d.vendorId === logicalDevice.vendorId && d.productIds.includes(logicalDevice.productId)
    && (!d.product || d.product.test(name))) || null;
}

module.exports = { DEVICES, find };
