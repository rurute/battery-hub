// Runs the devices described in table.js.
const { exchange } = require('./exchange');
const table = require('./table');

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

async function runSteps(channel, entry, productId) {
  const reading = { charging: null };
  for (const step of entry.steps) {
    const part = await exchange(channel, step.request, (frame) => step.parse(frame, productId, reading));
    if (part.offline) throw new Error(`${entry.kind} is off`);
    Object.assign(reading, part);
  }
  if (typeof reading.capacity !== 'number') throw new Error('waiting for device to report');
  return reading;
}

async function readBattery(logicalDevice) {
  const entry = table.find(logicalDevice);
  if (!entry) throw new Error('unsupported device');
  let lastError = new Error('no command channel');
  let silent = false;
  for (const channel of channelsFor(logicalDevice, entry)) {
    try {
      return await runSteps(channel, entry, logicalDevice.productId);
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

module.exports = { id: 'tabled', matches, readBattery, channelsFor };
