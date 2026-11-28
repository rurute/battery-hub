# タスクバーにデバイスの絵と残量を並べて出す Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設定で ON にすると、Windows 11 のタスクバーのトレイのすぐ左に、接続中のデバイスごとに「種類の絵 + 残量」を並べて出す（fork だけの機能、fork Issue #16）。

**Architecture:** Node の `src/main/taskbar-model.js`（純粋な関数）が、保存されたデバイスから「出す一覧」を作り、1 行の JSON にする。`src/main/taskbar.js` が C# の `taskbar-battery.exe` を起こし、その行を標準入力へ送る。exe は inzone-auto-switch のタスクバー表示（最前面のレイヤード窓、`TrayNotifyWnd`、UI Automation）を C# 5 に移したもので、位置の計算・出すか隠すかの判定・描画をすべて行う。デバイスや設定の変化は、`store` の書き込み関数を `taskbar.js` が包んで受け取る。終了は Electron の `will-quit` で受ける。こうして `main.js` のつなぎを 2 行に抑える。

**Tech Stack:** Node（`node:test`）、Electron 45、C# 5 / .NET Framework 4（Windows に付いている `csc.exe`、WinForms、GDI+、`UIAutomationClient`）。

**Spec:** `docs/superpowers/specs/2026-11-28-taskbar-battery-design.md`（HUMAN 承認 `e538671`）。参照実装は `../inzone-auto-switch/src/AutoSwitch.App/`（`TaskbarProbe.cs` `TaskbarOverlayWindow.cs` `TaskbarOverlayPolicy.cs` `TaskbarOverlayController.cs` `TaskbarBatteryOverlay.cs` `BatteryOverlayRenderer.cs` `NativeMethods.cs`、テスト `../inzone-auto-switch/tests/AutoSwitch.App.Tests/TaskbarOverlayPolicyTests.cs`）。

## Global Constraints

- fork だけの変更。本体は新しいファイルに置く。本家のファイルへの変更は数行のつなぎだけにし、`// fork:`（HTML は `<!-- fork: -->`、`.gitignore` は `# fork:`）の目印を付ける（`docs/fork.md`）。
- 設定のキーは `taskbarBattery`（真偽）。既定は `false`。`store.js` の `DEFAULT_SETTINGS` は変えない（値がなければ `false` とみなす。トグルは `!!s[key]` で OFF と出る）。
- 少ないの基準は **20% 以下で固定**。充電中でも 20% 以下ならオレンジ。通知のしきい値とは結び付けない。
- 色: 文字と絵はダークのタスクバーで白、ライトで黒。少ないときの数字と `%` は、ダーク `#FF9F43`、ライト `#C2410C`。
- C# は `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` でビルドできること（C# 5。`?.`、`$""`、式形式のメンバー、`nameof`、record、`using var`、パターンマッチ、`is null` は使えない）。
- exe の失敗は、読み取り・トレイ・通知・ウィンドウを止めない。
- Electron の側では、実行中に画像を作らない（絵の PNG はビルド時に作ってリポジトリに入れる）。
- 画面に出す英語の文言には、ポルトガル語の訳が要る（`test/i18n-screen.test.js`）。
- 開発機は WSL。`npm test` は WSL で通ること。C# のビルドと実行は、WSL から `/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe` を呼んで確かめる（Windows の相互運用）。
- コミットに claude.ai のセッションの URL を書かない。

## 決めたこと（spec が builder に任せた所）

- **つなぎ方**: spec が並べた個々のつなぎ（`broadcast`、`setCardsChangedHandler`、並べ替え・隠す・絵の IPC、`settings:set`）の代わりに、`taskbar.start({ store, logLine, app })` が `store` の書き込み関数（`upsertDevice` `removeDevice` `mergeDevices` `moveDevice` `reorderDevices` `setSettings`）を包み、呼ばれたら表示を更新する。どのモジュールも `store` をモジュールのまま使っている（`const store = require('./store')`）ので、全部の変化を拾える。終了は `app.on('will-quit', stop)` を `taskbar.start` の中で登録して受ける。`quitApp` を通らない終わり方（`autoUpdater.quitAndInstall()` は `app.quit()` を呼ぶ）でも止まる。`main.js` へのつなぎは、`require` と起動の 2 行で済む。
- **更新はまとめる**: 包んだ関数は `refresh()` を呼ぶ。`refresh()` は 50ms のタイマーでまとめ、`store.getDevices()`（履歴ごと複製するので重い）を 1 回だけ呼ぶ。
- **やりとりの形**（spec のとおり、1 行 1 つの JSON）:
  - Node → exe: `{"devices":[{"icon":"mouse","level":82,"charging":false,"low":false}]}`。`devices` が空なら「何も出さない」。C# は .NET Framework 4 の `DataContractJsonSerializer`（`System.Runtime.Serialization.dll`）で読む。
  - exe → Node（標準出力）: `WARN <文>`、`INFO <文>`、`ERROR <文>` の 1 行ずつ。
- **exe の引数**: `--parent <pid> --assets <絵のフォルダ>`。確認用に `--self-test`。
- **古い残量**: 「この起動のあとに読めた」は `lastReadingAt >= taskbar.start() を呼んだ時刻` で決める。「読めない状態」は `failedReads >= 3`（`app.js` の `READS_BEFORE_REPORT`。窓のスクリプトなので値を写す）。`'waiting for headset update'` は、新しい読み取りがないので、前の条件で外れる。
- **絵**: `assets/taskbar/<name>-<white|black>-<px>.png`。名前は `mouse keyboard headset mic speaker camera controller pen plug flash`。大きさは 16 / 20 / 24 / 32 px（表示倍率 100 / 125 / 150 / 200%）。ほかの倍率では、`16 * dpi / 96` 以上で最も小さいものを縮めて使う（なければ 32 を拡大）。
- **C# のテスト**: `taskbar-battery.exe --self-test` が判定の表を走らせ、`PASS <件数>` か `FAIL <名前>: <理由>` を出し、終了コード 0 / 1 を返す。`test/taskbar-exe.test.js` が Windows で exe があれば走らせ、なければスキップする。WSL では、相互運用で走らせて確かめる。
- **翻訳のつなぎ**: 訳は `src/renderer/i18n-fork.js` に置く。窓では `index.html` が `<script>` で読み、Node（テスト・メインプロセス）では `i18n-strings.js` の末尾の 1 行が `require` する。

## Review Focus

- exe が起動直後に落ち続ける（DLL や Windows の版の違い）: 起動し直しは間を広げ、5 回目に落ちたらあきらめ、ログに ERROR を 1 回書く。設定を OFF→ON にすると、もう一度試す（Task 3 のテスト）。
- 標準入力への書き込みで、exe が先に終わっていた（EPIPE）: 例外を投げず、`stdin` の `error` を受けて「終わった」と同じに扱う（Task 3 のテスト）。
- 読み取りが同時に何台も届き、`store` の書き込みが立て続けに起きる: `getDevices()` は 50ms に 1 回だけ（Task 3 のテスト）。
- 保存した絵の名前が知らないもの（昔の版の絵文字、手で書き換えた設定）: `icons.js` と同じ決め方で推定に戻る。絵のファイルがない名前が exe に届いたら `plug` を使う（Task 1 と Task 5 の自己テスト）。
- 残量の値が範囲外（`-1`、`101`、小数）: Node が 0〜100 の整数に丸めて送る（Task 1 のテスト）。exe は読めない行を捨てて前の表示のままにし、範囲外の値を収める（Task 4 の自己テスト）。

---

### Task 1: 出す一覧を決める純粋な関数（`taskbar-model.js`）

**Files:**
- Create: `src/main/taskbar-model.js`
- Test: `test/taskbar-model.test.js`

**Interfaces:**
- Consumes: `src/renderer/estimate.js` の `urgencyCompare`（`require` できる）。`src/renderer/icons.js`（`module.exports` がない。`vm` で読む）。
- Produces:
  - `LOW_AT = 20`、`READS_BEFORE_REPORT = 3`
  - `ICON_PATHS: { [name]: string }`（`icons.js` のもの。Task 2 が使う）
  - `iconName(device) -> string`（`icons.js` の `deviceIconName` と同じ結果）
  - `visibleDevices(devices: { [id]: device }, settings: { sortMode }, sinceMs: number) -> device[]`
  - `itemsFor(devices, settings, sinceMs) -> Array<{ icon: string, level: number, charging: boolean, low: boolean }>`
  - `lineFor(items) -> string`（`JSON.stringify({ devices: items })`。0 件は `{"devices":[]}`）

- [ ] **Step 1: 失敗するテストを書く**（`test/taskbar-model.test.js`。デバイスは `{ id, product, driverId, customIcon, hidden, online, order, failedReads, lastReading: { capacity, charging }, lastReadingAt }` の形で作る。`SINCE = 1000`）

```js
test('shows only devices read since start, online, not hidden, readable', () => {
  const d = {
    ok:      dev({ id: 'ok', capacity: 50, at: 2000 }),
    before:  dev({ id: 'before', capacity: 50, at: 999 }),      // read before this launch
    off:     dev({ id: 'off', capacity: 50, at: 2000, online: false }),
    hidden:  dev({ id: 'hidden', capacity: 50, at: 2000, hidden: true }),
    failing: dev({ id: 'failing', capacity: 50, at: 2000, failedReads: 3 }),
    once:    dev({ id: 'once', capacity: 50, at: 2000, failedReads: 2 }),
    none:    dev({ id: 'none', capacity: null, at: 2000 }),
  };
  assert.deepEqual(visibleDevices(d, { sortMode: 'urgent' }, SINCE).map((x) => x.id).sort(), ['ok', 'once']);
});
test('urgent order matches the cards: draining first, then charging', () => {
  const d = { c10: dev({ id: 'c10', capacity: 10, charging: true, at: 2000 }), d80: dev({ id: 'd80', capacity: 80, at: 2000 }) };
  assert.deepEqual(visibleDevices(d, { sortMode: 'urgent' }, SINCE).map((x) => x.id), ['d80', 'c10']);
});
test('manual order follows order', () => {
  const d = { a: dev({ id: 'a', capacity: 10, at: 2000, order: 2 }), b: dev({ id: 'b', capacity: 90, at: 2000, order: 1 }) };
  assert.deepEqual(visibleDevices(d, { sortMode: 'manual' }, SINCE).map((x) => x.id), ['b', 'a']);
});
test('low is 20 or below, also while charging', () => {
  const lvl = (capacity, charging = false) => itemsFor({ x: dev({ id: 'x', capacity, charging, at: 2000 }) }, {}, SINCE)[0].low;
  assert.equal(lvl(20), true); assert.equal(lvl(21), false); assert.equal(lvl(0), true); assert.equal(lvl(15, true), true);
});
test('low ignores the notification thresholds', () => {
  const low = (capacity, alertThreshold, notifyThreshold) =>
    itemsFor({ x: dev({ id: 'x', capacity, at: 2000, alertThreshold }) }, { notifyThreshold }, SINCE)[0].low;
  assert.equal(low(15, undefined, 10), true);   // below 20 even if notifications fire at 10
  assert.equal(low(25, undefined, 30), false);  // above 20 even if notifications fire at 30
  assert.equal(low(25, 40, 20), false);         // a device's own alert level doesn't count
  assert.equal(low(20, 5, 5), true);
});
test('levels are clamped to whole numbers 0..100', () => {
  const lv = (capacity) => itemsFor({ x: dev({ id: 'x', capacity, at: 2000 }) }, {}, SINCE)[0].level;
  assert.equal(lv(-1), 0); assert.equal(lv(101), 100); assert.equal(lv(49.6), 50);
});
test('icon names match the window', () => {
  assert.equal(iconName({ customIcon: 'keyboard' }), 'keyboard');
  assert.equal(iconName({ customIcon: '🎧' }), 'headset');            // old saved emoji
  assert.equal(iconName({ product: 'G502 Mouse' }), 'mouse');         // guessed
  assert.equal(iconName({ customIcon: 'nonsense', product: 'X' }), 'plug');
});
test('line format', () => {
  assert.equal(lineFor([{ icon: 'mouse', level: 82, charging: false, low: false }, { icon: 'headset', level: 18, charging: true, low: true }]),
    '{"devices":[{"icon":"mouse","level":82,"charging":false,"low":false},{"icon":"headset","level":18,"charging":true,"low":true}]}');
  assert.equal(lineFor([]), '{"devices":[]}');
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/taskbar-model.test.js`
Expected: FAIL（`Cannot find module '../src/main/taskbar-model'`）

- [ ] **Step 3: `src/main/taskbar-model.js` を書く**

`icons.js` は `vm.runInNewContext(src + '\n;this.__x = { ICON_PATHS, deviceIconName };', {})` のように読み、`ICON_PATHS` と `deviceIconName` を取り出す（トップレベルの `const` は文脈に載らないので、同じスクリプトの中で拾う）。表示の条件は「決めたこと」の「古い残量」。並びは `sortMode === 'manual'` なら `(a.order ?? 1e9) - (b.order ?? 1e9)`、それ以外は `urgencyCompare`。`charging` は `!!lastReading.charging`。

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/taskbar-model.test.js && npm test`
Expected: PASS（全体も、既存のテストを壊していない）

- [ ] **Step 5: コミット**

```bash
git add src/main/taskbar-model.js test/taskbar-model.test.js
git commit -m "feat(fork): タスクバーに出すデバイスの一覧を決める"
```

### Task 2: 絵の PNG を作る

**Files:**
- Create: `scripts/make-taskbar-icons.js`、`assets/taskbar/*.png`（80 枚）
- Test: `test/taskbar-icons.test.js`

**Interfaces:**
- Consumes: Task 1 の `ICON_PATHS`。
- Produces: `assets/taskbar/<name>-<white|black>-<px>.png`（`name` は「決めたこと」の 10 種、`px` は 16 / 20 / 24 / 32）。正方形・背景透明。Task 5 が読む。

- [ ] **Step 1: 失敗するテストを書く**: `test/taskbar-icons.test.js` で、10 種 × 2 色 × 4 大きさの全ファイルについて、PNG の署名（`89 50 4E 47`）と、IHDR の幅・高さが `px` であることを確かめる（IHDR はバイト 16〜23 のビッグエンディアン）。

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/taskbar-icons.test.js`
Expected: FAIL（ファイルがない）

- [ ] **Step 3: `scripts/make-taskbar-icons.js` を書く**: `scripts/make-icon.js` と同じく、隠した `BrowserWindow` の canvas に、`viewBox 0 0 20 20` の `Path2D(ICON_PATHS[name])` を `px / 20` 倍で塗り（白 `#FFFFFF` か黒 `#000000`）、`toDataURL('image/png')` を書き出す。`make-icon.js` は変えない。

- [ ] **Step 4: 作って確かめる**

Run: `npx electron scripts/make-taskbar-icons.js && node --test test/taskbar-icons.test.js`
Expected: PASS。`assets/taskbar/mouse-white-32.png` を Read で開き、白いマウスの形が見える。

- [ ] **Step 5: コミット**

```bash
git add scripts/make-taskbar-icons.js assets/taskbar test/taskbar-icons.test.js
git commit -m "feat(fork): タスクバー用のデバイスの絵を作る"
```

### Task 3: exe を起こして一覧を送る（`taskbar.js`）

**Files:**
- Create: `src/main/taskbar.js`
- Test: `test/taskbar.test.js`

**Interfaces:**
- Consumes: Task 1 の `itemsFor` と `lineFor`。
- Produces:
  - `start({ store, logLine, app, spawn?, exists?, platform?, exePath?, assetsDir?, now?, setTimer?, clearTimer? }) -> void`: `store` の書き込み関数を包み、`app.on('will-quit', stop)` を登録し、最初の `refresh()` を予約する。既定は `spawn = child_process.spawn`、`exists = fs.existsSync`、`platform = process.platform`、`exePath = path.join(__dirname, 'taskbar-battery.exe')`、`assetsDir = path.join(__dirname, '..', '..', 'assets', 'taskbar')`。
  - `refresh() -> void`: 50ms でまとめて更新する。
  - `stop() -> void`: exe を止め（`stdin.end()` のあと `kill()`）、タイマーを消す。`will-quit` で呼ばれる。

- [ ] **Step 1: 失敗するテストを書く**（`test/taskbar.test.js`）。偽物を使う。`spawn` は `EventEmitter` に `stdin: { write, end, on }`、`stdout: EventEmitter`、`kill()` を付けたものを返して記録する。タイマーは手で進める。`store` は `getDevices`、`getSettings`、包まれる関数を持つ偽物。

```js
test('off by default: no exe is started');                 // settings without taskbarBattery
test('turning it on starts the exe with --parent and --assets, and sends the line');
test('the same line is not sent twice; a changed line is sent');
test('turning it off stops the exe');
test('app will-quit stops the exe');                       // fake app is an EventEmitter
test('store writes in a burst read the devices once');      // 10 upsertDevice calls → getDevices once after the timer
test('wrapped store functions return what the originals return');
test('exe missing or not Windows: never spawns, logs INFO once, no throw');
test('exe exits unexpectedly: restarts after 1s and resends the last line');
test('quick exits restart 4 times (1s, 2s, 4s, 8s); the 5th exit gives up and logs ERROR once; off then on tries again');
test('a run of 60s or more resets the crash count');
test('stdin error (EPIPE) is treated like an exit, not thrown');
test('stdout WARN/INFO/ERROR lines go to logLine with the same level, prefixed "taskbar: "');
```

それぞれ、`spawn` の呼ばれた回数と引数、`stdin.write` に渡った文字列（行末 `\n` 付き）、`logLine` の `(tag, msg)` を確かめる。

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/taskbar.test.js`
Expected: FAIL（モジュールがない）

- [ ] **Step 3: `src/main/taskbar.js` を書く**: 有効かどうかは `store.getSettings().taskbarBattery === true`。`spawn(exePath, ['--parent', String(process.pid), '--assets', assetsDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })`。標準出力は行に分け、`/^(WARN|INFO|ERROR) (.*)$/` に合えばその段で、合わなければ `INFO` で `logLine` へ書く。`n` は続けて落ちた回数。落ちるたびに `n += 1`（その前に、60 秒以上動いていたら `n = 0` に戻す）。`n >= 5` ならあきらめ、それ以外は `1000 * 2 ** (n - 1)` ms 待って起動し直す。`spawn` の `error` イベントも「終わった」と同じに扱う。

- [ ] **Step 4: 通ることを確かめる**

Run: `node --test test/taskbar.test.js && npm test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/main/taskbar.js test/taskbar.test.js
git commit -m "feat(fork): タスクバーの表示のプログラムを起こして一覧を送る"
```

### Task 4: C# の骨組み・判定・自己テスト・ビルド

**Files:**
- Create: `src/main/batteries/taskbar/Protocol.cs`（`OverlayItem` と JSON の読み取り）、`src/main/batteries/taskbar/Policy.cs`、`src/main/batteries/taskbar/SelfTest.cs`、`src/main/batteries/taskbar/Program.cs`（この Task では `--self-test` だけを受ける）、`scripts/build-taskbar-battery.js`、`test/taskbar-exe.test.js`
- Modify: `scripts/build-batteries.js`（末尾に `require('./build-taskbar-battery'); // fork:` の 1 行）、`.gitignore`（末尾に `# fork: taskbar battery levels` と `src/main/taskbar-battery.exe` の 2 行。`.gitignore` は行末にコメントを書けないため）

**Interfaces:**
- Produces（C#、`namespace BatteryHubTaskbar`）:
  - `sealed class OverlayItem { string Icon; int Level; bool Charging; bool Low; }`
  - `static class Protocol { static List<OverlayItem> ParseLine(string line); }`: `DataContractJsonSerializer` で `{"devices":[...]}` を読む（`[DataContract]` の `Message { [DataMember(Name="devices")] List<WireItem> }`、`WireItem` は `icon` `level` `charging` `low`）。読めない行は `null` を返す（呼び出し側は前の表示のまま、`ERROR` を 1 行書く）。`icon` が空の項目は飛ばす。`Level` は 0〜100 に収める。
  - `sealed class TaskbarSnapshot { Rectangle Taskbar; Rectangle Monitor; int TrayLeft; int AppsRight; }`、`sealed class ProbeResult { TaskbarSnapshot Snapshot; string Error; }`
  - `enum HideReason { None, NoItems, TaskbarUnavailable, TaskbarHidden, Fullscreen, NoSpace }`
  - `sealed class Policy { Policy(Action<string, string> log); Decision Evaluate(int itemCount, ProbeResult probe, bool fullscreen, Size overlaySize, int dpi); }`。`Decision { Rectangle? Bounds; HideReason Reason; }`。inzone の `TaskbarOverlayPolicy.Evaluate` の移し替えで、`enabled` と `level` の代わりに `itemCount == 0 → NoItems`。余白 4、間 8（96 dpi 基準）。Warn / Info の文は英語にする: `WARN Can't show taskbar levels: <理由>`、`INFO Taskbar levels can be shown again.`（理由は `overlaps the taskbar buttons` と、位置の取得の失敗の文）。
  - `scripts/build-taskbar-battery.js`: ソースのどれかが exe より新しいときだけ、`/nologo /target:winexe /optimize+ /platform:anycpu /out:src/main/taskbar-battery.exe src/main/batteries/taskbar/*.cs` に、`System.Drawing.dll` `System.Windows.Forms.dll` `System.Runtime.Serialization.dll` と `WPF\UIAutomationClient.dll` `WPF\UIAutomationTypes.dll` `WPF\WindowsBase.dll` の参照を付けて作る。コンパイラは、Windows では `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`、WSL（`/mnt/c/Windows/...` に `csc.exe` があり、`wslpath` がある）ではそれを、パスを `wslpath -w` で直して呼ぶ。どちらもなければスキップする。失敗したとき: 直接 `node scripts/build-taskbar-battery.js` で走らせた（`require.main === module`）なら、いつも終了コード 1 で止める（確認の手順で、古い exe を走らせないため）。`build-batteries.js` から `require` されたときは、環境変数 `CI` が `true` なら例外で止め（CI で exe のないインストーラーを作らないため）、それ以外はログを出してスキップする（開発中の `npm start` を止めない）。

- [ ] **Step 1: 自己テストの表を書く**（`SelfTest.cs`）。inzone の `TaskbarOverlayPolicyTests` の 13 件（`Normal_PlacesLeftOfTrayCentered`、`NoLevel_Hides` → `NoItems_Hides`、`NullProbe_HidesAsUnavailable`、`ProbeError_HidesAndWarnsOnce`、`RecoversAfterError_ShowsAndInfoOnce`、`NoSpace_HidesAndWarnsOnce`、`ExactlyEnoughSpace_Shows`、`TaskbarHidden_HidesWithoutLog`、`Fullscreen_HidesWithoutLog`、`FullscreenWhileWarned_DoesNotResetWarning`、`Dpi144_ScalesMarginAndGap`、`Dpi144_GapIsScaled`。`Disabled_Hides` は除く）を、同じ入力と期待値で移す。`Protocol.ParseLine` の件も足す: `{"devices":[{"icon":"mouse","level":82,"charging":false,"low":false},{"icon":"headset","level":18,"charging":true,"low":true}]}` → 2 件で値が合う。`{"devices":[]}` → 0 件。`{"devices":[{"icon":"","level":5,"charging":false,"low":true},{"icon":"pen","level":5,"charging":false,"low":true}]}` → `pen` の 1 件。`{"devices":[{"icon":"mouse","level":150,"charging":false,"low":false}]}` → `Level == 100`。`not json` → `null`。

- [ ] **Step 2: Node から走らせるテストを書く**（`test/taskbar-exe.test.js`）: `process.platform === 'win32'` で `src/main/taskbar-battery.exe` があるときだけ、`--self-test --assets <repo>/assets/taskbar` を走らせ、終了コード 0 と `/^PASS \d+/` を確かめる。exe がなく、環境変数 `CI` が `true` なら失敗にする（CI が自己テストを飛ばして通らないように）。それ以外は `t.skip('needs Windows and taskbar-battery.exe')`。

- [ ] **Step 3: 失敗を確かめる（WSL から）**

Run:
```bash
node scripts/build-taskbar-battery.js; echo "build=$?"
./src/main/taskbar-battery.exe --self-test --assets "$(wslpath -w assets/taskbar)" | cat; echo "exit=${PIPESTATUS[0]}"
```
Expected: `Policy` と `Protocol` がまだないので、コンパイルに失敗する。

- [ ] **Step 4: `Protocol.cs`・`Policy.cs`・`Program.cs` を書く**: `Program.Main` は `--self-test` なら `SelfTest.Run()` の結果を終了コードにして返す。

- [ ] **Step 5: 通ることを確かめる**

Run: Step 3 と同じコマンド。
Expected: `build=0`、警告なしでコンパイルが通る。`PASS 17`（移した 12 件 + `ParseLine` の 5 件）と `exit=0`。`npm test` も通る（WSL では `taskbar-exe` がスキップ）。

- [ ] **Step 6: コミット**

```bash
git add src/main/batteries/taskbar scripts/build-taskbar-battery.js scripts/build-batteries.js .gitignore test/taskbar-exe.test.js
git commit -m "feat(fork): タスクバーの表示のプログラムの判定と自己テストを作る"
```

### Task 5: C# の本体（測る・描く・窓・入出力）

**Files:**
- Create: `src/main/batteries/taskbar/NativeMethods.cs`、`Probe.cs`、`Renderer.cs`、`OverlayWindow.cs`、`Controller.cs`
- Modify: `src/main/batteries/taskbar/Program.cs`、`SelfTest.cs`

**Interfaces:**
- Consumes: Task 4 の `Protocol`・`Policy`・型。Task 2 の絵のファイル名の決まり。Task 3 の引数（`--parent`、`--assets`）と出力の行の形。
- Produces:
  - `static class Renderer { static Bitmap Render(IList<OverlayItem> items, bool lightTheme, int dpi, IconSet icons); }`: inzone の `BatteryOverlayRenderer.Render` を、複数の項目に広げたもの。1 項目は「絵（16 px @96dpi）+ 間 4 + 数字と `%`」で、充電中は `%` のあとに間 2 と `flash` の絵（12 px @96dpi）。項目と項目の間は 12（96 dpi 基準）。高さ 32、フォント Segoe UI 13 px（96 dpi 基準）。形式は `Format32bppPArgb`。
  - `sealed class IconSet { IconSet(string assetsDir); Bitmap Get(string name, bool white, int px); }`: ファイルがない名前は `plug`。読んだ絵は覚えておく。
  - `Probe`（inzone の `Win32TaskbarProbe` の `Measure`・`IsFullscreenForeground`・`IsLightTheme`）、`OverlayWindow`（inzone の `TaskbarOverlayWindow`）、`Controller`（inzone の `TaskbarOverlayController` と `TaskbarBatteryOverlay` をまとめたもの。0.3 秒ごとの `Tick` と、別スレッドで 1 秒ごとの `Measure`。`TaskbarCreated` とテーマの変化に追従）。
  - `Program.Main`: STA の UI スレッドで WinForms のメッセージループを回す。別スレッドで標準入力を 1 行ずつ読み、`Control.BeginInvoke` で UI スレッドへ渡す。標準入力が閉じたら終わる。`--parent` のプロセスを 2 秒ごとに確かめ、いなくなったら終わる。予期しない例外は `ERROR <型>: <文>` を書いて続ける（UI スレッドの例外は `Application.ThreadException`）。標準出力は 1 行ごとに `Flush`。

- [ ] **Step 1: 自己テストの表に描画の件を足す**（`SelfTest.cs`）。inzone の `BatteryOverlayRendererTests` を手本に: 2 項目を描くと 1 項目より幅が広い。`low` の項目の数字の所にオレンジ（ダーク `#FF9F43`）の画素がある。`low` でなければない。充電中の項目は、充電していない同じ項目より幅が広い。`IconSet` に知らない名前を渡すと `plug` の絵が返る（`--assets` に Task 2 のフォルダを使う。自己テストは `--self-test --assets <dir>` で受ける）。

- [ ] **Step 2: 失敗を確かめる**

Run: Task 4 の Step 3 と同じコマンド。
Expected: `build` が 0 でない（`Renderer` がない）。exe は作り直されない。

- [ ] **Step 3: 5 つのファイルを書き、`Program.cs` を仕上げる**: inzone のコードを C# 5 に直して移す（「Global Constraints」の使えない書き方に注意）。DPI は inzone と同じく、`SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2)` で包む。UI Automation の要素の型は `System.Windows.Automation`（`UIAutomationClient.dll`）。

- [ ] **Step 4: 自己テストと動作を確かめる**

Run:
```bash
node scripts/build-taskbar-battery.js && echo build=0 || { echo build-failed; exit 1; }
./src/main/taskbar-battery.exe --self-test --assets "$(wslpath -w assets/taskbar)" | cat; echo "exit=${PIPESTATUS[0]}"
(echo '{"devices":[{"icon":"mouse","level":82,"charging":false,"low":false},{"icon":"keyboard","level":45,"charging":true,"low":false},{"icon":"headset","level":18,"charging":false,"low":true}]}'; sleep 8; echo '{"devices":[]}'; sleep 2) | ./src/main/taskbar-battery.exe --assets "$(wslpath -w assets/taskbar)" | cat
```
Expected: `build=0`。自己テストは `PASS <件数>` と `exit=0`。表示は、8 秒の間、Windows のタスクバーのトレイの左に 3 台ぶんが出て、`devices` が空の行で消え、標準入力が閉じると終わる。表示が出たことは、PowerShell の画面写真（`[System.Windows.Forms.Screen]` と `CopyFromScreen`）を撮り、Read で開いて確かめる。

- [ ] **Step 5: コミット**

```bash
git add src/main/batteries/taskbar
git commit -m "feat(fork): タスクバーにデバイスの絵と残量を描く"
```

### Task 6: アプリへのつなぎと設定の行

**Files:**
- Create: `src/renderer/i18n-fork.js`
- Modify: `src/main/main.js`（2 行）、`src/renderer/index.html`（設定の行と `<script>`）、`src/renderer/i18n-strings.js`（末尾の 1 行）
- Test: `test/taskbar-wiring.test.js`

**Interfaces:**
- Consumes: Task 3 の `start` と `stop`。
- Produces: 設定画面のトグル `data-setting="taskbarBattery"`。

- [ ] **Step 1: 失敗するテストを書く**（`test/taskbar-wiring.test.js`）:
  - `src/renderer/index.html` に `data-setting="taskbarBattery"` のトグルがある。
  - `require('../src/renderer/i18n-strings').BH_STRINGS.pt['Taskbar battery levels']` と、説明の文の訳がある。
  - `src/main/main.js` の、`// fork:` の付いた行が 2 行で、`require('./taskbar')` と `taskbar.start(` を含む。

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/taskbar-wiring.test.js`
Expected: FAIL

- [ ] **Step 3: つなぐ**
  - `main.js`: `const taskbar = require('./taskbar'); // fork: taskbar battery levels`。`app.whenReady` の `poller.start(broadcast);` の直後に `taskbar.start({ store, logLine, app }); // fork:`。
  - `index.html`: 「System tray」のパネルの `closeToTray` の行の後に、`<!-- fork: taskbar battery levels -->` を付けた `settings-row` を 1 つ足す。`data-depends` は付けない（トレイとは別の設定）。題名は `Taskbar battery levels`、説明は `Show each connected device's icon and level next to the tray.`。`<script src="i18n-strings.js"></script>` の直後に `<script src="i18n-fork.js"></script><!-- fork: -->`。
  - `i18n-fork.js`: `(function (apply) { if (typeof module !== 'undefined' && module.exports) module.exports = apply; else apply(BH_STRINGS); })(function (S) { /* pt, es, zh, he, ru の 2 文ずつを Object.assign */ });`
  - `i18n-strings.js`: `module.exports` の行の直前に `if (typeof require === 'function') require('./i18n-fork')(BH_STRINGS); // fork:`。

- [ ] **Step 4: 通ることを確かめる**

Run: `npm test`
Expected: PASS（`i18n-screen`・`i18n-ru`・`syntax` を含む）

- [ ] **Step 5: 画面を確かめる**: `npm start`（WSL の Electron）で設定画面を開き、行が出て、ON/OFF が保存されることを確かめる（Windows ではないので、表示は出ない。ログに `taskbar:` の INFO が 1 回だけ出る）。

- [ ] **Step 6: コミット**

```bash
git add src/main/main.js src/renderer/index.html src/renderer/i18n-strings.js src/renderer/i18n-fork.js test/taskbar-wiring.test.js
git commit -m "feat(fork): タスクバーの表示をアプリと設定画面につなぐ"
```

### Task 7: 記録・CI・実機での確認

**Files:**
- Modify: `docs/fork.md`（「fork だけのもの」の表）、`.github/workflows/build.yml` と `.github/workflows/fork-release.yml`（fork だけのファイル）

- [ ] **Step 1: `docs/fork.md` に足す**: 表に 1 行「タスクバーの残量表示（fork Issue #16）」。目的と、ファイル（`src/main/taskbar.js` `src/main/taskbar-model.js` `src/main/batteries/taskbar/` `scripts/build-taskbar-battery.js` `scripts/make-taskbar-icons.js` `assets/taskbar/` `src/renderer/i18n-fork.js` とテスト）、`// fork:` のつなぎ（`main.js` 2 行、`build-batteries.js` 1 行、`index.html` 2 か所、`i18n-strings.js` 1 行、`.gitignore` 1 行）。確かめ方は「`npm test`。Windows では `src\main\taskbar-battery.exe --self-test --assets assets\taskbar`」。

- [ ] **Step 2: CI で自己テストを走らせる**: 両方のワークフローの `npm run dist` の後に、`node --test test/taskbar-exe.test.js` の段を足す（`predist` が exe を作る。作れなければ `CI=true` で `predist` が失敗するので、ここに来たときは exe がある。テストも、exe がなければ CI では失敗する）。

- [ ] **Step 3: コミットして push し、インストーラーを作る**

```bash
git add docs/fork.md .github/workflows/build.yml .github/workflows/fork-release.yml
git commit -m "docs(fork): タスクバーの残量表示を fork の一覧に足し、CI で自己テストを走らせる"
git push -u origin feat/taskbar-battery
gh workflow run build.yml -R rurute/battery-hub --ref feat/taskbar-battery
gh run watch -R rurute/battery-hub
```
Expected: run が成功し、自己テストの段が `pass` で、スキップしていない。

- [ ] **Step 4: 実機で確かめる**: `scripts/download-build.sh` で落としたインストーラーを、作者に入れてもらう。spec の「実機での確認」1〜13 を作者と分担して確かめ、結果（合格・未確認と、その理由）を PR の説明に書く。

- [ ] **Step 5: fork に PR を出す**（`gh pr create -R rurute/battery-hub --base main`、本文で `Closes #16`）。merge はしない。

## レビューの記録

Codex（`codex exec`、read-only、MCP サーバなし）による独立レビュー。run directory は `.ai/v01-run/`（git の追跡外）。要求源は、承認済みの spec（`e538671`）。

| 回 | run directory | 対象 HEAD | 比較元 | verdict | 採用 |
|---|---|---|---|---|---|
| 1 | `20261128-125812-plan` | `fde66e1` | なし（新規） | CHANGES_REQUESTED（D 8 件） | 採用（HEAD 一致、exit 0、MCP 起動ログ clean） |
| 2 | `20261128-130230-plan` | `c198325` | `fde66e1` | CHANGES_REQUESTED（D 2 件） | 採用（同上） |
| 3 | `20261128-130502-plan` | `fb94988` | `c198325` | APPROVE | 採用（同上） |

直した D:

- 1-F1: やりとりを区切り文字の行にしていたが、spec は 1 行 1 つの JSON → JSON に戻した（C# は `DataContractJsonSerializer`）。
- 1-F2: 出すデバイスのテストの期待値が、並べ替えた結果と合っていなかった → 直した。
- 1-F3: 「5 回であきらめる」と、あきらめる条件（`n > 5`）が食い違っていた → 回数と境目をそろえた。
- 1-F4 / 2-F4: Task 5 で、作り直さずに古い exe を走らせうる。ビルドの失敗も、ローカルでは見えなかった → 確認には `node scripts/build-taskbar-battery.js` を直接使い、直接走らせたときは失敗で止まるようにした。
- 1-F5 / 2-F9: 絵を使う自己テストに、Node のテストと記録のコマンドが `--assets` を渡していなかった → 渡すようにした。
- 1-F6: 終了を `quitApp` でしか受けておらず、`autoUpdater.quitAndInstall()` の経路が漏れていた → `will-quit` で受けるようにした（`main.js` のつなぎは 2 行）。
- 1-F7: 通知のしきい値を変えても少ない判定が変わらないことのテストが無かった → 足した。
- 1-F8: CI で exe が作れなくても、自己テストを飛ばして通りえた → CI では、ビルドの失敗と exe が無いことを失敗にした。

S / H: なし。

残る限界:

- レビュアは、Windows でのコンパイル、Electron での絵の作成、WSL からの相互運用、実機のタスクバーでの動きを確かめていない。
- APPROVE は、計画が spec と整合しているというレビュアの判定である。実装済み・テスト成功・HUMAN の承認のどれでもない。
