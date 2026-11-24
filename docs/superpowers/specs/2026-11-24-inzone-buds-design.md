# SONY INZONE Buds のバッテリーを読む（fork Issue #3）

## 目的

SONY INZONE Buds（USB ドングル `054c:0ec2`）のバッテリー残量を Battery Hub のカードに出す。今は対応しておらず、一覧に出ても読めない。読み方（プロトコル）は Issue #3 のコメントで実機を使って確かめ済みで、この spec はそれをアプリに組み込む。

fork（`rurute/battery-hub`）の中で、自分の環境で使えればよい。upstream には出さない（Issue #2 と同じ扱い）。

## ゴール / 非ゴール / アンチゴール

- ゴール: ドングルを挿したまま、Add device に INZONE Buds が出て、追加するとカードに残量が出る。
- ゴール: カードの残量は、報告のある左右のうち低いほう。詳細画面には、それに加えて左・右・ケースの残量を出す（HUMAN の決定: 案 A）。
- ゴール: ケースに入れてふたを閉じたとき（イヤホンが返答しない）は、ほかの機器の「電源オフ / 応答なし」と同じ扱いになり、エラーとして騒がない。
- ゴール: INZONE Hub を起動したままでも読める。
- 非ゴール: Bluetooth 接続での読み取り、Calibrate & Add での読み取り（Issue のチェックリストの残り。今回は扱わない）。
- 非ゴール: 充電中かどうかの判定（実機で読めなかった。`charging: null`）。
- 非ゴール: 左・右・ケースそれぞれのグラフ、通知、トレイ表示。グラフと通知はカードの 1 つの値（低いほう）だけを使う。
- アンチゴール: DualSense / DualShock 4（同じ Sony の VID `0x054C`）の読み取りが変わること。INZONE Hub の動作を邪魔すること（設定を書き換える、Hub の返答を横取りして Hub を困らせる、など）。

## 検討した案

表示について（HUMAN が選んだ）:

1. **カードは低いほう 1 つ、詳細画面に左・右・ケース**（採用、案 A）: カード・グラフ・通知・履歴は今の「1 カード = 1 値」のまま。詳細画面の「Voltage」と同じ仕組みで行を足すだけで済む。
2. 低いほう 1 つだけ（案 B）: いちばん小さいが、ケースの残量が見えない。
3. 左・右・ケースを別々のカードにする（案 C）: Issue #2 のような「1 台を複数に分ける」仕組みがまた要り、作業が大きい。

読み取りの組み込み方について（Claude の判断）:

- **専用ドライバ `src/main/hid/drivers/inzone.js`**（採用）: 問い合わせごとに TID（通し番号）とチェックサムを変える必要がある。`table.js` の steps は毎回同じバイト列を送る作りなので合わない。
- `table.js` の step で `request` を関数にできるよう `tabled.js` を変える案: 他の機器すべてが通る共通部分に手を入れることになり、upstream の変更とぶつかりやすくなる。外した。

## 設計

### 対象の判定（`matches`）

- `vendorId === 0x054c` かつ `productId === 0x0ec2`、かつ `0xFF04/0x0001` の collection（Issue の COL03）を持つ logical device。
- `src/main/hid/drivers/index.js` の `knownDrivers` に登録する。`playstation.js` は DualSense / DualShock 4 の PID だけを見るので重ならないが、並びは `playstation` の前にする。
- driver id は `inzone`。

### 問い合わせ

COL03 に 64 バイトを書く（足りない分は 0 で埋める）:

```
02 0C 01 00 FC 08 96 C3 41 04 01 <TID lo> <TID hi> <checksum>
```

- `[0]` レポート id `0x02`、`[1]` 後ろに続くバイト数 `0x0C`。
- `41`: 宛先 4（イヤホン）、送り元 1（PC）。`04`: event 0x04（バッテリー）。`01`: GET。
- checksum は `96 C3` から TID の上位バイトまで（`[6..12]`）の合計の下位 1 バイト。TID=1 なら `A0`（Issue の実測と一致）。
- TID は 16 ビットで、ドライバの中の通し番号にする。問い合わせのたびに 1 増やし、`0xFFFF` の次は 1 に戻す（0 は使わない）。最初の値は `0x4000`（INZONE Hub が使う小さな値 `0x02`、`0x03` などとすぐには重ならないように。重なっても下の照合で区別できる）。

### 返答

同じ COL03 から読む。node-hid の読み取りはレポート id を先頭に含む:

```
02 12 04 FF 0F 00 96 C3 14 04 10 <TID lo> <TID hi> | LS LL RS RR CS CC | checksum
```

- 受け付けるのは、`[0] === 0x02`、長さ 20 バイト以上、`[9] === 0x04`（event）、`[10] === 0x10`（GET への返答）、`[11..12]` が送った TID、かつ checksum（`[5..18]` の合計の下位 1 バイト）が `[19]` と一致するフレームだけ。それ以外（INZONE Hub の TID への返答、event 0x01〜0x09 や 0x85〜0x8C の通知など）は読み飛ばす。
- `[13..14]` 左、`[15..16]` 右、`[17..18]` ケース。それぞれ「状態 1 バイト、残量 1 バイト」。残量 `0x00..0x64` は %、`0xFF` はその部位から報告がない。状態のバイトは使わない（実機では意味が読み取れなかった）。
- 残量が `0x64` を超えて `0xFF` でない値は、報告がないものとして扱う（壊れた値をカードに出さない）。
- 実測の返答（テストに使う）: `02 12 04 ff 0f 00 96 c3 14 04 10 01 00 00 63 00 63 ff 60 a7` → 左 99% / 右 99% / ケース 96%。

### 読み取りの結果

`readBattery` が返す値:

```js
{ capacity, charging: null, parts: { left, right, case } }
```

- `left` / `right` / `case` は 0〜100 の数、報告がなければ `null`。
- `capacity` は `left` と `right` のうち `null` でないほうの小さいほう。
- 左右どちらも `null`（ケースだけ報告がある、または全部ない）の返答は、イヤホンが読めないので `INZONE Buds is off` を投げる（poller の「電源オフ」の流れ）。
- 返答がないとき: 1 回目の問い合わせが時間切れなら、新しい TID でもう 1 回だけ問い合わせる（ケースに入れた直後など、一時的に返らないことがあるため）。待ち時間は 1 回 1000ms。2 回とも返らなければ `INZONE Buds is not answering` を投げる（poller の「応答なし」の流れ。ふたを閉じたケースはこれになる）。
- 書き込みや読み取りそのものの失敗（ドングルが抜けたなど）は、そのままエラーとして投げる。
- `parts` は poller が `lastReading` にそのまま残す（今の `voltageMv` と同じ。`poller.js` の `lastReading: { ...reading, charging }`）。

### 詳細画面

`src/renderer/index.html` の `facts` の `dl` に、`Voltage` の行と同じ形で 3 行足す: `Left`、`Right`、`Case`。

- `dev.lastReading.parts` があるときだけ 3 行とも出す。ない機器では隠す（今の機器の見た目は変わらない）。
- 値は `99%` の形。`null` は `—`。
- 機器が応答なし・電源オフで `lastReading` が古いときも、最後に読めた値をそのまま出す（`detail-pct` と同じ扱い）。

### その他

- アイコン: 製品名に `buds` を含めば、既存の `icons.js` の判定でヘッドセットのアイコンになる。ドングルの製品名がそれに当たらなければ、ユーザーがアイコンを選び直せばよい（今回は手を入れない）。
- README の Supported devices の表に `Sony | INZONE Buds (USB dongle)` の行を足す。fork の中だけの README である。

## テスト

`node:test` で `test/inzone.test.js` を足す（`node-hid` は既存のテストと同じく差し替える）。

- 問い合わせのバイト列: TID=1 で `02 0c 01 00 fc 08 96 c3 41 04 01 01 00 a0` のあとが 0 で 64 バイト。
- 実測の返答から `{ capacity: 99, charging: null, parts: { left: 99, right: 99, case: 96 } }`。
- 片方が `0xFF`（例: 左 99 / 右 `0xFF` / ケース 96）なら `capacity: 99`、`right: null`。
- 左右とも `0xFF` なら `is off`。
- TID が違う返答、event や type が違うフレーム、checksum が合わないフレームは読み飛ばし、そのあとに来る正しい返答を使う。
- 1 回目が時間切れで 2 回目に返れば読める。2 回目は別の TID で問い合わせている。2 回とも返らなければ `is not answering`。
- `matches`: `054c:0ec2` で COL03 があれば true。DualSense（`054c:0ce6`）や COL03 のない `054c:0ec2` は false。`detectDriver` が INZONE Buds に `inzone`、DualSense に `playstation` を返す。
- 詳細画面の表示は、renderer のテストの仕組みがないので、実機で確かめる。

## 実機での確認（実装のあと、インストーラで）

1. Add device に INZONE Buds が出て、追加するとカードに残量が出る。INZONE Hub の表示と大きく違わない。
2. 詳細画面に Left / Right / Case が出る。ほかの機器の詳細画面には出ない。
3. 片耳だけケースに入れる、両耳ケースに入れてふたを閉じる、を試し、カードが「応答なし / 電源オフ」になり、エラー扱いにならない。ふたを開けて耳に着けると、また読めるようになる。
4. INZONE Hub を起動したままで 1〜3 が成り立ち、Hub の表示もおかしくならない。
5. DualSense をつないでいれば、今までどおり読める。

## 決めずに builder に任せること

- ドライバ内部の関数の分け方と名前（`request(tid)`、`parse(frame, tid)` など）。
- 詳細画面の 3 行の要素 id の名前。
