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

function razerHeadsetRequest(command) {
  const r = pad([0x02, 0x00, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x80, command], 64);
  r[62] = r.slice(0, 62).reduce((x, b) => x ^ b, 0);
  return r;
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
    name: 'SteelSeries Arctis Nova 3P/5', kind: 'headset', vendorId: STEELSERIES, productIds: [0x2269, 0x226d, 0x2232, 0x2253],
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
    name: 'HyperX Cloud Flight', kind: 'headset', vendorId: KINGSTON, productIds: [0x16c4, 0x1723],
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
    name: 'HyperX Cloud Flight S', kind: 'headset', vendorId: KINGSTON, productIds: [0x16ea, 0x16eb],
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
    name: 'HyperX Cloud III Wireless', kind: 'headset', vendorId: HP, productIds: [0x05b7, 0x0c9d],
    channel: { usagePage: 0xff13, usage: 0x01 },
    steps: [{ request: pad([0x66, 0x89], 52), parse: (f) => (f.length < 5 || f[0] !== 0x66 || f[1] !== 0x89 ? null : f[4] > 100 ? OFFLINE : { capacity: f[4] }) }],
  },
  {
    name: 'HyperX Cloud II Core Wireless', kind: 'headset', vendorId: HP, productIds: [0x0995],
    steps: [{ request: pad([0x66, 0x89], 52), parse: (f) => (f.length < 5 || f[0] !== 0x66 || f[1] !== 0x89 ? null : f[4] > 100 ? OFFLINE : { capacity: f[4] }) }],
  },
  {
    // Same project: 0c 02 03 01 00 06 on collection 0x01C0/0x0001, level at byte 6, 0xff while off
    // (issue #33).
    name: 'HyperX Cloud III S Wireless', kind: 'headset', vendorId: HP, productIds: [0x06be],
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
    productIds: [0x2a08, 0x0a97, 0x2a02],
    channel: { usagePage: 0xff42 },
    steps: [
      bragiStep([0x00], BRAGI_RECEIVER, 0x13, () => ({})),
      bragiStep([0x00], BRAGI_RECEIVER, 0x12, () => ({})),
      bragiStep([0x00], BRAGI_HEADSET, 0x12, () => ({})),
      bragiStep([0x00], BRAGI_HEADSET, 0x0f, bragiBattery),
    ],
  },
  {
    // The Slipstream receiver (issue #46) relays to its mouse or keyboard over the same Bragi
    // properties, with the same collections. OpenLinkHub (src/devices/slipstream) puts a single
    // paired device at 0x09; with several paired, this reads the first one only.
    name: 'Corsair Slipstream receiver', kind: 'mouse', vendorId: 0x1b1c,
    productIds: [0x1bdc],
    channel: { usagePage: 0xff42 },
    steps: [
      bragiStep([0x00], BRAGI_RECEIVER, 0x12, () => ({})),
      bragiStep([0x00], BRAGI_HEADSET, 0x0f, bragiBattery),
    ],
  },
  {
    // 0x0a40 is a Virtuoso SE receiver HeadsetControl doesn't list yet (issue #99); its scan shows
    // the same Bragi replies.
    name: 'Corsair Virtuoso SE and XT', kind: 'headset', vendorId: 0x1b1c,
    productIds: [0x0a3e, 0x0a3d, 0x0a40, 0x0a64],
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
      parse: (f) => (f.length >= 4 && f[0] === 0x55 && f[1] === 0x65 && f[3] === 0x02 ? { capacity: clampPercent(f[2]) } : null),
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
    // ATK X1 NearLink (issue #129), from ATK's web driver (v3-hub.atkgear.com, the Evision mouse
    // class, isEvisionWireless 0x108b/0x108c): report 5, <request code lo hi> 1a = power info. The
    // reply starts with the same request code; data from byte 7 holds the level, then charging.
    name: 'ATK X1 NearLink', kind: 'mouse', vendorId: 0x373b, productIds: [0x108b, 0x108c],
    channel: [{ usagePage: 0xffb1 }, { usagePage: 0xffb2 }],
    steps: [{
      request: pad([0x05, 0x01, 0x00, 0x1a], 64),
      parse: (f) => (f.length < 10 || f[1] !== 0x01 || f[2] !== 0x00 ? null
        : f[8] === 0 || f[8] > 100 ? OFFLINE : { capacity: f[8], charging: f[9] > 0 }),
    }],
  },
  ...[[0x3434, 'Keychron Ultra-Link 8K'], [0x362d, 'SKN Ultra-Link 8K']].map(([vendorId, name]) => ({
    // Keychron's 8K receiver, also sold under Keychron's SKN brand (issue #164). From the Linux
    // keychron-battery-dkms module and HaloBattery issue #373, checked there on a real M6 8K:
    // output report b3 06 on 0xFFC1, the reply b4 06 ... holds level | 0x80 (charging) at byte 20.
    // Windows refuses it as a feature report. Keyboards behind the receiver may not answer.
    name, kind: 'mouse', vendorId, productIds: [0xd028],
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
    steps: [{
      request: pad([0x55, 0x65, 0x01], 64),
      parse: (f) => (f.length >= 4 && f[0] === 0x55 && f[1] === 0x65 && f[3] === 0x02 ? { capacity: clampPercent(f[2]) } : null),
    }],
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

  // Mice
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

function find(logicalDevice) {
  return DEVICES.find((d) => d.vendorId === logicalDevice.vendorId && d.productIds.includes(logicalDevice.productId)) || null;
}

module.exports = { DEVICES, find };
