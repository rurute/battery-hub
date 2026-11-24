# SONY INZONE Buds Battery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the battery of SONY INZONE Buds over its USB dongle and show it on a card, with left / right / case on the detail screen.

**Architecture:** A new driver `src/main/hid/drivers/inzone.js` sends the verified battery GET (fresh TID and checksum each time) on collection `0xFF04/0x0001` through the shared `exchange()` helper, and returns `{ capacity, charging: null, parts }`. The poller already keeps extra reading fields in `lastReading`, so the renderer only adds three rows to the detail facts list, like the existing Voltage row.

**Tech Stack:** Node.js (Electron main + HID worker), node-hid via `src/main/hid/session.js`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-24-inzone-buds-design.md` (approved at `9476ee6`, "OK").

## Global Constraints

- Fork only (`rurute/battery-hub`); branch `feat/inzone-buds` from fork `main`.
- Target: `vendorId === 0x054c`, `productId === 0x0ec2`, collection `usagePage 0xff04 / usage 0x0001`. Driver id `inzone`.
- Request (64 bytes, zero padded): `02 0C 01 00 FC 08 96 C3 41 04 01 <TID lo> <TID hi> <checksum>`; checksum = low byte of the sum of bytes `[6..12]`.
- TID: 16-bit counter starting at `0x4000`, +1 per request, after `0xFFFF` back to `1` (0 never used).
- Accept a reply only if `[0] === 0x02`, length ≥ 20, `[9] === 0x04`, `[10] === 0x10`, `[11..12]` = sent TID, and `[19]` = low byte of the sum of `[5..18]`.
- Levels: `[14]` left, `[16]` right, `[18]` case; `0x00..0x64` is percent, anything else is unreported (`null`). Status bytes `[13]`, `[15]`, `[17]` are ignored.
- `capacity` = smaller of the non-null left/right. Both null → throw `headset is off`.
- One attempt waits 1000 ms. A timeout retries once with a new TID; a second timeout throws `headset is off`. Other errors propagate unchanged.
- Use one node-hid handle via `session` / `exchange` (HUMAN decision); separate handles only after a failed hardware check and a re-approved spec.
- Detail rows `Left`, `Right`, `Case` show only when `lastReading.parts` exists; value `NN%` or `—`.
- Real reply for tests: `02 12 04 ff 0f 00 96 c3 14 04 10 01 00 00 63 00 63 ff 60 a7` (TID 1) → left 99, right 99, case 96.

## Review Focus

1. A frame from INZONE Hub's traffic (other events, other TIDs, the `0x20` notification type) arriving before our reply must be skipped, not read as a battery value — Task 1 tests skip cases, Task 2 tests a skip followed by the real reply.
2. A level byte above `0x64` that is not `0xFF` must not reach the card — Task 1 test.
3. A dongle that is unplugged mid-read (write or read throws a non-timeout error) must surface that error, not "off" — Task 2 test.
4. The TID must change between the first attempt and the retry, and wrap from `0xFFFF` to `1` — Task 1 / Task 2 tests.
5. DualSense (`054c:0ce6`) must still go to `playstation` — Task 2 test.

---

### Task 1: Request and reply parsing

**Files:**
- Create: `src/main/hid/drivers/inzone.js`
- Create: `test/inzone.test.js`

**Interfaces:**
- Produces: `request(tid: number) -> number[64]`, `parseReply(frame: number[], tid: number) -> { left, right, case } | null` (each part `number | null`), `nextTid() -> number`, `_resetTid(value?: number)` (test hook, sets the next TID to return; default `0x4000`).

- [ ] **Step 1: Write the failing tests** in `test/inzone.test.js` (stub `node-hid` with `Module._load` as `test/protocols.test.js` does):

```js
const REPLY = [0x02, 0x12, 0x04, 0xff, 0x0f, 0x00, 0x96, 0xc3, 0x14, 0x04, 0x10, 0x01, 0x00, 0x00, 0x63, 0x00, 0x63, 0xff, 0x60, 0xa7];
const withSum = (f) => { const g = f.slice(); g[19] = g.slice(5, 19).reduce((a, b) => a + b, 0) & 0xff; return g; };

test('inzone: the battery request for TID 1 matches the capture', () => {
  const r = inzone.request(1);
  assert.equal(r.length, 64);
  assert.deepEqual(r.slice(0, 14), [0x02, 0x0c, 0x01, 0x00, 0xfc, 0x08, 0x96, 0xc3, 0x41, 0x04, 0x01, 0x01, 0x00, 0xa0]);
  assert.ok(r.slice(14).every((b) => b === 0));
});
test('inzone: the TID goes in little-endian and changes the checksum', () => {
  const r = inzone.request(0x4001);
  assert.deepEqual(r.slice(11, 14), [0x01, 0x40, (0x96 + 0xc3 + 0x41 + 0x04 + 0x01 + 0x01 + 0x40) & 0xff]);
});
test('inzone: the captured reply reads left 99, right 99, case 96', () => {
  assert.deepEqual(inzone.parseReply(REPLY, 1), { left: 99, right: 99, case: 96 });
});
test('inzone: an unreported part is null', () => {
  const f = REPLY.slice(); f[16] = 0xff;
  assert.deepEqual(inzone.parseReply(withSum(f), 1), { left: 99, right: null, case: 96 });
});
test('inzone: a level above 100 that is not 0xFF counts as unreported', () => {
  const f = REPLY.slice(); f[14] = 0x65;
  assert.equal(inzone.parseReply(withSum(f), 1).left, null);
});
test('inzone: frames that are not our battery reply are skipped', () => {
  assert.equal(inzone.parseReply(REPLY, 2), null, 'other TID');
  const ev = REPLY.slice(); ev[9] = 0x01; assert.equal(inzone.parseReply(withSum(ev), 1), null, 'other event');
  const ty = REPLY.slice(); ty[10] = 0x20; assert.equal(inzone.parseReply(withSum(ty), 1), null, 'notification type');
  const bad = REPLY.slice(); bad[19] = 0x00; assert.equal(inzone.parseReply(bad, 1), null, 'bad checksum');
  assert.equal(inzone.parseReply(REPLY.slice(0, 19), 1), null, 'short frame');
  const id = REPLY.slice(); id[0] = 0x07; assert.equal(inzone.parseReply(id, 1), null, 'other report id');
});
test('inzone: TIDs count up from 0x4000 and wrap from 0xFFFF to 1', () => {
  inzone._resetTid();
  assert.equal(inzone.nextTid(), 0x4000);
  assert.equal(inzone.nextTid(), 0x4001);
  inzone._resetTid(0xffff);
  assert.equal(inzone.nextTid(), 0xffff);
  assert.equal(inzone.nextTid(), 1);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test test/inzone.test.js`
Expected: FAIL with `Cannot find module '../src/main/hid/drivers/inzone'`.

- [ ] **Step 3: Implement** `request`, `parseReply`, `nextTid`, `_resetTid` in `src/main/hid/drivers/inzone.js` with the constants from Global Constraints. Use `pad` from `./exchange` for the 64-byte request. Head the file with a comment naming the Issue #3 capture and the reference projects listed in the Issue.

- [ ] **Step 4: Run and see them pass**

Run: `node --test test/inzone.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/hid/drivers/inzone.js test/inzone.test.js
git commit -m "feat(inzone): build the battery request and parse the reply (#3)"
```

### Task 2: Reading the battery and choosing the driver

**Files:**
- Modify: `src/main/hid/drivers/inzone.js`
- Modify: `src/main/hid/drivers/index.js` (`knownDrivers`: insert `inzone` immediately before `playstation`)
- Modify: `test/inzone.test.js`

**Interfaces:**
- Consumes: Task 1's `request`, `parseReply`, `nextTid`, `_resetTid`.
- Produces: driver module `{ id: 'inzone', matches(logicalDevice) -> boolean, readBattery(logicalDevice) -> Promise<{ capacity: number, charging: null, parts: { left, right, case } }> }`, plus the Task 1 exports.
- `readBattery` calls `require('./exchange').exchange(channel, request(tid), (f) => parseReply(f, tid), 1000)` through the module object (not a destructured binding), so tests can replace `exchange.exchange`.

- [ ] **Step 1: Write the failing tests** (append to `test/inzone.test.js`). Helper: replace `exchange.exchange` with a fake that records `{ request, timeoutMs }`, feeds a scripted list of frames to `accept` per call, returns the first non-null result, and throws `new Error('timeout waiting for battery response')` when a call's script is `'timeout'` or runs out; restore in `finally`.

```js
const BUDS = { id: 'b', vendorId: 0x054c, productId: 0x0ec2, channels: [{ path: 'p3', usagePage: 0xff04, usage: 0x0001 }, { path: 'p1', usagePage: 0xff13, usage: 0x0001 }] };

test('inzone: matches the dongle by id and command collection only', () => {
  assert.equal(inzone.matches(BUDS), true);
  assert.equal(inzone.matches({ ...BUDS, channels: [BUDS.channels[1]] }), false);
  assert.equal(inzone.matches({ ...BUDS, productId: 0x0ce6 }), false);
});
test('inzone: the driver list picks inzone for the buds and playstation for a DualSense', () => {
  assert.equal(detectDriver(BUDS).id, 'inzone');
  assert.equal(detectDriver({ vendorId: 0x054c, productId: 0x0ce6, channels: [{ path: 'd', usagePage: 0x0001, usage: 0x0005 }] }).id, 'playstation');
});
// reading: TID 1 via _resetTid(1); script [[hubFrame, REPLY]] where hubFrame is REPLY with [11]=0x02 and fixed checksum
//   -> { capacity: 99, charging: null, parts: { left: 99, right: 99, case: 96 } }; one call, on path 'p3', timeoutMs 1000
// lower earbud: right level 0x50 -> capacity 80
// one earbud reported: right 0xFF -> capacity 99, parts.right null
// no earbud reported: left and right 0xFF -> rejects /^Error: headset is off$/
// first call 'timeout', second answers (with TID 2 reply) -> reads; the two requests carry different TIDs ([11..12])
// two timeouts -> rejects /^Error: headset is off$/ after exactly 2 calls
// fake throws new Error('could not write') -> rejects /could not write/ after 1 call
```

Write each commented case as its own `test(...)` with the stated assertions.

- [ ] **Step 2: Run and see them fail**

Run: `node --test test/inzone.test.js`
Expected: the Task 1 tests pass; the new ones FAIL (`inzone.matches is not a function` / `readBattery is not a function`, and `detectDriver(BUDS)` returns `null`).

- [ ] **Step 3: Implement** `matches` and `readBattery` in `inzone.js`, export `id: 'inzone'`, and register `inzone` before `playstation` in `src/main/hid/drivers/index.js` (update the comment above `knownDrivers` to say the INZONE dongle shares Sony's vendor id with the PlayStation controllers). `matches` finds the channel with `usagePage === 0xff04 && usage === 0x0001` exactly (not `findChannel`, which falls back to any channel on the page).

- [ ] **Step 4: Run and see them pass, then the whole suite**

Run: `node --test test/inzone.test.js && npm test`
Expected: PASS; `npm test` reports 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/main/hid/drivers/inzone.js src/main/hid/drivers/index.js test/inzone.test.js
git commit -m "feat(inzone): read INZONE Buds over the USB dongle (#3)"
```

### Task 3: Detail rows and README

**Files:**
- Modify: `src/renderer/index.html` (after `detail-voltage-row` in the `facts` list)
- Modify: `src/renderer/detail.js` (`renderDetail`, next to the voltage lines)
- Modify: `README.md` (Supported devices table)

**Interfaces:**
- Consumes: `dev.lastReading.parts` as produced by Task 2 (`{ left, right, case }`, each `number | null`).

- [ ] **Step 1: Add the rows** to `index.html`, each hidden by default, in this shape: `<div id="detail-left-bud-row" hidden><dt>Left</dt><dd id="detail-left-bud"></dd></div>`, then `detail-right-bud` (`Right`) and `detail-case` (`Case`). (`detail-left` is already taken by "Time left".)

- [ ] **Step 2: Fill them** in `renderDetail`: `const parts = dev.lastReading && dev.lastReading.parts;` hide all three rows when `!parts`; otherwise show them with `part == null ? '—' : \`${part}%\``.

- [ ] **Step 3: Add the README row** after the PlayStation row: `| Sony | INZONE Buds (USB dongle) |`.

- [ ] **Step 4: Run the suite** (the syntax test parses renderer files)

Run: `npm test`
Expected: 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html src/renderer/detail.js README.md
git commit -m "feat(inzone): left, right and case on the detail screen (#3)"
```

### Task 4: Installer and hardware check

**Files:** none changed unless the check fails.

- [ ] **Step 1: Push and build**

```bash
git push -u origin feat/inzone-buds
SHA=$(git rev-parse HEAD); [ "$(git rev-parse origin/feat/inzone-buds)" = "$SHA" ]; echo pushed=$?
gh workflow run build.yml -R rurute/battery-hub --ref feat/inzone-buds
gh run list -R rurute/battery-hub -w build.yml --branch feat/inzone-buds --commit "$SHA" -L1 --json databaseId,headBranch,headSha
gh run watch <run-id> -R rurute/battery-hub --exit-status
gh run download <run-id> -R rurute/battery-hub -D dist/ci/battery-hub-feat-inzone-buds-<short sha>
```

Expected: `pushed=0`; the listed run has `headBranch` `feat/inzone-buds` and `headSha` equal to `$SHA` (if the list is empty, the dispatched run has not registered yet: list again, never fall back to an unfiltered list); the run succeeds and `Battery-Hub-Installer-2.0.5.exe` is downloaded from that run id.

- [ ] **Step 2: HUMAN runs the spec's hardware checks 1–6** with the installer (INZONE Hub running for check 5).

Expected: all six hold. If check 1 fails because nothing is read on one handle, stop: the spec's handle decision says to revise the spec (separate write handle) and get re-approval before changing code.
