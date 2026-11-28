// Bloody (A4Tech, vendor 0x1956) wireless mice such as the R73 Pro (issue #172), as the merged Bloody
// driver of mouse_tray reads them (checked on an SG5 Pro, same layout as the R73's dump). Two feature
// reports go out on 0xFF02/0x0001 and the answer arrives as input report 6 on 0xFF01/0x0001:
//   80 00 00 00 00 00 00 7F, then 80 FF 00 00 00 00 00 80      (unnumbered, 8 bytes)
//   06 56 <percent> <cable>           percent FF = no radio link to the mouse
const session = require('../session');

const VENDOR = 0x1956;
const REQUESTS = [[0x00, 0x80, 0, 0, 0, 0, 0, 0, 0x7f], [0x00, 0x80, 0xff, 0, 0, 0, 0, 0, 0x80]];
const TIMEOUT_MS = 3000;
const REPOKE_MS = 700;

const commandChannel = (d) => d.channels.find((c) => c.usagePage === 0xff02 && c.usage === 0x01);
const statusChannel = (d) => d.channels.find((c) => c.usagePage === 0xff01 && c.usage === 0x01);

function matches(d) {
  return d.vendorId === VENDOR && !!commandChannel(d) && !!statusChannel(d);
}

function parseStatus(f) {
  if (f.length < 4 || f[0] !== 0x06 || f[1] !== 0x56) return null;
  if (f[2] === 0xff) return { offline: true };
  if (f[2] < 1 || f[2] > 100) return null;
  return { capacity: f[2], charging: f[3] === 1 && f[2] < 100 }; // on the cable at 100 it is full (mouse_tray bloody.py)
}

async function readBattery(d) {
  const command = commandChannel(d);
  const status = statusChannel(d);
  if (!command || !status) throw new Error('no command channel');
  const out = await session.acquire(command.path);
  const dev = await session.acquire(status.path); // open first: Windows keeps reports only for an open handle
  await session.readQueued(status.path, dev);
  const deadline = Date.now() + TIMEOUT_MS;
  let nextPoke = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextPoke) {
      for (const r of REQUESTS) await session.sendFeatureReport(command.path, out, r);
      nextPoke = Date.now() + REPOKE_MS;
    }
    const reading = parseStatus(await session.read(status.path, dev, 100));
    if (reading && reading.offline) throw new Error('mouse is off');
    if (reading) return reading;
  }
  throw new Error('mouse is not answering');
}

module.exports = { id: 'bloody', matches, readBattery, parseStatus };
