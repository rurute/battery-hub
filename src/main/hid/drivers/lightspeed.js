// One Logitech Lightspeed receiver can hold several devices (a keyboard and a mouse). The receiver is
// one USB device, so the catalog sees it once; here it is split into one logical device per paired
// device, so each gets its own card. The receiver itself answers for its pairings (HID++ 1.0 register
// 0xB5) even while the devices sleep.
//
// A child's id is the receiver's id plus the device's wireless PID, never the slot, so a device that
// is paired again into another slot keeps its card.
const LOGITECH = 0x046d;
const RECEIVER_PIDS = [0xc547]; // Lightspeed receivers this is known to work on
const KINDS = { 1: 'Logitech keyboard', 2: 'Logitech mouse' };

const hasChannel = (device, usage) => device.channels.some((c) => c.usagePage === 0xff00 && c.usage === usage);

function isTarget(device) {
  return device.vendorId === LOGITECH && RECEIVER_PIDS.includes(device.productId)
    && hasChannel(device, 0x01) && hasChannel(device, 0x02);
}

// Pairing info (0xB5 0x20+n): <sub> <?> <?> <wpid hi> <wpid lo> <?> <?> <kind>
function parsePairing(params) {
  const wpid = (params[3] << 8) | params[4];
  if (!wpid) return null;
  return { wpid, kind: params[7] };
}

// Device name (0xB5 0x40+n): <sub> <length> <ASCII...>
function parseName(params) {
  const length = params[1];
  if (!length || params.length < 2 + length) return null;
  return String.fromCharCode(...params.slice(2, 2 + length));
}

const wpidHex = (wpid) => wpid.toString(16).padStart(4, '0');

function childOf(parent, { slot, wpid, kind, name }) {
  const { expanded, ...base } = parent;
  return {
    ...base,
    id: `${parent.id}:${wpidHex(wpid)}`,
    product: name || KINDS[kind] || 'Logitech device',
    receiver: { slot, wpid, kind },
  };
}

module.exports = { RECEIVER_PIDS, isTarget, parsePairing, parseName, childOf };
