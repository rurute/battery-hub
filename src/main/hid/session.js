// Long-lived HID handles, one per channel path. Everything in the worker that talks to a
// device goes through here.
//
// Do not close a handle that may have a read pending. hid_read_timeout() leaves its
// overlapped read running when it times out, and hid_close() only calls CancelIo(), which
// cancels I/O issued by the *calling* thread. node-hid reads and closes on different threads,
// so the read survives, and hid_close() frees the buffer and OVERLAPPED the kernel is still
// using. The worker has a long history of heap-corruption crashes; this defect fits them,
// though it has not been reproduced on demand.
//
// So handles stay open across polls. The one safe moment to close is straight after a read
// fails, because a failed read leaves nothing pending. Anything else is released by ending
// the process, which is why hid-client recycles the worker after a calibration scan.
//
// Reads use dev.read() rather than a 'data' listener so that reads and writes on a handle run
// one at a time through node-hid's work queue instead of alongside a background read thread.
const HID = require('node-hid');

const MAX_QUEUED_FRAMES = 64; // more than the OS input buffer holds

const sessions = new Map(); // path -> Promise<HIDAsync>
// Paths whose last read timed out: hidapi leaves that overlapped read running, so the handle must not
// be closed until a read on it comes back with data or fails.
const pending = new Set();

function acquire(path) {
  let opening = sessions.get(path);
  if (!opening) {
    opening = HID.HIDAsync.open(path);
    sessions.set(path, opening);
    opening.catch(() => { if (sessions.get(path) === opening) sessions.delete(path); });
  }
  return opening;
}

// Returns the next frame as a plain array, or [] if none arrived within timeoutMs.
async function read(path, dev, timeoutMs) {
  try {
    const frame = Array.from(await dev.read(timeoutMs));
    if (frame.length === 0) pending.add(path);
    else pending.delete(path);
    return frame;
  } catch (e) {
    pending.delete(path);
    sessions.delete(path);
    dev.close().catch(() => {});
    throw e;
  }
}

// Everything that arrived since the last poll, oldest first.
async function readQueued(path, dev) {
  const frames = [];
  while (frames.length < MAX_QUEUED_FRAMES) {
    const frame = await read(path, dev, 0);
    if (frame.length === 0) break;
    frames.push(frame);
  }
  return frames;
}

// A failed write or feature call usually means the device was unplugged, and a handle from before
// then never works again, so the next poll opens a fresh one. The old handle is closed only when no
// read is pending on it (see the top of this file); otherwise it is left for the worker's end.
function drop(path, dev) {
  sessions.delete(path);
  if (!pending.has(path)) dev.close().catch(() => {});
}

async function write(path, dev, bytes) {
  try { await dev.write(bytes); }
  catch (e) { drop(path, dev); throw e; }
}

async function getFeatureReport(path, dev, reportId, length) {
  try { return Array.from(await dev.getFeatureReport(reportId, length)); }
  catch (e) { drop(path, dev); throw e; }
}

async function sendFeatureReport(path, dev, bytes) {
  try { return await dev.sendFeatureReport(bytes); }
  catch (e) { drop(path, dev); throw e; }
}

// Runs fn after every earlier call with the same key has finished, so two reads of one device never
// overlap (a read the client gave up on keeps going here, and a second one would eat its replies).
const locks = new Map();
function serialize(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

module.exports = { acquire, read, readQueued, write, getFeatureReport, sendFeatureReport, serialize };
