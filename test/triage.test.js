const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReport, hardwareOf, decide, boardBody, isOlder } = require('../.github/scripts/triage');

const form = ({ ids = 'VID_040B / PID_0897', scan = 'Channels: ff00:0001\nScan 1: nothing captured', actual = '_No response_', version = '2.0.3' } = {}) => [
  '### Device', '', 'XiiSound Fuxi-H3', '',
  '### Connection', '', 'USB', '',
  '### Vendor / Product ID', '', ids, '',
  '### Calibration scan output', '', '```text', scan, '```', '',
  '### Actual battery level during the scan', '', actual, '',
  '### Anything else', '', 'Verdict: Everything looks fine', '',
  '### Battery Hub version', '', version,
].join('\n');

test('hardware ids are read in every way people write them', () => {
  assert.equal(hardwareOf('VID_040B / PID_0897'), '040B:0897');
  assert.equal(hardwareOf('HID\VID_046d&PID_c54d&MI_02'), '046D:C54D');
  assert.equal(hardwareOf('VID_04DA/PID_23C7'), '04DA:23C7');
  assert.equal(hardwareOf('Hardware: 1532:00e6'), '1532:00E6');
  assert.equal(hardwareOf('no ids here'), null);
});

test('a report form is read: ids, version, scan data and the real level', () => {
  const empty = parseReport({ title: '[Device] Fuxi-H3', body: form() });
  assert.deepEqual(empty, { hardware: '040B:0897', name: 'XiiSound Fuxi-H3', version: '2.0.3', captured: false, bytes: false, hasLevel: false });
  const good = parseReport({ title: '[Device] x', body: form({ scan: 'Scan 1: 4 messages\nff00:0001 report 5, seen 3x: 05550100', actual: '85' }) });
  assert.equal(good.captured, true);
  assert.equal(good.hasLevel, true);
  assert.equal(good.bytes, true);
  for (const actual of ["dont't know", 'don`t know', 'idk', 'Not sure', '?']) {
    assert.equal(parseReport({ title: '[Device] x', body: form({ actual }) }).hasLevel, false, actual);
  }
});

test('versions compare by number', () => {
  assert.equal(isOlder('2.0.1', 'v2.0.3'), true);
  assert.equal(isOlder('2.0.10', '2.0.9'), false);
  assert.equal(isOlder('2.0.3', '2.0.3'), false);
});

test('a copy of a reported device is closed and sent to the open report, not to a closed copy', () => {
  const report = parseReport({ title: '[Device] x', body: form() });
  const others = [
    { hardware: '040B:0897', number: 41, state: 'closed', duplicate: true },
    { hardware: '040B:0897', number: 18, state: 'open', duplicate: false },
  ];
  const action = decide(report, others, 'v2.0.3');
  assert.equal(action.close, true);
  assert.deepEqual(action.labels, ['duplicate']);
  assert.match(action.comment, /continue in #18/);
});

test('an old version is asked to update; an empty scan gets tips; a full one is marked good', () => {
  const old = decide(parseReport({ title: '[Device] x', body: form({ version: '2.0.1' }) }), [], 'v2.0.3');
  assert.deepEqual([old.labels, old.close], [['old version', 'needs info'], false]);
  const empty = decide(parseReport({ title: '[Device] x', body: form() }), [], 'v2.0.3');
  assert.deepEqual(empty.labels, ['no data', 'needs info']);
  assert.match(empty.comment, /turn it off and on/);
  const good = decide(parseReport({ title: '[Device] x', body: form({ scan: 'Scan 1: 4 messages\nff00:0001 feature report 9, seen 2x: xxxxxxxxxxxx3e', actual: '62%' }) }), [], 'v2.0.3');
  assert.deepEqual([good.labels, good.comment], [['good report'], null]);
  const countsOnly = decide(parseReport({ title: '[Device] x', body: form({ scan: 'Scan 1: 4 messages', actual: '62%' }) }), [], 'v2.0.3');
  assert.deepEqual([countsOnly.labels, countsOnly.close], [[], false]);
});

test('the device list counts people and votes, links one main report, and keeps closed devices apart', () => {
  const body = boardBody([
    { hardware: '3151:1020', name: 'YICHIP 2.4G Receiver', number: 26, state: 'closed', author: 'a', votes: 0, duplicate: true },
    { hardware: '3151:1020', name: 'YICHIP 2.4G Receiver', number: 31, state: 'open', author: 'a', votes: 0 },
    { hardware: '040B:0897', name: 'Fuxi-H3', number: 5, state: 'closed', author: 'd', votes: 0 },
    { hardware: '040B:0897', name: 'Fuxi-H3', number: 18, state: 'open', author: 'b', votes: 2, good: true },
    { hardware: '040B:0897', name: 'Fuxi-H3', number: 41, state: 'closed', author: 'c', votes: 0, duplicate: true },
    { hardware: '04DA:23C7', name: 'Panasonic SC-GNW10', number: 59, state: 'closed', author: 'e', votes: 0 },
    { hardware: '046D:0ACB', name: 'G435', number: 10, state: 'open', author: 'f', votes: 0, cantSupport: true },
    { hardware: '046D:0ACB', name: 'G435', number: 16, state: 'open', author: 'g', votes: 0 },
  ]);
  const [top, once, closed] = body.split('<details>');
  const rows = (part) => part.split('\n').filter((l) => /^\| \d/.test(l));
  assert.deepEqual(rows(top), ['| 5 | Fuxi-H3 | `040B:0897` | #18 | ✅ |']);
  assert.match(once, /Asked once, newest first \(1\)/);
  assert.deepEqual(rows(once), ['| 1 | YICHIP 2.4G Receiver | `3151:1020` | #31 | |']);
  assert.deepEqual(rows(closed), ['| 2 | G435 | `046D:0ACB` | #10 | |', '| 1 | Panasonic SC-GNW10 | `04DA:23C7` | #59 | |']);
});

test("a new report of a device marked can't support is closed with that answer", () => {
  const report = parseReport({ title: '[Device] x', body: form({ ids: 'VID_046D / PID_0ACB' }) });
  const action = decide(report, [{ hardware: '046D:0ACB', number: 10, state: 'open', cantSupport: true }], 'v2.0.4');
  assert.equal(action.close, true);
  assert.deepEqual(action.labels, ['duplicate', "can't support"]);
  assert.match(action.comment, /can't read it/);
});

test('devices people confirmed are listed under Works with, one row per device', () => {
  const works = [
    { hardware: '3554:F58A', name: 'VXE R1 Pro', number: 160, author: 'a' },
    { hardware: '3554:F58A', name: 'VXE R1 Pro', number: 170, author: 'b' },
    { hardware: '25A7:FA70', name: 'Compx receiver', number: 165, author: 'c' },
  ];
  const body = boardBody([], works);
  const section = body.split('<details>')[1];
  assert.match(section, /Works: people confirmed Battery Hub reads these \(2\)/);
  const rows = section.split('\n').filter((l) => /^\| \d/.test(l));
  assert.deepEqual(rows, ['| 2 | VXE R1 Pro | `3554:F58A` | #160 |', '| 1 | Compx receiver | `25A7:FA70` | #165 |']);
});

test('a Works report is told apart from a device request', () => {
  const { isWorksReport, isDeviceReport } = require('../.github/scripts/triage');
  assert.equal(isWorksReport({ title: '[Works] VXE R1 Pro' }), true);
  assert.equal(isDeviceReport({ title: '[Works] VXE R1 Pro' }), false);
  assert.equal(isWorksReport({ title: '[Device] x', labels: [{ name: 'device-support' }] }), false);
});

test('a device someone confirmed works leaves the ranking and the closed list', () => {
  const body = boardBody(
    [{ hardware: '03F0:06BE', name: 'Cloud III S', number: 33, state: 'closed', author: 'a', votes: 0, works: true },
      { hardware: '040B:0897', name: 'Fuxi-H3', number: 18, state: 'open', author: 'b', votes: 0 }],
    [{ hardware: '03F0:06BE', name: 'Cloud III S', number: 33, author: 'a' }],
  );
  const [top, once, works] = body.split('<details>');
  assert.ok(!/06BE/.test(top) && !/06BE/.test(once));
  assert.match(works, /\| 1 \| Cloud III S \| `03F0:06BE` \| #33 \|/);
});

test('devices Battery Hub reads now get their own section, and a new report of one points there', () => {
  const body = boardBody([
    { hardware: '1D57:FA60', name: 'Beken 2.4G Wireless Device', number: 20, state: 'open', author: 'a', votes: 3, supported: true },
    { hardware: '040B:0897', name: 'Fuxi-H3', number: 18, state: 'open', author: 'b', votes: 1 },
  ]);
  const [top, supported] = body.split('<details>');
  assert.ok(!/FA60/.test(top));
  assert.match(supported, /Supported now: update Battery Hub and tell us if yours works \(1\)/);
  assert.ok(supported.includes('| 4 | Beken 2.4G Wireless Device | `1D57:FA60` | #20 | |'));
  const report = parseReport({ title: '[Device] x', body: form({ ids: 'VID_1D57 / PID_FA60' }) });
  const action = decide(report, [{ hardware: '1D57:FA60', number: 20, state: 'open', supported: true }], 'v2.0.7');
  assert.equal(action.close, true);
  assert.match(action.comment, /already reads this device .*#20/);
});

test('device names are cleaned up for the list', () => {
  const { cleanName } = require('../.github/scripts/triage');
  assert.equal(cleanName('(Стандартные системные устройства) 2.4G Wireless Receiver'), '2.4G Wireless Receiver');
  assert.equal(cleanName('(标准系统设备) 2.4G Mouse'), '2.4G Mouse');
  assert.equal(cleanName('MCHOSE MCHOSE K99 V3 2.4G'), 'MCHOSE K99 V3 2.4G');
  assert.equal(cleanName('XiiSound Technology Corporation Fuxi-H3'), 'XiiSound Fuxi-H3');
  assert.equal(cleanName('HP, Inc HyperX Cloud II Wireless'), 'HyperX Cloud II Wireless');
  assert.equal(cleanName('Havit Fuxi-H6 (headset), dongle USB 2.4G. Strings USB: fabri'), 'Havit Fuxi-H6');
  assert.equal(cleanName('ATK̄Љ礼p  Wireless mouse 8k dongle-L0'), 'ATK Wireless mouse 8k dongle-L0');
  assert.equal(cleanName(''), 'Unknown device');
});
