# fork の運用ルールと、fork 独自の Release からの自動更新（fork Issue #7）

## 目的

本家（`battery-hub/battery-hub`）に入らない変更（次に予定しているタスクバーの残量表示など）を、fork（`rurute/battery-hub`）でずっと持ち続けられるようにする。そのために次の 2 つを決めて、仕組みにする。

1. fork の運用ルール（ブランチ、本家の取り込み、fork だけの変更の置き方）。`docs/fork.md` に書く。
2. fork のビルドが本家の自動更新で上書きされないようにする（Issue #7）。更新先を fork の Releases に向け、fork でもリリースを出す（HUMAN の決定）。

## ゴール / 非ゴール / アンチゴール

- ゴール: fork のリリースをインストールした状態で、本家に新しいリリースが出ても本家版に置き換わらない。
- ゴール: fork のリリース `vX.Y.Z-fork.N` を出すと、その前の fork のリリースを入れているアプリが自動で更新される。
- ゴール: 本家のファイルへの変更を最小にする。本家の取り込みのたびに衝突する所を増やさない（`src/` の変更は下の診断の版数比較の 1 か所だけ）。
- ゴール: 運用ルールが `docs/fork.md` に書かれていて、本家の取り込み・fork のリリースをその手順どおりにできる。
- 非ゴール: 本家への PR。本家の `release.yml` の変更。
- 非ゴール: 本家のリリースが出たとき、自動で取り込んで fork のリリースを出すこと（手で行う）。
- アンチゴール: fork のタグやワークフローが本家の Releases に何かを出すこと。本家ビルドの自動更新の挙動が変わること。

## 検討した案

### 運用（HUMAN の決定: 案 1）

1. **fork の `main` を「本家 + fork の変更」の配布版として持ち、本家は merge で取り込む**（採用）。いまのやり方の延長で、force push も `reset --hard` も要らない。
2. 本家のリリースごとに fork の変更を rebase で載せ直す。差分はきれいだが毎回 force push になり、PR の履歴とグローバルの運用ルールに合わない。
3. 本家に小さな「つなぎ口」を PR して、fork の変更を外付けにする。本家が受けるか次第なので、1 と並べて機会があれば試す扱い。

### 自動更新（HUMAN の決定: fork の Releases から更新する）

1. fork のビルドでは自動更新を切る。軽いが、更新のたびに手で入れ直す。
2. **更新先を fork の Releases に向け、fork でもリリースを出す**（採用）。本家の修正は、取り込んで fork のリリースを出したときに届く。
3. 自動インストールだけ止め、通知は残す。本家版を入れると fork の変更が消える点は変わらない。

### fork 版の見分け方（作り手の判断）

- **案 A（採用）: ビルドのときだけ、CI で `package.json` の `version` と `build.publish` を書き換える。** `package.json` は本家のまま持つので、本家の取り込みで衝突しない。書き換えるのは fork だけのワークフローの中。
- 案 B: fork の `package.json` を直接書き換える。本家はリリースのたびに `version` を変えるので、取り込みのたびに衝突する。
- 案 C: `main.js` で `autoUpdater.setFeedURL` を呼ぶ。本家のファイルに手を入れることになり、`app-update.yml` の中身と食い違う。

## 設計

### バージョンの付け方

- fork のリリースは `X.Y.Z-fork.N`。`X.Y.Z` は取り込んだ本家のバージョン（`package.json` の `version`）、`N` はその上での fork のリリースの番号で、1 から数える。本家を取り込んで `X.Y.Z` が変わったら、`N` は 1 に戻る。
- semver では `2.0.7-fork.1 < 2.0.7-fork.2 < 2.0.8-fork.1` になり、fork の中では正しく並ぶ。
- 手動ビルド（`build.yml`）のバージョンは `X.Y.Z-fork.0.<run_number>`。`fork.0.*` は `fork.1` より小さいので、手動ビルドを入れていても次の fork のリリースで自動更新される（作り手の判断）。

### fork のリリース用ワークフロー（新規 `.github/workflows/fork-release.yml`）

- トリガー: タグ `v*-fork.*` の push。
- タグのバージョンの `X.Y.Z` が `package.json` の `version` と一致するか確かめ、違えば失敗にする（取り込み前のコードに付けたタグを防ぐ）。
- ビルドの前に、CI の中だけで `package.json` を書き換える（コミットしない）。
  - `version` をタグのバージョンにする。
  - `build.publish[0].owner` を `rurute` にする（`repo` は同じ `battery-hub`）。
  - 書き換えには `npm pkg set` を使う（作り手の判断。ほかの方法でもよい）。
- それ以降は本家の `release.yml` と同じ手順にする。draft の作成、`npm run dist -- --publish always`、`npm run installer`、ブランドのインストーラーと `SHA256SUMS.txt` のアップロード。
- リリースは draft のままにせず、公開まで行う（作り手の判断。自分用なので確認の手順を挟まない）。GitHub 上の「pre-release」の印は付けない。
- 書き換えの処理は、`build.yml` と共有するスクリプトにしてよい（例: `scripts/fork-version.js`）。作り手に任せる。

### 本家の `release.yml` の扱い

- 本家の `release.yml` のトリガー `v*` は fork のタグにも当たる。fork では `gh workflow disable release.yml -R rurute/battery-hub` で止める。この設定はリポジトリの設定なので、本家を取り込んでも戻らない。
- ファイルは消さない。消すと、本家がそのファイルを変えるたびに取り込みで衝突する。
- ワークフローを止めるのは外向きの操作なので、実行の前にユーザーの確認を取る。

### 手動ビルド（`build.yml`）

- fork のリリースと同じように `version` と `build.publish` を書き換えてからビルドする（バージョンは上の `fork.0.<run_number>`）。手動ビルドを入れたアプリも fork の Releases を見るようにするため。

### 自動更新の確認すべき点（作り手が実機またはログで確かめる）

- electron-updater は、いまのバージョンに pre-release の部分（`fork`）があると `allowPrerelease` を自動で true にし、更新の情報を `fork.yml` から読みにいく（`node_modules/electron-updater/out/providers/GitHubProvider.js` のチャンネルの扱い）。electron-builder が出すファイル名（`latest.yml` か `fork.yml` か）と食い違わないかを確かめる。食い違う場合は、ワークフローの中の書き換えで揃える（例: `build.detectUpdateChannel` や `build.publish[0].channel` を設定する）。`main.js` には手を入れない方針を優先する。どうしても `main.js` の変更が要るときは、`// fork:` の目印を付けた最小の変更にする。
- 補足（builder check で確認済み）: GitHub への publish はバージョンからチャンネルを決めないので `latest.yml` を出す。electron-updater は `fork.yml` を探し、無ければ pre-release のバージョンなので `latest.yml` に戻って読む。どちらでも動くが、`publish[0].channel` などで揃えるかは作り手に任せる。
- 完了の確認として、`fork.1` を入れたアプリが `fork.2` に自動で更新されることを確かめる。テスト専用のリリースは作らず、最初の 2 回の本物のリリースを使う（`fork.1` を手でインストールし、`fork.2` で自動更新を見る）。テスト用のリリースを消して番号を使い直すと、すでに上の番号を入れた PC が更新されなくなるため（作り手の判断）。

### 移行

- いまインストールされている Battery Hub（本家版、またはこれまでの手動ビルド）は本家の Releases を見ている。最初の fork のリリースだけは手でインストールする。`docs/fork.md` に書く。
- それより前に本家の新しいリリース（例 2.0.8）が出ると、本家版に置き換わる。その場合も、fork のリリースを手で入れ直せば戻る。

### `docs/fork.md`（新規）に書くこと

- この fork が何か: 本家に入らない変更を持つ、自分用の配布版。
- ブランチの種類と流れ:
  - 本家に出す変更: `upstream/main` から切り、本家に PR し、fork にも入れる。本家に入ったあと取り込みで衝突したら、本家の版を採る。
  - fork だけの変更: fork の `main` から切り、fork に PR する。新しいファイルに置き、本家のファイルへの変更は数行のつなぎにとどめ、`// fork:`（言語に合わせたコメント）の目印を付ける。
- fork だけの変更の一覧: ファイルと目的、手動での確かめ方。最初の版は、いまの fork の差分（`git diff upstream/main...main`）から作る。本家に出して入ったもの・PR 中のものも区別して書く。
- 本家の取り込みの手順: `chore/merge-upstream-X.Y.Z` ブランチで `upstream/main` を merge → 衝突を解く → CI → 手動ビルドで fork だけの変更を確かめる → fork に PR → merge のあと fork のリリース `vX.Y.Z-fork.1` を出す。
- fork のリリースの手順: `main` でタグ `vX.Y.Z-fork.N` を付けて push する。出たリリースの確かめ方。
- fork で止めているワークフロー（`release.yml`、`triage.yml`）と、その理由。本家の取り込みでワークフローが増えたときに見直すこと。
- 最初の 1 回は手でインストールすること（上の移行）。

### 診断の版数比較（`src/main/diagnostics.js`、HUMAN の決定）

- いまの `isNewer` は版数を `.` で区切って `Number()` にするので、`2.0.7-fork.1` の `7-fork` が NaN（0 扱い）になり、本家の `2.0.7` が新しいと判定される。その結果、診断の Version チェックが常に失敗し、`reportGate` が `outdated` を返してデバイスのレポートが送れない。
- 比べる前に、版数の pre-release の部分（`-` 以降）を取り除く。`2.0.7-fork.1` は本家の `2.0.7` と同じとみなす。本家が `2.0.8` を出すと「古い」と出るが、それは「本家をまだ取り込んでいない」という正しい合図として扱う。
- 変更は `isNewer` の中の数行だけにし、`// fork:` の目印を付ける。比べる相手（`REPO`）は本家のまま。
- テストを足す（`2.0.7-fork.1` 対 `2.0.7` は新しくない、`2.0.8` 対 `2.0.7-fork.1` は新しい）。
- `docs/fork.md` の fork だけの変更の一覧に載せる。

## 変えないもの

- `package.json`（リポジトリの中のもの）、本家の `release.yml`。`src/` は上の `isNewer` 以外は変えない。
- `src/main/diagnostics.js` の `REPO`（`battery-hub/battery-hub`）。機器のレポートは本家に送るのが正しいので、そのままにする。

## 完了の条件

- fork のリリースを入れたアプリが、本家に fork のバージョン以上のリリースがあっても、本家版をダウンロードしない（ログで更新先が `rurute/battery-hub` であることを確かめる）。
- `fork.1` から `fork.2` へ自動で更新される。
- 本家の `release.yml` と `package.json` は変わっていない（`git diff upstream/main -- package.json .github/workflows/release.yml` が空）。
- 診断の Version チェックが、fork のリリース `X.Y.Z-fork.N` で本家の最新が `X.Y.Z` のとき通る。
- `docs/fork.md` がある。

## 作り手に任せること

- ワークフローのステップ名、スクリプトの名前と置き場所、`npm pkg set` 以外の書き換えの方法。
- チャンネルのファイル名を揃える具体的な方法（上の確認の結果しだい）。
- `docs/fork.md` の文の書き方と並べ方。
