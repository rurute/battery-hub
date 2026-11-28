const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Replace the Electron/native-backed modules so the poller's logic runs in plain Node.
const devices = {};
const store = {
  getDevices: () => devices,
  upsertDevice: (id, patch) => { devices[id] = { ...(devices[id] || {}), ...patch, id }; return devices[id]; },
  moveDevice: (fromId, toId, patch) => {
    devices[toId] = { ...devices[fromId], ...patch, id: toId };
    delete devices[fromId];
  },
  // Only what these tests look at of store.mergeDevices: the links, and the name kept.
  mergeDevices: (keepId, dropId) => {
    const keep = devices[keepId];
    const drop = devices[dropId];
    if (!keep || !drop) return;
    devices[keepId] = {
      ...keep,
      customName: keep.customName || drop.customName || null,
      identity: keep.identity || drop.identity,
      links: [...(keep.links || []), { id: drop.id, driverId: drop.driverId, profile: drop.profile || null }, ...(drop.links || [])],
    };
    delete devices[dropId];
  },
  getPollIntervalSec: () => 60,
};
let finishRead;
const hidClient = {
  enumerate: async () => [{ id: 'mouse' }],
  readBattery: () => new Promise((resolve, reject) => { finishRead = { resolve, reject }; }),
};
const monitor = { isActive: () => false, start() {}, stopAll() {} };
// The poller takes these functions out when it loads, so tests replace driverImpl's instead.
const driverImpl = { driverById: () => ({}), detectDriver: () => null };
const drivers = { driverById: (...a) => driverImpl.driverById(...a), detectDriver: (...a) => driverImpl.detectDriver(...a) };
const system = {
  scan: async () => [], list: () => [], get: () => null, hasScanned: () => true,
  startWatching() {}, stopWatching() {}, isSystemId: (id) => /^(bt|xinput):/.test(id),
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === './store') return store;
  if (request === './hid/hid-client') return hidClient;
  if (request === './monitor') return monitor;
  if (request === './hid/drivers') return drivers;
  if (request === './system-batteries') return system;
  return load.call(this, request, ...rest);
};
const poller = require('../src/main/poller');
Module._load = load;

const { identityOf, routesOf } = require('../src/main/identity');

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const addMouse = () => { devices.mouse = { id: 'mouse', driverId: 'generic', product: 'Mouse' }; };

async function pollWithChangeMidRead(change, settle) {
  const updates = [];
  const done = poller.pollOnce((d) => updates.push(d), { force: true });
  await flush();
  change();
  settle();
  await done;
  return updates;
}

test('a reading that lands after removal does not resurrect the device', async () => {
  addMouse();
  const updates = await pollWithChangeMidRead(
    () => { delete devices.mouse; },
    () => finishRead.resolve({ capacity: 50, charging: false }),
  );
  assert.equal(devices.mouse, undefined);
  assert.equal(updates.length, 0);
});

test('a failed read that lands after removal does not resurrect the device', async () => {
  addMouse();
  await pollWithChangeMidRead(
    () => { delete devices.mouse; },
    () => finishRead.reject(new Error('timed out')),
  );
  assert.equal(devices.mouse, undefined);
});

test('a reading that lands after hiding is not broadcast', async () => {
  addMouse();
  const updates = await pollWithChangeMidRead(
    () => { devices.mouse.hidden = true; },
    () => finishRead.resolve({ capacity: 50, charging: false }),
  );
  assert.equal(updates.length, 0);
  assert.equal(devices.mouse.lastReading, undefined);
});

test('a card reads its direct connection first and falls back to Windows', async () => {
  devices.pad = { id: 'pad', driverId: 'generic', links: [{ id: 'bt:x', driverId: 'system', profile: null }] };
  const original = system.get;
  system.get = () => ({ capacity: 40, connected: true });
  hidClient.enumerate = async () => []; // the direct connection is gone
  await poller.pollOnce(() => {}, { force: true });
  system.get = original;
  hidClient.enumerate = async () => [{ id: 'mouse' }];
  assert.equal(devices.pad.lastReading.capacity, 40);
  delete devices.pad;
});

test('a card is offline only when every connection is gone', async () => {
  devices.pad = { id: 'pad', driverId: 'generic', links: [{ id: 'bt:x', driverId: 'system', profile: null }] };
  hidClient.enumerate = async () => [];
  await poller.pollOnce(() => {}, { force: true });
  hidClient.enumerate = async () => [{ id: 'mouse' }];
  assert.equal(devices.pad.online, false);
  delete devices.pad;
});

const failRead = (message) => pollWithChangeMidRead(() => {}, () => finishRead.reject(new Error(message)));

test('real read failures are counted, and a reading clears them', async () => {
  addMouse();
  await failRead('no command channel');
  await failRead('no command channel');
  assert.equal(devices.mouse.failedReads, 2);
  await pollWithChangeMidRead(() => {}, () => finishRead.resolve({ capacity: 50, charging: false }));
  assert.equal(devices.mouse.failedReads, 0);
});

test('a device that has never answered is counted, a sleeping one is not', async () => {
  addMouse();
  await failRead('timeout waiting for battery response');
  assert.equal(devices.mouse.failedReads, 1);
  devices.mouse.lastReadingAt = Date.now();
  await failRead('timeout waiting for battery response');
  assert.equal(devices.mouse.failedReads, 0);
  await failRead('mouse is off');
  assert.equal(devices.mouse.failedReads, 0);
});

test('a normal reading is still committed', async () => {
  addMouse();
  const updates = await pollWithChangeMidRead(
    () => {},
    () => finishRead.resolve({ capacity: 50, charging: false }),
  );
  assert.equal(devices.mouse.lastReading.capacity, 50);
  assert.equal(updates.length, 1);
});

test('a mouse its receiver reports as off keeps its normal look while it may only be napping', async () => {
  addMouse();
  await pollWithChangeMidRead(() => {}, () => finishRead.resolve({ capacity: 35, charging: false }));
  await failRead('mouse is off');
  assert.equal(devices.mouse.online, true, 'it answered a moment ago, so it is most likely napping');
  assert.equal(devices.mouse.failedReads, 0);
});

test('a mouse that has not answered for two minutes goes offline and keeps its last level', async () => {
  addMouse();
  await pollWithChangeMidRead(() => {}, () => finishRead.resolve({ capacity: 35, charging: false }));
  devices.mouse.lastReadingAt = Date.now() - 3 * 60000;
  await failRead('mouse is off');
  assert.equal(devices.mouse.online, false);
  assert.equal(devices.mouse.lastReading.capacity, 35);
  assert.equal(devices.mouse.failedReads, 0);
  await pollWithChangeMidRead(() => {}, () => finishRead.resolve({ capacity: 34, charging: false }));
  assert.equal(devices.mouse.online, true);
});

test('a device shown as away is not brought back by a read that only timed out', async () => {
  addMouse();
  await pollWithChangeMidRead(() => {}, () => finishRead.resolve({ capacity: 35, charging: false }));
  devices.mouse.lastReadingAt = Date.now() - 6 * 60000;
  await failRead('mouse is off');
  assert.equal(devices.mouse.online, false);
  await failRead('timeout waiting for battery response');
  assert.equal(devices.mouse.online, false, 'still away');
  assert.equal(devices.mouse.lastError, 'mouse is off');
  await failRead('Cannot write to hid device');
  assert.equal(devices.mouse.online, true, 'a different failure is reported as before');
});

test('what counts as away: headsets at once, mice and keyboards after a two-minute nap', () => {
  const now = 1_700_000_000_000;
  const ago = (minutes) => now - minutes * 60000;
  assert.equal(poller.isAway('headset is off', ago(0.1), now), true);
  assert.equal(poller.isAway('headset is not answering', ago(0.1), now), true);
  assert.equal(poller.isAway('mouse is off', ago(0.1), now), false);
  assert.equal(poller.isAway('device is not answering', ago(1.9), now), false);
  assert.equal(poller.isAway('device is not answering', ago(2), now), true);
  assert.equal(poller.isAway('mouse is off', undefined, now), true, 'never read and the receiver says off');
  assert.equal(poller.isAway('mouse is not answering', undefined, now), false, 'never read: keep it countable');
  assert.equal(poller.isAway('timeout waiting for battery response', ago(60), now), false);
  assert.equal(poller.isAway('Bluetooth reading is off in Settings', ago(60), now), false);
});

test('napping is the window between the last answer and counting as away', () => {
  const now = 1_700_000_000_000;
  const ago = (minutes) => now - minutes * 60000;
  assert.equal(poller.isNapping('mouse is off', ago(0.5), now), true);
  assert.equal(poller.isNapping('device is not answering', ago(1.9), now), true);
  assert.equal(poller.isNapping('mouse is off', ago(2), now), false, 'by now it counts as away');
  assert.equal(poller.isNapping('headset is off', ago(0.5), now), false, 'headsets do not nap');
  assert.equal(poller.isNapping('mouse is not answering', undefined, now), false, 'never answered: nothing to nap from');
  assert.equal(poller.isNapping('timeout waiting for battery response', ago(0.5), now), false);
});

test('a device that only times out stays online, since it may just be asleep', async () => {
  addMouse();
  devices.mouse.online = true;
  devices.mouse.lastReadingAt = Date.now();
  await failRead('timeout waiting for battery response');
  assert.equal(devices.mouse.online, true);
});

test('a device that stops answering through its dongle goes offline only if it answered before', async () => {
  addMouse();
  devices.mouse.online = true;
  delete devices.mouse.lastReadingAt;
  devices.mouse.failedReads = 0;
  await failRead('headset is not answering');
  assert.equal(devices.mouse.online, true, 'never read: it may not speak this protocol, so keep it countable');
  assert.equal(devices.mouse.failedReads, 1);
  await pollWithChangeMidRead(() => {}, () => finishRead.resolve({ capacity: 70, charging: false }));
  await failRead('headset is not answering');
  assert.equal(devices.mouse.online, false);
  assert.equal(devices.mouse.lastReading.capacity, 70);
  assert.equal(devices.mouse.failedReads, 0);
});

test('a refresh asked for while a check is running waits for it instead of being dropped', async () => {
  addMouse();
  const first = poller.pollOnce(() => {}, { force: true });
  await flush();
  const finishFirst = finishRead;
  let refreshed = 0;
  const second = poller.pollOnce(() => { refreshed += 1; }, { force: true });
  finishFirst.resolve({ capacity: 50, charging: false });
  await first;
  for (let i = 0; i < 80 && finishRead === finishFirst; i++) await new Promise((r) => setTimeout(r, 25));
  finishRead.resolve({ capacity: 49, charging: false });
  await second;
  assert.equal(refreshed, 1);
  assert.equal(devices.mouse.lastReading.capacity, 49);
});

test('a refresh asks the worker to list receivers afresh, a routine poll does not', async () => {
  const seen = [];
  const original = hidClient.enumerate;
  hidClient.enumerate = async (options) => { seen.push(options); return []; };
  devices.pad = { id: 'pad', driverId: 'generic' }; // not connected, so the poll lists devices again
  try {
    await poller.pollOnce(() => {}, { force: true });
    assert.ok(seen.length >= 2);
    assert.equal(seen[0] && seen[0].fresh, true);
    assert.ok(seen.slice(1).every((o) => !(o && o.fresh)));
  } finally {
    hidClient.enumerate = original;
    delete devices.pad;
  }
});

test('two cards on one receiver keep their own settings when the devices swap slots', async () => {
  const serial = '0123456789ab';
  const parentId = `1133:50503:${serial}`;
  const kb = `${parentId}:408e`;
  const ms = `${parentId}:409f`;
  const now = Date.now();
  devices[kb] = { id: kb, driverId: 'hidpp', customName: 'Desk keyboard', customIcon: '⌨️', order: 0, hidden: false, history: [{ t: now - 60000, c: 50, ch: 0 }] };
  devices[ms] = { id: ms, driverId: 'hidpp', customName: 'Gaming mouse', customIcon: '🖱️', order: 1, hidden: true, history: [{ t: now - 120000, c: 60, ch: 0 }] };
  const before = JSON.parse(JSON.stringify({ kb: devices[kb], ms: devices[ms] }));

  const parent = { id: parentId, serialNumber: serial, expanded: true, channels: [] };
  const child = (id, wpid, slot) => ({ id, serialNumber: serial, channels: [], receiver: { slot, wpid, kind: 1 } });
  const listings = [
    [parent, child(kb, 0x408e, 1), child(ms, 0x409f, 2)],
    [parent, child(ms, 0x409f, 1), child(kb, 0x408e, 2)],
  ];
  let listing = 0;
  const reads = [];
  const { enumerate, readBattery } = hidClient;
  hidClient.enumerate = async () => listings[Math.min(listing++, 1)];
  hidClient.readBattery = async (driverId, device) => {
    reads.push(device);
    return { capacity: device.receiver.wpid === 0x408e ? 95 : 81, charging: false };
  };
  try {
    await poller.pollOnce(() => {}, { force: true });
    await poller.pollOnce(() => {}, { force: true });

    assert.ok(devices[kb] && devices[ms], 'both cards are kept');
    for (const [id, was] of [[kb, before.kb], [ms, before.ms]]) {
      for (const key of ['customName', 'customIcon', 'order', 'hidden']) assert.deepEqual(devices[id][key], was[key], `${id} ${key}`);
    }
    assert.equal(devices[kb].history[0].c, 50);
    assert.equal(devices[kb].history[devices[kb].history.length - 1].c, 95);
    assert.equal(devices[kb].lastReading.capacity, 95);
    assert.deepEqual(devices[ms].history, before.ms.history);
    assert.equal(devices[ms].lastReading, undefined);
    assert.equal(reads.filter((d) => d.id === kb).pop().receiver.slot, 2);
  } finally {
    hidClient.enumerate = enumerate;
    hidClient.readBattery = readBattery;
    delete devices[kb];
    delete devices[ms];
  }
});

test("a receiver's old card becomes the card of the device it was reading, keeping its settings", async () => {
  const serial = '0123456789ab';
  const parentId = `1133:50503:${serial}`;
  const kb = `${parentId}:408e`;
  const now = Date.now();
  devices[parentId] = {
    id: parentId, driverId: 'hidpp', product: 'USB Receiver', identity: `mac:${serial}`, customName: 'Desk keyboard', customIcon: '⌨️',
    alertThreshold: 15, order: 3, hidden: false, history: [{ t: now - 60000, c: 50, ch: 0 }],
  };
  const parent = { id: parentId, serialNumber: serial, expanded: true, channels: [] };
  const child = (id, wpid, slot, product) => ({ id, serialNumber: serial, product, channels: [], receiver: { slot, wpid, kind: 1 } });
  const { enumerate, readBattery } = hidClient;
  hidClient.enumerate = async () => [parent, child(`${parentId}:409f`, 0x409f, 2, 'G502 X LS'), child(kb, 0x408e, 1, 'G913 TKL')];
  hidClient.readBattery = async () => ({ capacity: 95, charging: false });
  try {
    await poller.pollOnce(() => {}, { force: true });
    assert.equal(devices[parentId], undefined);
    const card = devices[kb];
    assert.ok(card, 'the keyboard has the card');
    assert.equal(card.product, 'G913 TKL');
    assert.equal(identityOf(card), null, 'the receiver serial is not carried over as the device identity');
    for (const [key, value] of [['customName', 'Desk keyboard'], ['customIcon', '⌨️'], ['alertThreshold', 15], ['order', 3], ['hidden', false], ['driverId', 'hidpp']]) {
      assert.deepEqual(card[key], value, key);
    }
    assert.equal(card.history[0].c, 50);
    assert.equal(card.lastReading.capacity, 95);
    assert.equal(devices[`${parentId}:409f`], undefined, 'the other device is left for Add device');
  } finally {
    hidClient.enumerate = enumerate;
    hidClient.readBattery = readBattery;
    delete devices[kb];
    delete devices[parentId];
  }
});

test('a refresh reads devices while the Windows scan runs; Windows cards wait for the scan', async () => {
  const events = [];
  const originalScan = system.scan;
  const originalGet = system.get;
  let finishScan;
  system.scan = () => { events.push('scan start'); return new Promise((r) => { finishScan = () => { events.push('scan done'); r([]); }; }); };
  system.get = () => { events.push('windows read'); return { capacity: 33, connected: true }; };
  addMouse();
  devices.bud = { id: 'bud', driverId: 'system', product: 'Buds', links: [] };
  devices.bud.id = 'bt:bud';
  devices['bt:bud'] = { id: 'bt:bud', driverId: 'system', product: 'Buds' };
  delete devices.bud;
  try {
    const done = poller.pollOnce(() => {}, { force: true });
    await flush();
    assert.ok(finishRead, 'the device read started before the scan ended');
    events.push('device read');
    finishRead.resolve({ capacity: 70, charging: false });
    await flush();
    finishScan();
    await done;
    assert.ok(events.indexOf('device read') < events.indexOf('scan done'));
    assert.ok(events.indexOf('windows read') > events.indexOf('scan done'));
    assert.equal(devices['bt:bud'].lastReading.capacity, 33);
  } finally {
    system.scan = originalScan;
    system.get = originalGet;
    delete devices['bt:bud'];
  }
});

test('cards that answered last time are read before cards that are away', async () => {
  const order = [];
  const original = hidClient.readBattery;
  hidClient.enumerate = async () => [{ id: 'quiet' }, { id: 'mouse' }];
  hidClient.readBattery = (driverId, d) => { order.push(d && d.id); return Promise.resolve({ capacity: 50, charging: false }); };
  delete devices.mouse; // so the away card comes first in the saved order
  devices.quiet = { id: 'quiet', driverId: 'generic', product: 'Quiet', online: false, lastError: 'mouse is off' };
  addMouse();
  try {
    await poller.pollOnce(() => {}, { force: true });
    assert.deepEqual(order.filter((id) => id === 'quiet' || id === 'mouse'), ['mouse', 'quiet']);
  } finally {
    hidClient.readBattery = original;
    hidClient.enumerate = async () => [{ id: 'mouse' }];
    delete devices.quiet;
  }
});

// A G913 TKL on its cable (046d:c343) and in slot 1 of the c547 receiver: the same unit ID, so one card.
// Each test uses its own channel paths: the poller remembers identities for the whole file.
const G913 = 'logi:b35f408ec343:71b82111';
const CABLE = '1133:49987:CABLESERIAL';
const PARENT = '1133:50503:0123456789ab';
const CHILD = `${PARENT}:408e`;

async function withG913(tag, identifyChild, fn) {
  const live = [
    { id: PARENT, serialNumber: '0123456789ab', expanded: true, channels: [{ path: `${tag}-parent` }] },
    { id: CHILD, serialNumber: '0123456789ab', product: 'G913 TKL', channels: [{ path: `${tag}-child` }], receiver: { slot: 1, wpid: 0x408e, kind: 1 } },
    { id: CABLE, serialNumber: 'CABLESERIAL', product: 'G913 TKL LIGHTSPEED Wireless RGB Mechanical Gaming Keyboard', channels: [{ path: `${tag}-cable` }] },
  ];
  const asked = [];
  const merges = [];
  const { enumerate, readBattery, identify } = hidClient;
  const { detectDriver } = driverImpl;
  const { mergeDevices } = store;
  driverImpl.detectDriver = () => ({ id: 'hidpp', needsIdentify: true });
  hidClient.enumerate = async () => live;
  hidClient.readBattery = async () => ({ capacity: 95, charging: false });
  hidClient.identify = async (driverId, device) => {
    asked.push(device.channels[0].path);
    if (device.expanded) return null;
    return device.id === CHILD ? identifyChild() : G913;
  };
  store.mergeDevices = (keepId, dropId) => { merges.push([keepId, dropId]); mergeDevices(keepId, dropId); };
  try {
    await poller.pollOnce(() => {}, { force: true });
    await fn({ asked, merges });
  } finally {
    hidClient.enumerate = enumerate;
    hidClient.readBattery = readBattery;
    hidClient.identify = identify;
    driverImpl.detectDriver = detectDriver;
    store.mergeDevices = mergeDevices;
    delete devices[CABLE];
    delete devices[CHILD];
  }
}

test('the cable card and the receiver card of one G913 TKL become one card', async () => {
  const now = Date.now();
  devices[CABLE] = { id: CABLE, driverId: 'hidpp', customName: 'Desk keyboard', history: [{ t: now - 60000, c: 80, ch: 1 }] };
  devices[CHILD] = { id: CHILD, driverId: 'hidpp', history: [{ t: now - 180000, c: 60, ch: 0 }, { t: now - 120000, c: 59, ch: 0 }] };
  await withG913('merge', () => G913, async () => {
    const left = [CABLE, CHILD].filter((id) => devices[id]);
    assert.equal(left.length, 1, 'one card is left');
    const card = devices[left[0]];
    assert.equal(card.customName, 'Desk keyboard');
    assert.equal(card.identity, G913);
    const ids = routesOf(card).map((r) => r.id);
    assert.ok(ids.includes(CABLE) && ids.includes(CHILD), `both routes: ${ids}`);
  });
});

test('plugging the cable attaches it to the receiver card', async () => {
  devices[CHILD] = { id: CHILD, driverId: 'hidpp', customName: 'Desk keyboard', history: [] };
  await withG913('attach', () => G913, async () => {
    assert.equal(devices[CABLE], undefined, 'no new card for the cable');
    assert.ok((devices[CHILD].links || []).some((l) => l.id === CABLE), 'the cable is a route of the receiver card');
  });
});

test('a device that does not answer identify keeps its card', async () => {
  devices[CABLE] = { id: CABLE, driverId: 'hidpp', history: [] };
  devices[CHILD] = { id: CHILD, driverId: 'hidpp', history: [] };
  await withG913('silent', () => { throw new Error('timeout waiting for battery response'); }, async ({ asked, merges }) => {
    assert.ok(asked.includes('silent-child'), 'the child was asked');
    assert.deepEqual(merges, []);
    assert.ok(devices[CABLE] && devices[CHILD], 'both cards remain');
  });
});
