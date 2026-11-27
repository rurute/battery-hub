// Rapoo's second-generation VT mice (24ae:1413, 24ae:1417; issues #51, #197), as rapoo-tray
// (Iris-0109, checked on hardware), FerrisPulse and pedro3z0/rapoo-software-linux read them. The
// mouse sends input report 7 on 0xFF00/0x0002 by itself every few seconds while it moves:
//   07 <link: 0x2_ dongle, 0x1_ cable> <dpi stage> <dpi x> <dpi y> <flags> <percent> ...
// charging is bit 1 of the flags. To make it send one now, "unlock" 06 A5 A3 (33 bytes) is written on
// 0xFF00/0x000E. Feature report 0x2B is never read: on Rapoo it drops the link until a replug.
const session = require('../session');

const VENDOR = 0x24ae;
const PRODUCTS = new Set([0x1413, 0x1417]);
const UNLOCK = [0x06, 0xa5, 0xa3].concat(new Array(30).fill(0));
const TIMEOUT_MS = 4000;
const REPOKE_MS = 1000;

const statusChannel = (d) => d.channels.find((c) => c.usagePage === 0xff00 && c.usage === 0x02);
const commandChannel = (d) => d.channels.find((c) => c.usagePage === 0xff00 && c.usage === 0x0e);

function matches(d) {
  return d.vendorId === VENDOR && PRODUCTS.has(d.productId) && !!statusChannel(d);
}

function parseStatus(f) {
  if (f.length < 9 || f[0] !== 0x07) return null;
  const link = f[1] & 0xf0;
  if (link !== 0x10 && link !== 0x20) return null;
  if (f[8] < 2 || f[8] > 100) return null; // reads 0 or 1 for a moment after plugging in
  return { capacity: f[8], charging: !!(f[7] & 0x02) };
}

async function readBattery(d) {
  const status = statusChannel(d);
  if (!status) throw new Error('no status channel');
  const dev = await session.acquire(status.path);
  // The mouse also reports on its own, so the newest report waiting is a reading too.
  const queued = (await session.readQueued(status.path, dev)).map(parseStatus).filter(Boolean);
  if (queued.length) return queued[queued.length - 1];
  const command = commandChannel(d);
  const out = command ? await session.acquire(command.path) : null;
  const deadline = Date.now() + TIMEOUT_MS;
  let nextPoke = 0;
  while (Date.now() < deadline) {
    if (out && Date.now() >= nextPoke) {
      await session.write(command.path, out, UNLOCK);
      nextPoke = Date.now() + REPOKE_MS;
    }
    const reading = parseStatus(await session.read(status.path, dev, 100));
    if (reading) return reading;
  }
  throw new Error('mouse is not answering');
}

module.exports = { id: 'rapoo', matches, readBattery, parseStatus, UNLOCK };
