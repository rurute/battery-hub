// Darmoshark mice (M3 248a:ff12, issue #162) and their receivers, as darmoshark-battery
// (muriloscolari, Telink branch), darmoshark-m3-configurator and SwarlexBattery read them: feature
// report 0x51, 21 bytes, on the 0x008C/0x0001 collection.
//   51 06            read battery; reply 51 06 <1 = ok> ... byte 11 = percent (0 = no reading yet)
//   51 03            receivers want this first, and echo it back
// Only these product ids: vendor 0x248A has other Telink receivers that speak something else.
const session = require('../session');

const VENDOR = 0x248a;
const PRODUCTS = new Set([0xff10, 0xff12, 0xff18, 0xff30, 0xff31]);
const RECEIVERS = new Set([0xff30, 0xff31]);
const LENGTH = 21;
const frame = (command) => [0x51, command].concat(new Array(LENGTH - 2).fill(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const channelOf = (d) => d.channels.find((c) => c.usagePage === 0x008c && c.usage === 0x01);

function matches(d) {
  return d.vendorId === VENDOR && PRODUCTS.has(d.productId) && !!channelOf(d);
}

function parseReply(f) {
  if (f.length < 12 || f[0] !== 0x51 || f[1] !== 0x06 || f[2] !== 1) return null;
  return f[11] >= 1 && f[11] <= 100 ? { capacity: f[11] } : null;
}

async function ask(channel, dev, command) {
  await session.sendFeatureReport(channel.path, dev, frame(command));
  await sleep(80);
  return session.getFeatureReport(channel.path, dev, 0x51, LENGTH);
}

async function readBattery(d) {
  const channel = channelOf(d);
  if (!channel) throw new Error('no command channel');
  const dev = await session.acquire(channel.path);
  if (RECEIVERS.has(d.productId)) await ask(channel, dev, 0x03);
  for (let attempt = 0; attempt < 3; attempt++) {
    const reading = parseReply(await ask(channel, dev, 0x06));
    if (reading) return reading;
  }
  throw new Error('mouse is not answering');
}

module.exports = { id: 'darmoshark', matches, readBattery, parseReply };
