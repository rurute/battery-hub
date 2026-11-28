// Isolated node-hid worker (runs as an Electron utilityProcess).
//
// node-hid is a native addon and, on this Windows setup, occasionally corrupts the process
// heap during device open/read/close (WER crash signature 0xc0000374). Running every
// node-hid call here — out of the main process — means such a crash only kills THIS worker;
// the main app detects the exit and respawns it, losing at most one poll cycle.
const { listLogicalDevices } = require('./catalog');
const { driverById } = require('./drivers');
const { expandReceivers } = require('./drivers/lightspeed');
const { capture } = require('./inspector');
const { serialize } = require('./session');

// Scans in progress, so a Cancel from the window can stop them. Messages are handled as they
// come, so a cancel arrives while the scan is still running.
const scans = new Set();

async function handle(id, cmd, args) {
  if (cmd === 'enumerate') return expandReceivers(await listLogicalDevices(), { fresh: !!(args[0] && args[0].fresh) });
  if (cmd === 'cancelCapture') {
    for (const scan of scans) scan.abort();
    return scans.size > 0;
  }
  // One read at a time per device: a read the client already gave up on may still be running.
  if (cmd === 'readBattery') {
    const [driverId, device, profile] = args;
    return serialize(device && device.id, () => driverById(driverId).readBattery(device, profile));
  }
  if (cmd === 'identify') return serialize(args[1] && args[1].id, () => driverById(args[0]).identify(args[1]));
  if (cmd === 'capture') {
    const scan = new AbortController();
    scans.add(scan);
    try {
      return await capture(args[0], {
        onProgress: (frames) => process.parentPort.postMessage({ id, progress: frames }),
        signal: scan.signal,
      });
    } finally {
      scans.delete(scan);
    }
  }
  throw new Error(`unknown hid command: ${cmd}`);
}

process.parentPort.on('message', async (e) => {
  const { id, cmd, args } = e.data;
  try {
    const result = await handle(id, cmd, args || []);
    process.parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
});
