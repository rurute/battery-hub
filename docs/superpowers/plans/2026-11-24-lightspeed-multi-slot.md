# Lightspeed レシーバーの複数台読み取り Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1 つの Lightspeed レシーバー（`046d:c547`）にペアリングした機器を 1 台ずつ別の logical device として一覧に出し、それぞれのバッテリーを別のカードで読む。

**Architecture:** worker の `enumerate` で、新しいモジュール `lightspeed.js` が対象のレシーバーにペアリング情報（HID++ 1.0 レジスタ `0xB5`）を問い合わせ、機器ごとに子の logical device（ID = 親の ID + `:` + 無線 PID）を足す。結果はモジュールの中で親の ID ごとに覚える。hidpp driver は、子なら自分のスロットだけを探し、読み先を子ごとに覚える。同じレシーバーへのやり取りは `lightspeed.serialize()` で 1 つずつにする。`identityOf()` は子の ID に identity を付けない。

**Tech Stack:** Node.js（Electron main / utilityProcess）、node-hid、`node:test`

**Spec:** `docs/superpowers/specs/2026-11-24-lightspeed-multi-slot-design.md`

## Global Constraints

- 展開の対象は `vendorId === 0x046d` かつ製品 ID が `RECEIVER_PIDS = [0xc547]` に入っていて、`0xFF00/0x0001`（短い）と `0xFF00/0x0002`（長い）の両方の collection を持つ logical device だけ。それ以外の機器には I/O をしない。
- 子の ID は `${parent.id}:${wpid}`。`wpid` は 4 桁の小文字 16 進（例: `1133:50503:ABC:408e`）。スロットの番号は ID に入れない。
- `exchange.js` / `session.js` / ほかの driver は変えない。handle は `session.js` から取り、閉じない（`session.js` の先頭コメント）。
- battery の読み取り（hidpp の `call`）は今の長いレポートの collection だけのやり取りのまま。
- 親（レシーバーそのもの）の logical device は一覧に残す。子を持つ親には `expanded: true` を付ける。Add device（`devices:list-live`）だけが `expanded` の親を除く。
- テストは `node:test`、ハードウェアなし。`npm test` が通ること。

## Review Focus

- 展開の途中でレシーバーを抜いた（collection に書けない・開けない）: `enumerate` 自体は成功し、そのレシーバーは前に覚えた結果、なければ展開なしで返る。→ Task 2 のテスト `an I/O failure keeps the previous children`
- 対象外の Logitech レシーバー（Bolt `0xc548` など）や Logitech 以外の機器: 展開の問い合わせが一度も走らない。→ Task 2 のテスト `non-target devices are never asked`
- Add device の一覧と poller の読み取りが同じレシーバーで重なる: 2 つのやり取りが交互に混ざらない。→ Task 2 の `serialize` のテスト
- 既存のレシーバー単位のカード（親の ID）: 今と同じく最初に見つかった 1 台が読める。→ Task 4 のテスト `the receiver itself still reads its first device`
- diagnostics・device report・capture の `enumerate`（`fresh` なし）: 2 回目以降はレシーバーに問い合わせない。→ Task 2 のテスト `a second listing does not ask again`

---

### Task 1: 返答の解析・子の ID・identity の規則

**Files:**
- Create: `src/main/hid/drivers/lightspeed.js`
- Modify: `src/main/identity.js:10-17`（`identityOf`）
- Test: `test/lightspeed.test.js`（新規）

**Interfaces:**
- Produces（`lightspeed.js` の export）:
  - `RECEIVER_PIDS: number[]`（`[0xc547]`）
  - `isTarget(logicalDevice) -> boolean`
  - `parsePairing(params: number[]) -> { wpid: number, kind: number } | null` — params はレジスタの返答の `b5` の次から（`[0]` サブアドレス、`[3..4]` 無線 PID（big endian）、`[7]` 種類）。wpid が 0 なら `null`
  - `parseName(params: number[]) -> string | null` — `[1]` が長さ、`[2..]` が ASCII。長さ 0 か、範囲外なら `null`
  - `childOf(parent, { slot, wpid, kind, name }) -> logicalDevice` — `id`・`product`・`receiver: { slot, wpid, kind }`。ほかは親と同じ。`identity` は付けない。`name` が `null` なら product は `kind` 1 → `Logitech keyboard`、2 → `Logitech mouse`、ほか → `Logitech device`
- Produces（`identity.js`）: `identityOf(device)` は、`device.identity` が無く、ID が `a:b:c:hhhh`（4 つ目が `/^[0-9a-f]{4}$/`）なら `null`

- [ ] **Step 1: 失敗するテストを書く**（`test/lightspeed.test.js`。`protocols.test.js` と同じく `node-hid` を `Module._load` で `{}` に差し替えてから require する）

```js
test('pairing info: wireless PID and kind from the bytes the G913 TKL / G502 X receiver sent', () => {
  const hex = (t) => t.split(' ').map((b) => parseInt(b, 16));
  assert.deepEqual(lightspeed.parsePairing(hex('20 07 08 40 8e 11 00 01 b3')), { wpid: 0x408e, kind: 1 });
  assert.deepEqual(lightspeed.parsePairing(hex('21 08 08 40 9f 11 00 02 b1')), { wpid: 0x409f, kind: 2 });
  assert.equal(lightspeed.parsePairing(hex('22 00 00 00 00 00 00 00')), null);
});

test('device name: length then ASCII', () => {
  const name = [0x40, 8, ...Buffer.from('G913 TKL')];
  assert.equal(lightspeed.parseName(name), 'G913 TKL');
  assert.equal(lightspeed.parseName([0x41, 0]), null);
});

test('a child keeps its id across slots and takes the receiver short name', () => {
  const parent = { id: '1133:50503:ABC', vendorId: 0x046d, productId: 0xc547, serialNumber: 'ABC', product: 'USB Receiver', manufacturer: 'Logitech', channels: [] };
  const a = lightspeed.childOf(parent, { slot: 1, wpid: 0x408e, kind: 1, name: 'G913 TKL' });
  const b = lightspeed.childOf(parent, { slot: 2, wpid: 0x408e, kind: 1, name: 'G913 TKL' });
  assert.equal(a.id, '1133:50503:ABC:408e');
  assert.equal(a.id, b.id);
  assert.equal(a.product, 'G913 TKL');
  assert.deepEqual(a.receiver, { slot: 1, wpid: 0x408e, kind: 1 });
  assert.equal(lightspeed.childOf(parent, { slot: 2, wpid: 0x409f, kind: 2, name: null }).product, 'Logitech mouse');
});

test('only the c547 receiver with both HID++ collections is a target', () => {
  const ch = [{ usagePage: 0xff00, usage: 1 }, { usagePage: 0xff00, usage: 2 }];
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc547, channels: ch }), true);
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc548, channels: ch }), false);
  assert.equal(lightspeed.isTarget({ vendorId: 0x046d, productId: 0xc547, channels: [ch[1]] }), false);
});

test('children of a receiver whose serial looks like a Bluetooth address are never merged', () => {
  const serial = '0123456789ab';
  const live = { id: `1133:50503:${serial}:408e`, serialNumber: serial };
  assert.equal(identityOf(live), null);
  const saved = { a: { id: `1133:50503:${serial}:408e` }, b: { id: `1133:50503:${serial}:409f` } };
  assert.equal(identityOf(saved.a), null);
  assert.deepEqual(planMerges(saved), []);
  const livePair = { a: { id: `1133:50503:${serial}:408e`, serialNumber: serial }, b: { id: `1133:50503:${serial}:409f`, serialNumber: serial } };
  assert.deepEqual(planMerges(livePair), []);
  assert.equal(identityOf({ id: `1133:50503:${serial}` }), `mac:${serial}`); // unchanged for others
});
```

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/lightspeed.test.js` / Expected: FAIL（`Cannot find module '../src/main/hid/drivers/lightspeed'`）

- [ ] **Step 3: 実装する** — `lightspeed.js` に上の 4 つと `RECEIVER_PIDS` を書く。`identity.js` の `identityOf` で、`device.identity` を見た直後に子の形の ID なら `null` を返す。

- [ ] **Step 4: 通ることを確かめる** — Run: `npm test` / Expected: 全部 PASS

- [ ] **Step 5: Commit** — `git add src/main/hid/drivers/lightspeed.js src/main/identity.js test/lightspeed.test.js && git commit -m "feat(hidpp): parse Lightspeed pairing info into per-device children (#2)"`

### Task 2: スロットの走査・展開・覚えておく・直列化

**Files:**
- Modify: `src/main/hid/drivers/lightspeed.js`
- Test: `test/lightspeed.test.js`

**Interfaces:**
- Consumes: Task 1 の `isTarget` / `parsePairing` / `parseName` / `childOf`
- Produces:
  - `serialize(key: string, fn: () => Promise<T>) -> Promise<T>` — 同じ key の fn を 1 つずつ実行する（Promise のチェーン。fn が reject しても次は走る）
  - `scanReceiver(ask) -> Promise<{ answered: boolean, devices: { slot, wpid, kind, name }[] }>` — `ask(sub: number) -> Promise<number[]>` はレジスタ `0xB5` のサブアドレス `sub` の返答の params を返す。エラーの返答なら `Error('register error <code>')`、タイムアウトなら `Error('timeout ...')`、I/O の失敗ならその Error を投げる。スロット n（1〜6）は pairing `0x20 + n - 1`、name `0x40 + n - 1`。`answered` は、どれか 1 つのスロットがペアリング情報かエラーの返答を返したとき `true`。タイムアウトのスロットは空として扱う。I/O の失敗はそのスロットを答えなしとして扱う（例外を外へ出さない）。名前の問い合わせの失敗は `name: null`
  - `expandReceivers(devices, { fresh = false, ask = realAsk } = {}) -> Promise<logicalDevice[]>` — `ask(parent) -> (sub) => Promise<number[]>`（テストで差し替える）。親ごとに `serialize(longPath(parent), ...)` の中で走査する。結果の配列は「元の並びのまま、展開した親に `expanded: true` を付け、その直後に子を並べる」
  - モジュールの中に `cache: Map<parent.id, devices[]>`。規則: 覚えた結果があり `fresh` でなければ問い合わせない／`answered` なら覚え直す（0 台なら消す）／`answered` でなければ覚えた結果を使い、なければ展開しない／一覧に出ていない親の分は消す
  - テスト用に `_reset()`（cache と lock を空にする）

- [ ] **Step 1: 失敗するテストを書く**（偽の `ask` は、スロットごとの返答の表から作る。例: `{ 0x20: pairing1, 0x40: name1, 0x21: pairing2, 0x41: name2 }`、表に無い sub は `register error 9`。呼ばれた sub を記録する）

  - `a receiver lists one child per paired device, after the receiver itself`: 結果の id が `[parent.id, parent.id + ':408e', parent.id + ':409f']`、親に `expanded: true`、子の `receiver.slot` が 1 と 2、product が `G913 TKL` / `G502 X LS`
  - `non-target devices are never asked`: `productId: 0xc548` の Logitech 機器と、別の vendor の機器を渡すと、`ask` が一度も呼ばれず、結果は入力と同じ（`expanded` なし）
  - `a receiver with nothing paired is returned as it is`: 全 sub がエラー → 子なし、`expanded` なし
  - `a second listing does not ask again, a fresh one does`: 2 回目（`fresh` なし）で `ask` が呼ばれず同じ子が出る。`fresh: true` で呼ばれる
  - `slots swapped on a fresh listing keep the same child ids`: 表を入れ替えて `fresh: true` → id は同じ、`receiver.slot` が入れ替わる
  - `no answer keeps the previous children`: 2 回目を全 sub タイムアウトにして `fresh: true` → 前と同じ子
  - `an I/O failure keeps the previous children`: 全 sub が `Error('could not write')` → 前と同じ子、`expandReceivers` は reject しない。cache が無いときは展開なし
  - `unpairing everything drops the children`: 全 sub がエラーの返答で `fresh: true` → 子なし、次の `fresh` なしの呼び出しでも子なし
  - `an unplugged receiver is forgotten`: 親を含まない一覧で呼んだあと、親を戻して `fresh` なしで呼ぶと `ask` が呼ばれる
  - `serialize runs calls on one key one at a time`: 同じ key で 2 つの fn を同時に渡し、1 つ目が終わる前に 2 つ目が始まらないこと（開始・終了の記録の順が `['a+', 'a-', 'b+', 'b-']`）。1 つ目が reject しても 2 つ目は走る。別の key は待たない

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/lightspeed.test.js` / Expected: FAIL（`expandReceivers is not a function`）

- [ ] **Step 3: 実装する** — `serialize`・`scanReceiver`・`expandReceivers`・cache・`_reset` を書く。`realAsk` はこの Task では `() => () => Promise.reject(new Error('not wired'))` の仮でよい（Task 3 で置き換える）

- [ ] **Step 4: 通ることを確かめる** — Run: `npm test` / Expected: 全部 PASS

- [ ] **Step 5: Commit** — `git add src/main/hid/drivers/lightspeed.js test/lightspeed.test.js && git commit -m "feat(hidpp): expand a Lightspeed receiver into its paired devices, remembered per receiver (#2)"`

### Task 3: レジスタの実際のやり取りと、enumerate までの配線

**Files:**
- Modify: `src/main/hid/drivers/lightspeed.js`（`realAsk`）
- Modify: `src/main/hid/hid-worker.js:12`
- Modify: `src/main/hid/hid-client.js:77`
- Modify: `src/main/poller.js`（`invalidateLiveCache` / `getLiveDevices`）
- Modify: `src/main/main.js:270-292`（`devices:list-live`）
- Test: `test/lightspeed.test.js`、`test/poller.test.js`

**Interfaces:**
- Consumes: Task 2 の `expandReceivers(devices, { fresh })`
- Produces:
  - `lightspeed.request(sub) -> number[]` = `[0x10, 0xff, 0x83, 0xb5, sub, 0x00, 0x00]`（7 バイト）
  - `lightspeed.replyTo(frame, sub) -> number[] | null` — `[0x11, 0xff, 0x83, 0xb5, sub, ...]` なら `frame.slice(4)`。`[0x10, 0xff, 0x8f, 0x83, 0xb5, code]` なら `Error('register error <code>')` を投げる。それ以外は `null`
  - `hidClient.enumerate(options?: { fresh?: boolean })` → worker の `enumerate` の `args[0]`
  - worker: `enumerate` は `expandReceivers(await listLogicalDevices(), { fresh: !!(args[0] && args[0].fresh) })`

- [ ] **Step 1: 失敗するテストを書く**
  - `lightspeed.test.js` — `register requests and replies match what the receiver sent`: `request(0x20)` が `[0x10,0xff,0x83,0xb5,0x20,0,0]`。`replyTo(pad([0x11,0xff,0x83,0xb5,0x20,7,8,0x40,0x8e],20), 0x20)` の `[0]` が `0x20`。`replyTo(..., 0x21)` が `null`。`replyTo([0x10,0xff,0x8f,0x83,0xb5,0x09,0], 0x20)` が `/register error 9/` を投げる。ほかの機器への返答（`frame[1] !== 0xff`）は `null`
  - `poller.test.js` — `a refresh asks the worker to list receivers afresh, a routine poll does not`: `hidClient.enumerate` に渡った引数を記録し、`pollOnce(..., { force: true })` のあとの最初の呼び出しが `{ fresh: true }`、そのあとの通常の poll（キャッシュ切れで取り直すとき）が `{ fresh: false }`（または引数なし）

- [ ] **Step 2: 失敗を確かめる** — Run: `npm test` / Expected: 上の 2 つが FAIL

- [ ] **Step 3: 実装する**
  - `realAsk(parent)`: 短い collection（`0xFF00/0x0001`）と長い collection（`0xFF00/0x0002`）の handle を `session.acquire` で取る。両方を `readQueued` で空にし、短い側に `request(sub)` を `session.write`。両方を短い間隔（例: 50 ms ずつ）で交互に `session.read` し、`replyTo` が値を返すか投げるまで待つ。全体の待ち時間は 400 ms。過ぎたら `Error('timeout waiting for register reply')`
  - worker・hid-client は上の Interfaces のとおり
  - poller: `invalidateLiveCache()` で `wantFresh = true` にし、`getLiveDevices` は `hidClient.enumerate({ fresh: wantFresh })` を呼んでから `wantFresh = false` にする（読み取りの失敗で取り直すときは fresh にしない）
  - main の `devices:list-live`: `hidClient.enumerate({ fresh: true })`。`hid` の配列を作る前に `d.expanded` の親を除く。ほかの `enumerate` の呼び出し（capture・diagnostics・device report・起動時）は変えない

- [ ] **Step 4: 通ることを確かめる** — Run: `npm test` / Expected: 全部 PASS

- [ ] **Step 5: Commit** — `git add src/main/hid/drivers/lightspeed.js src/main/hid/hid-worker.js src/main/hid/hid-client.js src/main/poller.js src/main/main.js test/lightspeed.test.js test/poller.test.js && git commit -m "feat(hidpp): ask the receiver for its pairings when devices are listed (#2)"`

### Task 4: 子のスロットだけを読む

**Files:**
- Modify: `src/main/hid/drivers/hidpp.js:105-153`（`findRoute` / `readBattery` / `routes`）
- Test: `test/protocols.test.js`（既存の Logitech のテストの近く。`exchange.exchange` を差し替える書き方に合わせる）

**Interfaces:**
- Consumes: Task 1 の `logicalDevice.receiver = { slot, wpid, kind }`、Task 2 の `lightspeed.serialize(key, fn)`
- Produces: `hidpp.readBattery(logicalDevice)` — `receiver` があればスロット `[receiver.slot]` だけを探す。読み先のキーは `receiver ? \`${channel.path}|${receiver.wpid}\` : channel.path`。覚えた読み先の `device` が `receiver.slot` と違えば捨てて探し直す。本体全体を `serialize(channel.path, ...)` で包む

- [ ] **Step 1: 失敗するテストを書く**（偽の exchange: スロット 1 = 0x1001 が index 7、電圧 `10 2d 00`（4141 mV）。スロット 2 = 0x1004 が index 6、`51 08 00 00`（81%）。ほかのスロットは timeout。呼ばれた device 番号を記録する）
  - `Logitech: each child of a receiver reads its own slot`: `receiver.slot: 2` の子 → capacity 81、記録に device 1 が無い。`receiver.slot: 1` の子 → 電圧 4141 mV のreading。同じ `channel.path` の 2 台を交互に読んでも、それぞれ自分の値のまま
  - `Logitech: a child whose slot moved looks for its battery again`: slot 2 の子を一度読んだあと、同じ wpid で `receiver.slot: 1` の子を読むと、device 1 に feature の問い合わせ（index 0）が送られる
  - `Logitech: the receiver itself still reads its first device`: `receiver` の無い親（product `USB Receiver`）は今と同じくスロット 1 のキーボードを読む
  - `Logitech: a child that is asleep reads as not answering`: slot 2 を timeout にすると `/^Error: device is not answering$/`

- [ ] **Step 2: 失敗を確かめる** — Run: `node --test test/protocols.test.js` / Expected: 上の新しいテストが FAIL

- [ ] **Step 3: 実装する** — 上の Interfaces のとおり。`findRoute(channel, logicalDevice)` のスロットの候補は `receiver ? [receiver.slot] : 今の規則`

- [ ] **Step 4: 通ることを確かめる** — Run: `npm test` / Expected: 全部 PASS

- [ ] **Step 5: Commit** — `git add src/main/hid/drivers/hidpp.js test/protocols.test.js && git commit -m "feat(hidpp): read each device on a receiver from its own slot (#2)"`

### Task 5: カードの設定が機器ごとに残ることと、実機の確認

**Files:**
- Test: `test/poller.test.js`

**Interfaces:**
- Consumes: Task 1 の `identityOf` の規則と子の ID の形、Task 3 の `enumerate({ fresh })`

- [ ] **Step 1: テストを書く** — `two cards on one receiver keep their own settings when the devices swap slots`:
  - `devices` に子のカード 2 枚（`1133:50503:0123456789ab:408e` と `...:409f`、`driverId: 'hidpp'`）を、別々の `customName` / `customIcon` / `order` / `history` で置く。`408e` は `hidden: false`、history `[{ t: Date.now() - 60000, c: 50, ch: 0 }]`。`409f` は `hidden: true`、history `[{ t: Date.now() - 120000, c: 60, ch: 0 }]`（`history.js` の要素の形。7 日より古い点は `pushHistory` が捨てるので、最近の時刻にする）
  - `hidClient.enumerate` は、親（`expanded: true`）と 2 台の子を、1 回目はスロット 1/2、2 回目はスロット 2/1 で返す。`hidClient.readBattery` は `(driverId, device) => ({ capacity: device.receiver.wpid === 0x408e ? 95 : 81, charging: false })` で即座に返す
  - `poller.pollOnce(() => {}, { force: true })` を 2 回呼ぶ（`force` で 2 回目の一覧が取り直され、入れ替えたスロットが届く）
  - 期待: `Object.keys(devices)` に 2 枚とも残る（まとめられない）。それぞれの `customName` / `customIcon` / `order` / `hidden` が最初のまま。`408e` の history は最初に置いた要素（`c: 50`）で始まり、最後の要素の容量が 95、`lastReading.capacity` が 95。`409f` は非表示なので読まれず、history は最初のまま（`deepEqual`）、`lastReading` は無い。2 回目の `readBattery` に渡った `408e` の子の `receiver.slot` が 2
  - テストの終わりに、ほかのテストが使う `hidClient` の差し替えと `devices` を元に戻す

- [ ] **Step 2: 通ることを確かめる** — Run: `npm test` / Expected: 全部 PASS（Task 1〜4 で実装済みなので、新しいテストも通るはず。通らなければ原因を直す）

- [ ] **Step 3: Commit** — `git add test/poller.test.js && git commit -m "test(poller): two devices on one receiver keep their own cards (#2)"`

- [ ] **Step 4: 実機で確かめる**（HUMAN と一緒に。branch を push し、fork の手動ビルドを実行する: `gh workflow run build.yml -R rurute/battery-hub --ref feat/lightspeed-multi-slot` → `gh run watch -R rurute/battery-hub` → `gh run download -R rurute/battery-hub -D dist/ci`）。HUMAN が Windows でインストールして次を確かめる:
  - Add device に `G913 TKL` と `G502 X LS` が別々に出て、レシーバーそのものは出ない
  - 2 枚とも追加すると、それぞれに、その機器のバッテリーが出る。同じときの G HUB の表示と大きく違わない（キーボードは電圧から換算するので数 % の差はありうる）
  - マウスを寝かせても、キーボードのカードは読み続けられ、マウスのカードは今のスリープ時と同じ表示になる
  - 既存のレシーバーのカードが今のまま読める
  - 2 枚に別々の名前とアイコンを付け、アプリを再起動しても残っている
- [ ] **Step 5: エラーの返答が届く collection を確かめる**（spec の「どちらに届いたかは実機で確かめる」）。Issue #2 の調査と同じく、WSL から Windows の PowerShell で HID API を呼ぶ。Battery Hub は終了しておく。レシーバーの COL01（`0xFF00/0x0001`）に空のスロット 3 の pairing info の問い合わせ `10 ff 83 b5 22 00 00` を書き、COL01 と COL02（`0xFF00/0x0002`）をそれぞれ 1 秒ずつ読み、`10 ff 8f 83 b5 ..` がどちらに届いたかを記録する。あわせて、レシーバーの HID のシリアル番号が 12 桁の 16 進の形かを記録する。どちらの結果でも Task 3 の `realAsk`（両方の collection を読む）はそのままでよい。結果が spec の前提（短い側に書けば返答が受け取れる）と食い違えば、実装を進めずに HUMAN に報告する

- [ ] **Step 6: 報告する** — Step 4・5 の結果を HUMAN に報告する。Issue #2 にコメントするかは HUMAN に聞く

## レビューの記録

### 1 回目（Codex、run `20261124-184525-plan`）

- 対象 HEAD: `0bdec43`、比較元: なし（新規）、要求源: spec（承認時の HEAD `77c3f1f`）、verdict: CHANGES_REQUESTED、採用ゲート 0・A〜D を満たし採用、MCP の起動ログ: clean
- 直した D:
  - F1: Task 5 の `pollOnce` の呼び方が実際の引数と違っていた → `pollOnce(() => {}, { force: true })` にした
  - F2: Task 5 で、非表示の状態と履歴が機器ごとに残ることを確かめていなかった → 2 枚で別々の値にし、確かめる項目に足した
  - F3: live の子 2 台がまとめられないことを確かめていなかった → Task 1 に足した
  - F4: Task 2〜5 の commit に `git add` が無かった → 足した
  - F5: エラーの返答が届く collection を実機で確かめる手順が無かった → Task 5 Step 5 を足した

### 2 回目（Codex、run `20261124-184833-plan`）

- 対象 HEAD: `dcc35ac`、比較元: `0bdec43`、verdict: APPROVE、採用ゲート 0・A〜D を満たし採用、MCP の起動ログ: clean
- 前回の F1〜F5 はすべて addressed。新しい指摘なし。S / H なし

### 残る限界

- 実機での動き（エラーの返答が届く collection、レシーバーのシリアル番号の形、名前の返答の生のバイト列、G HUB との比較）は確かめていない
- APPROVE は、計画が承認済みの spec と整合しているというレビュアの判定である。実装済み・テスト成功・HUMAN の承認のどれでもない
