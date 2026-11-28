// Runs the devices described in table.js.
//
// A step is a request and a parser. By default the request is written as an output report and the
// answer read from input reports (exchange). A step can say otherwise:
//   via: 'feature'        sends the request (if any) as a feature report, then reads feature report
//                         `reportId` (`length` bytes) up to `tries` times, `wait` ms apart
//   via: 'feature-input'  sends the request as a feature report, then reads input reports
//   noReply: true         writes the request and waits `wait` ms: a setup frame with nothing to read
//   request               may be a function, for a frame that changes every time (a sequence number)
// An entry's fallbackSteps run when its steps got no answer at all: a second framing for a device
// whose sources disagree.
const { exchange } = require('./exchange');
const session = require('../session');
const table = require('./table');

const READ_SLICE_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The collections a table entry names, in the order named (a list is tried rule by rule); with
// none named, every vendor collection is a candidate.
function channelsFor(logicalDevice, entry) {
  const rules = entry.channel ? [].concat(entry.channel) : null;
  if (!rules) return logicalDevice.channels.filter((c) => c.usagePage >= 0xff00);
  // usage: null asks for the collection Windows gives no usage for.
  const fits = (rule, c) => (rule.usagePage === undefined || c.usagePage === rule.usagePage)
    && (rule.usage === undefined || (rule.usage === null ? c.usage == null : c.usage === rule.usage))
    && (rule.interface === undefined || c.interface === rule.interface);
  const found = [];
  for (const rule of rules) for (const c of logicalDevice.channels) if (fits(rule, c) && !found.includes(c)) found.push(c);
  return found;
}

function matches(logicalDevice) {
  const entry = table.find(logicalDevice);
  return !!entry && channelsFor(logicalDevice, entry).length > 0;
}

async function featureRead(channel, step, request, accept) {
  const dev = await session.acquire(channel.path);
  if (request) await session.sendFeatureReport(channel.path, dev, request);
  for (let i = 0; i < (step.tries || 4); i++) {
    await sleep(step.wait ?? 50);
    // hidapi hands the buffer size to Windows unpadded, and Windows wants at least the collection's
    // feature report length: a bigger buffer is fine and only the report's own bytes come back.
    const result = accept(await session.getFeatureReport(channel.path, dev, step.reportId, Math.max(step.length || 0, 65)));
    if (result !== null && result !== undefined) return result;
  }
  throw new Error('timeout waiting for battery response');
}

async function featureThenInput(channel, step, request, accept) {
  const dev = await session.acquire(channel.path);
  await session.readQueued(channel.path, dev); // a late reply to an old request is stale
  await session.sendFeatureReport(channel.path, dev, request);
  const deadline = Date.now() + (step.timeoutMs || 1500);
  while (Date.now() < deadline) {
    const frame = await session.read(channel.path, dev, READ_SLICE_MS);
    if (frame.length === 0) continue;
    const result = accept(frame);
    if (result !== null && result !== undefined) return result;
  }
  throw new Error('timeout waiting for battery response');
}

async function runStep(channel, step, productId, reading) {
  const request = typeof step.request === 'function' ? step.request() : step.request;
  const accept = (frame) => step.parse(frame, productId, reading);
  if (step.via === 'feature') return featureRead(channel, step, request, accept);
  if (step.via === 'feature-input') return featureThenInput(channel, step, request, accept);
  if (step.noReply) {
    const dev = await session.acquire(channel.path);
    await session.write(channel.path, dev, request);
    await sleep(step.wait ?? 50);
    return {};
  }
  return exchange(channel, request, accept, step.timeoutMs);
}

async function runSteps(channel, entry, steps, productId) {
  const reading = { charging: null };
  for (const step of steps) {
    const part = await runStep(channel, step, productId, reading);
    if (part.offline) throw new Error(`${entry.kind} is off`);
    Object.assign(reading, part);
  }
  if (typeof reading.capacity !== 'number') throw new Error('waiting for device to report');
  return reading;
}

async function readChannel(channel, entry, productId) {
  try {
    return await runSteps(channel, entry, entry.steps, productId);
  } catch (e) {
    if (!entry.fallbackSteps || !/^timeout/.test(e.message)) throw e;
    return runSteps(channel, entry, entry.fallbackSteps, productId);
  }
}

async function readBattery(logicalDevice) {
  const entry = table.find(logicalDevice);
  if (!entry) throw new Error('unsupported device');
  let lastError = new Error('no command channel');
  let silent = false;
  for (const channel of channelsFor(logicalDevice, entry)) {
    try {
      return await readChannel(channel, entry, logicalDevice.productId);
    } catch (e) {
      lastError = e;
      if (/^timeout/.test(e.message)) silent = true;
      if (/ is off$/.test(e.message)) break; // the dongle answered: no other channel will do better
    }
  }
  // Several of these protocols have no "off" answer: the dongle just stays silent, which
  // HeadsetControl and rivalcfg both read as the device being unavailable.
  if (silent && !entry.wired && !/ is off$/.test(lastError.message)) throw new Error(`${entry.kind} is not answering`);
  throw lastError;
}

module.exports = { id: 'tabled', matches, readBattery, channelsFor, runSteps };
