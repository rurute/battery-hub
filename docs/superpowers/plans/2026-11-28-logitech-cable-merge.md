# Logitech ケーブル / Lightspeed を 1 枚のカードにする 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HID++ のドライバに `identify` を足し、G913 TKL のケーブルのカードとレシーバーの子機のカードを、unit ID で同じ機体と見分けて 1 枚にまとめる。

**Architecture:** `src/main/hid/drivers/hidpp.js` に `needsIdentify: true` と `identify(logicalDevice)` を足すだけで、poller の `identityOfLive` → `planMerges` → `mergeDevices` / `links` の今の流れ（PlayStation と同じ）に乗る。poller・identity・store は変えない。

**Tech Stack:** Node.js（Electron の main process）、`node:test`、HID++ 2.0。

**Spec:** `docs/superpowers/specs/2026-11-28-logitech-cable-merge-design.md`（HUMAN の承認は HEAD `9594aec` の版）

## Global Constraints

- 返す identity の形: `logi:<modelId 12 桁>:<unit ID 8 桁>`（小文字 16 進）。
- `getDeviceInfo`（0x0003 の function 0）の params: `[1..4]` unit ID、`[7..12]` modelId。
- 対象は `c547` で機器ごとに分けた子機（`logicalDevice.receiver` を持つ）と、ケーブルで直接つないだ機器（device index `0xFF`）だけ。レシーバー本体（product 名に receiver を含み、`receiver` を持たないもの。`c539` のカードを含む）は問い合わせず `null`。
- `null`（機器が答えたが根拠がない）: 0x0003 がない（index 0）、unit ID がすべて `00` かすべて `ff`。
- 例外（機器が答えない）: タイムアウトや「device is off」は投げたままにする（poller が覚えず、次の poll で問い合わせ直す）。
- 問い合わせは `serialize(channel.path, …)` の中で行う（読み取りと同じ）。
- poller の `identities` の動き（PlayStation と共通）は変えない。poller・`identity.js`・`store.js` は変えない。
- docs / README は更新しない。本家への PR は作らない。

## Review Focus

1. レシーバーの子機が寝ている・ケーブルに移ってレシーバーから消えている → `identify` が例外を投げ、カードはそのまま、poll は続く（Task 1 `identify: a silent device throws`、Task 2 `a device that does not answer identify keeps its card`）。
2. 同じ型番の 2 台（unit ID だけ違う）→ 別の identity になり、まとまらない（Task 1 `identify: two units of one model differ`）。
3. 機器ごとに分けていないレシーバーのカード（`c539` の「USB Receiver」）→ 1 度も問い合わせずに `null`（Task 1 `identify: a receiver card is never asked`）。
4. unit ID が `00000000` / `ffffffff` の機器 → `null` で、ほかの機器とまとまらない（Task 1 `identify: no usable unit id gives null`）。
5. ケーブルを挿したときに、カードのない新しい経路が既存のカードの `links` に足され、カードが増えない（Task 2 `plugging the cable attaches it to the receiver card`）。

---

### Task 1: `hidpp.js` の `identify`

**Files:**
- Modify: `src/main/hid/drivers/hidpp.js`（定数の近くに `DEVICE_INFO = 0x0003`、`readOn` の後に `identityFromInfo` と `identify`、`module.exports`）
- Create: `test/hidpp-identify.test.js`

**Interfaces:**
- Consumes: なし（`hidpp.js` の中の `channelOf`・`call`・`featureIndex`・`serialize`・`DIRECT` を使う）
- Produces:
  - `identify(logicalDevice) -> Promise<string|null>`（`module.exports` に追加、あわせて `needsIdentify: true`）
  - `identityFromInfo(params: number[]) -> string|null`（`module.exports` に追加。テストで使う）

- [ ] **Step 1: 失敗するテストを書く**

`test/hidpp-identify.test.js` を作る。偽の exchange は `test/protocols.test.js` の `withExchange`（hidpp を require cache から消してから `exchange.exchange` を差し替える）と同じやり方を、このファイルの中に持つ。偽の exchange は、受けた request の `[1]` device index、`[2]` feature index、`[3]` fnSw を見て返事を作り、`calls` に `{ device, index }` を記録する。

実機の返事（spec の「実機で分かっていること」）:
- root の `getFeature(0x0003)`（request `[4..5]` が `00 03`）→ `pad([0x11, device, 0x00, fnSw, 0x02], 20)`
- `getDeviceInfo`（feature index `0x02`, function 0）→ `pad([0x11, device, 0x02, fnSw, 0x05, 0x71, 0xb8, 0x21, 0x11, 0x00, 0x0e, 0xb3, 0x5f, 0x40, 0x8e, 0xc3, 0x43, 0x04, 0x00, 0x00], 20)`

```js
const G913 = 'logi:b35f408ec343:71b82111';
const LONG = [{ path: 'k', usagePage: 0xff00, usage: 0x02 }];
const cable = { product: 'G913 TKL LIGHTSPEED Wireless RGB Mechanical Gaming Keyboard', vendorId: 0x046d, productId: 0xc343, channels: LONG };
const child = { product: 'G913 TKL', vendorId: 0x046d, productId: 0xc547, channels: LONG, receiver: { slot: 1, wpid: 0x408e, kind: 1 } };
const receiverCard = { product: 'USB Receiver', vendorId: 0x046d, productId: 0xc539, channels: LONG };

test('identify: the G913 TKL gives the same identity on its cable and through the receiver', async () => {
  // cable: asked on 0xff; child: asked on slot 1
  assert.equal(await hidpp.identify(cable), G913);
  assert.equal(await hidpp.identify(child), G913);
  assert.deepEqual(calls.map((c) => c.device), [0xff, 0xff, 1, 1]);
});
test('identify: two units of one model differ', ...);           // unit ID 71b82112 → 'logi:b35f408ec343:71b82112', not G913
test('identify: no usable unit id gives null', ...);            // unit ID 00000000 → null; ffffffff → null
test('identify: no 0x0003 feature gives null', ...);            // getFeature answers index 0 → null, getDeviceInfo never sent
test('identify: a silent device throws', ...);                  // fake throws 'timeout waiting for battery response' → rejects /^Error: timeout waiting/
test('identify: a receiver card is never asked', ...);          // identify(receiverCard) === null and calls.length === 0
test('hidpp asks the poller to identify', () => assert.equal(hidpp.needsIdentify, true));
```

`identityFromInfo` 単体も確かめる:

```js
assert.equal(hidpp.identityFromInfo([0x05, 0x71, 0xb8, 0x21, 0x11, 0x00, 0x0e, 0xb3, 0x5f, 0x40, 0x8e, 0xc3, 0x43, 0x04, 0x00, 0x00]), G913);
assert.equal(hidpp.identityFromInfo([0x05, 0, 0, 0, 0, 0x00, 0x0e, 0xb3, 0x5f, 0x40, 0x8e, 0xc3, 0x43]), null);
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `node --test test/hidpp-identify.test.js`
Expected: FAIL（`hidpp.identify is not a function` など）

- [ ] **Step 3: `identityFromInfo` と `identify` を `hidpp.js` に書く**

- `identityFromInfo(params)`: `params[1..4]` が unit ID、`params[7..12]` が modelId。unit ID がすべて `0x00` かすべて `0xff` なら `null`。それ以外は `logi:<modelId>:<unitId>`（各バイトを 2 桁の小文字 16 進でつなぐ）。
- `identify(logicalDevice)`:
  1. `channelOf` が無ければ `null`。
  2. `receiver` を持たず product 名が `/receiver/i` に合えば `null`（問い合わせない）。`slotsOf` と同じ判定。
  3. device index は `receiver ? receiver.slot : DIRECT`。
  4. `serialize(channel.path, …)` の中で `featureIndex(channel, device, DEVICE_INFO)` → 0 なら `null`、そうでなければ `call(channel, device, index, 0)` の params を `identityFromInfo` に渡す。
  5. 例外は捕まえない（そのまま投げる）。
- `module.exports` に `needsIdentify: true`、`identify`、`identityFromInfo` を足す。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `node --test test/hidpp-identify.test.js`
Expected: PASS（全件）

Run: `npm test`
Expected: fail 0（変更前は pass 530・skipped 1。新しいテストの分だけ pass が増える）

- [ ] **Step 5: Commit**

```bash
git add src/main/hid/drivers/hidpp.js test/hidpp-identify.test.js
git commit -m "feat(hidpp): unit ID で機体を見分ける identify を足す"
```

### Task 2: poller で 1 枚にまとまることのテスト

**Files:**
- Modify: `test/poller.test.js`（偽の `store` に `mergeDevices` を足す。偽の `drivers` を差し替えのきく形にする。テストを 3 つ足す）

**Interfaces:**
- Consumes: Task 1 の `needsIdentify` / `identify` の契約（identity の文字列、`null`、例外）。このテストでは本物の hidpp は使わず、偽の `driverImpl.detectDriver` が `{ id: 'hidpp', needsIdentify: true }` を返し、偽の `hidClient.identify(driverId, device)` が identity を返す。レシーバーの親（`expanded: true` の機器）には、本物の `identify` と同じく `null` を返す。
- Produces: なし（本番のコードは変えない。テストが失敗したら、poller を直さずに原因を報告する）

**偽の `drivers` を、poller を読み込む前に転送する形にする。** poller は `const { driverById, detectDriver } = require('./hid/drivers')` で読み込み時に関数を取り出すので、テストの中で `drivers.detectDriver = …` と差し替えても poller には届かない。ファイル先頭の `const drivers = { driverById: () => ({}), detectDriver: () => null };` を、`const driverImpl = { driverById: () => ({}), detectDriver: () => null };` と `const drivers = { driverById: (...a) => driverImpl.driverById(...a), detectDriver: (...a) => driverImpl.detectDriver(...a) };` に変え、テストでは `driverImpl.detectDriver` を差し替えて `finally` で戻す。既存のテストの動きは変わらない。

偽の `store.mergeDevices(keepId, dropId)` は、`src/main/store.js` の `mergeDevices` のうち、このテストが見る部分だけを持つ: `links` に `{ id: drop.id, driverId: drop.driverId, profile: drop.profile || null }` と drop の `links` を足し、`customName` は keep を優先して drop で埋め、drop を消す。

固定の値:
- ケーブルの id: `1133:49987:CABLESERIAL`（`c343` = 49987）、レシーバーの親: `1133:50503:0123456789ab`、子機: その後ろに `:408e`。
- identity: `logi:b35f408ec343:71b82111`。
- **テストごとに channel の path を変える。** poller は 1 つの instance をテスト全体で使い、`identities`（モジュールの中の Map）に `${device.id}|${device.channels[0].path}` をキーとして成功した identity を覚える。これはテストの後で消せないので、3 つのテストで live の機器の `channels` を `[{ path: 'merge-cable' }]` / `[{ path: 'merge-child' }]`、`attach-cable` / `attach-child`、`silent-cable` / `silent-child` のように別々にし、前のテストが覚えた identity を使わせない。本番の poller の覚え方は変えない。

- [ ] **Step 1: テストを書く**

```js
test('the cable card and the receiver card of one G913 TKL become one card', async () => {
  // devices: cable card (customName 'Desk keyboard', short history) and child card (longer history)
  // live: parent (expanded), child (receiver slot 1), cable — identify returns G913 for both
  // after pollOnce: exactly one of the two ids remains; it has customName 'Desk keyboard';
  // routesOf(card) contains both ids; card.identity === G913
});
test('plugging the cable attaches it to the receiver card', async () => {
  // devices: child card only, identity not yet saved
  // live: parent, child, cable — identify returns G913 for both
  // after pollOnce: no card for the cable id; child card's links include the cable id
});
test('a device that does not answer identify keeps its card', async () => {
  // devices: cable card and child card; identify throws 'timeout waiting for battery response' for the child
  // identify returns G913 for the cable and throws for the child
  // after pollOnce: both cards remain, mergeDevices never called,
  // and identify was called for the child (its channel path 'silent-child'), so the throwing path was exercised
});
```

各テストは `driverImpl.detectDriver`・`hidClient.enumerate`・`hidClient.identify`・`hidClient.readBattery` を差し替え、`finally` で元に戻し、足したカードを消す（今の receiver のテストと同じ書き方）。`readBattery` は `{ capacity: 95, charging: false }` を返す。

- [ ] **Step 2: テストを走らせる**

Run: `node --test test/poller.test.js`
Expected: PASS。本番のコードは変えないので、Task 1 の契約どおりなら最初から通る。通らなければ poller を直さずに、どの assert が落ちたかを報告して止まる。先に、`driverImpl.detectDriver` が呼ばれているか、各テストの channel の path が別々で、`hidClient.identify` が想定どおり呼ばれているか（前のテストの identity を使っていないか）を確かめる。それでも落ちるなら、spec の「まとまる動き（変えない）」の前提が崩れている。

Run: `npm test`
Expected: fail 0

- [ ] **Step 3: Commit**

```bash
git add test/poller.test.js
git commit -m "test(poller): ケーブルとレシーバーのカードが unit ID で 1 枚になる"
```

### Task 3: 実機での確認（HUMAN と一緒に）

**Files:** なし（コードは変えない）

- [ ] **Step 1: ビルドする**

fork の手動ビルド（`build.yml` を Actions で走らせる、memory の personal-build-workflow）でインストーラーを作る。branch を origin に push する必要があるので、**push の前に HUMAN に確かめる**。

- [ ] **Step 2: HUMAN が入れて、spec の「実機での確認」1〜4 を見る**

1. レシーバーだけ → 1 枚。
2. ケーブルを挿す → 同じカードのまま、ケーブル経由で読める。カードは増えない。
3. 抜く → 同じカードのまま、レシーバー経由で読める。
4. もともと 2 枚あった場合に、1 枚にまとまる。

確認は WSL から `/mnt/c/Users/rurut/AppData/Roaming/battery-hub/` のカードの保存ファイルとログ（`battery-hub.log`）も読む。結果（通った・通らなかった・試していない）をそのまま HUMAN に報告する。

## レビューの記録

skill `cross-model-spec-plan-review` で、fresh な `codex exec`（read-only）に 3 回見せた。要求源は承認済みの spec（HEAD `9594aec` の版。HUMAN の承認「承認」、2026-11-28）。どの回も採用ゲート（0・A〜D）は満たし、MCP の起動ログは `clean`（設定済みの MCP サーバは 0 件）。

| 回 | run directory | 対象 HEAD | 比較元 | verdict |
|---|---|---|---|---|
| 1 | `20261128-163458-plan` | `239dfc8` | なし（新規） | CHANGES_REQUESTED |
| 2 | `20261128-163700-plan` | `090add8` | `239dfc8` | CHANGES_REQUESTED |
| 3 | `20261128-163837-plan` | `3deeec8` | `090add8` | APPROVE |

直した D:

- F1（1 回目）: Task 2 のテストが、poller がテストファイル全体で覚える identity を共有してしまい、答えない子機の場合を確かめられない。→ テストごとに channel の path を変え、子機に `identify` が呼ばれたことを確かめるようにした。
- F2（2 回目）: poller は `detectDriver` を読み込み時に取り出すので、テストの中で差し替えても届かない。→ poller を読み込む前に、差し替えのきく `driverImpl` へ転送する偽の `drivers` にした。

S / H: なし。

残る限界: レビュアは実機の値を独立には確かめていない。全テストの実行（変更前 pass 530）とビルドは確かめていない（read-only のため）。APPROVE は文書が要求源と整合しているという判定で、実装済み・テスト成功・HUMAN の承認のどれでもない。
