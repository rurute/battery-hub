// The Xenta/Beken 2.4G receiver 1d57:fa60 (issues #20 and #73), used by Attack Shark and other
// mice. The battery isn't asked for: the receiver broadcasts it about every 2 seconds on its
// vendor interface. From Attack Shark Battery KDE (gitlab.com/gabriel17166/Attack-Shark-Battery-KDE,
// sharktray/mouse.py), checked there against the level falling with use and rising on charge:
//
//   03 e5 40 <state> <level>     state 01 on battery, 03 charging; level 0-100 (some send 03 55 40)
//   03 e5 01 00 00               sent while the link blinks: not a reading
//
// With the mouse on its cable it becomes another USB device and the receiver goes quiet, so
// silence means asleep or off, never 0%.
const session = require('../session');

const VENDOR = 0x1d57;
// fa55: another Attack Shark X11 receiver (issue #88). Only listening, so trying it is harmless.
const PRODUCTS = new Set([0xfa60, 0xfa55]);
const LISTEN_MS = 3500; // a frame every ~2 s, with room for one lost
const READ_SLICE_MS = 100;
// The broadcast comes on the receiver's own interface, not on its mouse, keyboard or media keys.
const isVendorChannel = (c) => c.usagePage !== 0x01 && c.usagePage !== 0x0c;

function matches(logicalDevice) {
  return logicalDevice.vendorId === VENDOR && PRODUCTS.has(logicalDevice.productId) && logicalDevice.channels.some(isVendorChannel);
}

function parseFrame(f) {
  // Some receivers (an Attack Shark X11 here) send 03 55 40 instead of 03 e5 40, same layout.
  if (f.length < 5 || f[0] !== 0x03 || (f[1] !== 0xe5 && f[1] !== 0x55) || f[2] !== 0x40 || f[4] > 100) return null;
  return { capacity: f[4], charging: f[3] === 0x03 };
}

// The newest reading in what's queued and what arrives while listening.
async function listen(channel) {
  const dev = await session.acquire(channel.path);
  let latest = null;
  for (const f of await session.readQueued(channel.path, dev)) latest = parseFrame(f) || latest;
  if (latest) return latest;
  const deadline = Date.now() + LISTEN_MS;
  while (Date.now() < deadline) {
    const reading = parseFrame(await session.read(channel.path, dev, READ_SLICE_MS));
    if (reading) return reading;
  }
  return null;
}

async function readBattery(logicalDevice) {
  let lastError = null;
  for (const channel of logicalDevice.channels.filter(isVendorChannel)) {
    try {
      const reading = await listen(channel);
      if (reading) return reading;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError && !/timeout/.test(lastError.message)) throw lastError;
  throw new Error('mouse is not answering');
}

module.exports = { id: 'beken', matches, readBattery, parseFrame };
