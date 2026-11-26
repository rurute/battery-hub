# fork の運用ルールと fork 独自の Release からの自動更新 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fork（`rurute/battery-hub`）でタグ `vX.Y.Z-fork.N` を push すると fork の Releases にリリースが出て、fork 版のアプリがそこから自動更新されるようにし、運用ルールを `docs/fork.md` にまとめる。

**Architecture:** リポジトリの `package.json` は本家のまま持ち、CI の中だけで `scripts/fork-version.js` が `version` と `build.publish[0].owner` を書き換える。リリースは新しい `fork-release.yml`、手動ビルドは既存の `build.yml` がこのスクリプトを使う。診断の版数比較 `isNewer` だけを `// fork:` 付きで直す。

**Tech Stack:** Node 22（`node:test`）、GitHub Actions（windows-latest）、electron-builder / electron-updater

**Spec:** `docs/superpowers/specs/2026-11-26-fork-release-design.md`

## Global Constraints

- リリースのバージョンは `X.Y.Z-fork.N`（`N` は 1 以上の整数）。`X.Y.Z` は `package.json` の `version` と一致しなければ失敗。
- 手動ビルドのバージョンは `X.Y.Z-fork.0.<run_number>`。
- `build.publish[0]` は `provider: github`、`owner: rurute`、`repo: battery-hub` にする。
- リポジトリの `package.json` と `.github/workflows/release.yml` は変えない（`git diff upstream/main -- package.json .github/workflows/release.yml` が空）。
- `src/` の変更は `src/main/diagnostics.js` の `isNewer` だけ。`// fork:` の目印を付ける。`REPO` は `battery-hub/battery-hub` のまま。
- fork のリリースは draft のままにせず公開する。GitHub の pre-release の印は付けない。
- `gh` の PR・Issue・ワークフロー操作は必ず `-R rurute/battery-hub`。
- ワークフローの停止、タグの push、main への merge、リリースの削除は、実行前にユーザーの確認を取る。
- 文書は日本語。コードのコメントは周りに合わせて英語。

## Review Focus

1. 本家から写したタグ（`v2.0.7` など）が fork に push されても、fork のリリースが動かない。→ Task 3 の静的チェックで、トリガーが `v*-fork.*` だけであることを確かめる。
2. 書き換えが効かないまま publish すると、electron-builder が本家（`battery-hub/battery-hub`）に出そうとする。→ Task 2 の CLI が書き換えのあと読み直して owner を確かめ、違えば 0 以外で終わる。
3. `package.json` の `X.Y.Z` と合わないタグ（取り込み前のコードに付けたタグ）。→ Task 2 のテスト `rejects a tag for another base version`。
4. 両方に pre-release がある比較、`v` 付きのタグ名。→ Task 1 のテストに入れる。
5. CI で書き換えた `package.json` がコミット・push される。→ Task 3 の静的チェックで、ワークフローに `git commit` / `git push` が無いことを確かめる。

---

### Task 1: 診断の版数比較で `-fork.N` を無視する

**Files:**
- Modify: `src/main/diagnostics.js:46-53`（`isNewer`）
- Test: `test/diagnostics.test.js`（`isNewer` の既存テストの近く、85 行目付近）

**Interfaces:**
- Produces: `isNewer(latest: string, current: string) -> boolean`（シグネチャは変えない）

- [ ] **Step 1: 失敗するテストを書く**

```js
test('a fork version compares by its base version', () => {
  assert.equal(isNewer('2.0.7', '2.0.7-fork.1'), false);
  assert.equal(isNewer('v2.0.7', '2.0.7-fork.3'), false);
  assert.equal(isNewer('2.0.8', '2.0.7-fork.1'), true);
  assert.equal(isNewer('2.0.6', '2.0.7-fork.1'), false);
  assert.equal(isNewer('2.0.7-fork.2', '2.0.7-fork.1'), false);
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/diagnostics.test.js`
Expected: FAIL（`isNewer('2.0.7', '2.0.7-fork.1')` が true）

- [ ] **Step 3: `isNewer` の中の `parts` で、`v` を取ったあと最初の `-` 以降を取り除いてから `.` で区切る。** 変更行に `// fork: compare 2.0.7-fork.1 as 2.0.7 (docs/fork.md)` を付ける。

- [ ] **Step 4: 通ることを確かめる**

Run: `npm test`
Expected: すべて PASS（既存の `isNewer` のテストも）

- [ ] **Step 5: コミット**

```bash
git add src/main/diagnostics.js test/diagnostics.test.js
git commit -m "fix(diagnostics): fork のバージョン X.Y.Z-fork.N を X.Y.Z として比べる（#7）"
```

### Task 2: バージョンと更新先を書き換えるスクリプト

**Files:**
- Create: `scripts/fork-version.js`
- Test: `test/fork-version.test.js`

**Interfaces:**
- Produces（`module.exports`）:
  - `versionFromTag(tag: string, baseVersion: string) -> string`: `'v2.0.7-fork.1'` と `'2.0.7'` から `'2.0.7-fork.1'`。形が `v<base>-fork.<N>`（N は 1 以上の整数、先頭 0 なし）でなければ、または `<base>` が `baseVersion` と違えば `Error` を投げる。メッセージに両方の値を入れる。
  - `devVersion(baseVersion: string, runNumber: string | number) -> string`: `'2.0.7-fork.0.12'`。`runNumber` が正の整数でなければ `Error`。
  - `applyFork(pkg: object, version: string) -> object`: `pkg` を変えずに、`version` と `build.publish[0]`（`provider: 'github'`, `owner: 'rurute'`, `repo: 'battery-hub'`）を差し替えた新しいオブジェクトを返す。ほかのキーと `build` のほかの項目はそのまま。
- CLI（Task 3 が使う）: `node scripts/fork-version.js --tag <tag>` または `node scripts/fork-version.js --dev <run_number>`。リポジトリ直下の `package.json` を読み、書き換えて保存（2 スペースのインデント、末尾改行）し、読み直して `version` と `build.publish[0].owner === 'rurute'` を確かめる。合わなければ、または引数が違えば、メッセージを出して `process.exit(1)`。成功したらバージョンを 1 行出す。`require.main === module` のときだけ CLI として動く。

- [ ] **Step 1: 失敗するテストを書く**

```js
const { versionFromTag, devVersion, applyFork } = require('../scripts/fork-version');

test('turns a fork tag into its version', () => {
  assert.equal(versionFromTag('v2.0.7-fork.1', '2.0.7'), '2.0.7-fork.1');
  assert.equal(versionFromTag('v2.0.7-fork.12', '2.0.7'), '2.0.7-fork.12');
});
test('rejects a tag for another base version', () => {
  assert.throws(() => versionFromTag('v2.0.6-fork.1', '2.0.7'), /2\.0\.6.*2\.0\.7|2\.0\.7.*2\.0\.6/);
});
test('rejects tags that are not fork releases', () => {
  for (const tag of ['v2.0.7', 'v2.0.7-fork.0', 'v2.0.7-fork.01', 'v2.0.7-fork.x', '2.0.7-fork.1', 'v2.0.7-beta.1']) {
    assert.throws(() => versionFromTag(tag, '2.0.7'), Error, tag);
  }
});
test('a manual build sorts below the first fork release', () => {
  assert.equal(devVersion('2.0.7', '12'), '2.0.7-fork.0.12');
  assert.throws(() => devVersion('2.0.7', ''));
});
test('points publishing at the fork and keeps the rest', () => {
  const pkg = { name: 'battery-hub', version: '2.0.7', build: { appId: 'x', publish: [{ provider: 'github', owner: 'battery-hub', repo: 'battery-hub' }] } };
  const out = applyFork(pkg, '2.0.7-fork.1');
  assert.equal(out.version, '2.0.7-fork.1');
  assert.deepEqual(out.build.publish[0], { provider: 'github', owner: 'rurute', repo: 'battery-hub' });
  assert.equal(out.build.appId, 'x');
  assert.equal(pkg.version, '2.0.7');
  assert.equal(pkg.build.publish[0].owner, 'battery-hub');
});
```

（`test` と `assert` は他のテストと同じく `node:test` / `node:assert` から読む。）

- [ ] **Step 2: 失敗を確かめる**

Run: `node --test test/fork-version.test.js`
Expected: FAIL（`Cannot find module '../scripts/fork-version'`）

- [ ] **Step 3: `scripts/fork-version.js` に上の 3 つの関数と CLI を書く。** 先頭に、何のためのスクリプトか（CI の中だけで使う、結果をコミットしない、`docs/fork.md` を見よ）を 2〜3 行のコメントで書く。

- [ ] **Step 4: 通ることを確かめる**

Run: `npm test`
Expected: すべて PASS（`test/syntax.test.js` も）

- [ ] **Step 5: CLI を一時コピーで確かめる**

CLI が読む `package.json` は `path.join(__dirname, '..', 'package.json')`。作業ツリーで実行して、すぐ戻す:
Run: `node scripts/fork-version.js --tag v2.0.7-fork.1; git diff package.json; git checkout package.json; node scripts/fork-version.js --tag v2.0.6-fork.1; echo "exit=$?"; git status --short package.json`
Expected: 1 回目は `2.0.7-fork.1` が出て、diff は `version` と `owner` の 2 行だけ（インデントや並びは変わらない）。2 回目は `exit=1`。最後の `git status` は何も出さない。

- [ ] **Step 6: コミット**

```bash
git add scripts/fork-version.js test/fork-version.test.js
git commit -m "feat(ci): fork のバージョンと更新先を CI の中だけで書き換えるスクリプト（#7）"
```

### Task 3: fork のリリース用ワークフローと手動ビルドの書き換え

**Files:**
- Create: `.github/workflows/fork-release.yml`
- Modify: `.github/workflows/build.yml`（`npm ci` のあと、`dist` の前に 1 ステップ足し、先頭のコメントにバージョンの説明を 1 行足す）

**Interfaces:**
- Consumes: Task 2 の CLI `node scripts/fork-version.js --tag <tag>` / `--dev <run_number>`

- [ ] **Step 1: `fork-release.yml` を書く。** `release.yml` を手本にし、違いは次のとおり。
  - `name: Fork release`、`on.push.tags: ['v*-fork.*']` のみ。
  - `permissions: contents: write`。
  - setup-node に `cache: npm`（`build.yml` と同じ）。
  - `npm ci` のあとに `node scripts/fork-version.js --tag $env:GITHUB_REF_NAME`（pwsh）。
  - draft 作成、`npm run dist -- --publish always`、`npm run installer` とアップロード、`SHA256SUMS.txt` は `release.yml` と同じ。`gh` には `-R rurute/battery-hub` は不要（`GITHUB_REPOSITORY` が fork）だが、付けても可。
  - 最後に `gh release edit $env:GITHUB_REF_NAME --draft=false --prerelease=false` で公開する（electron-builder がバージョンの pre-release の部分を見て印を付けても、ここで外す）。
  - 先頭のコメントに: fork 専用であること、使い方（`git tag vX.Y.Z-fork.N && git push origin vX.Y.Z-fork.N`）、`package.json` は CI の中だけで書き換えること、詳しくは `docs/fork.md`。

- [ ] **Step 2: `build.yml` に `node scripts/fork-version.js --dev ${{ github.run_number }}` のステップを `npm ci` の直後に足す。**

- [ ] **Step 3: 静的に確かめる**

Run:
```bash
grep -n "tags:" -A2 .github/workflows/fork-release.yml
grep -nE "git (commit|push)" .github/workflows/fork-release.yml .github/workflows/build.yml; echo "exit=$?"
grep -n "fork-version" .github/workflows/fork-release.yml .github/workflows/build.yml
grep -n "draft=false" .github/workflows/fork-release.yml
git diff upstream/main -- package.json .github/workflows/release.yml | wc -l
```
Expected: トリガーは `v*-fork.*` の 1 行だけ。`git commit/push` は見つからず `exit=1`。`fork-version` は各ファイルに 1 回ずつ。`draft=false` が 1 回。最後は `0`。YAML として読めることも確かめる（`node -e "require('js-yaml')"` が無ければ `python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/fork-release.yml .github/workflows/build.yml`）。

- [ ] **Step 4: コミット**

```bash
git add .github/workflows/fork-release.yml .github/workflows/build.yml
git commit -m "ci: タグ vX.Y.Z-fork.N で fork の Releases に出すワークフロー（#7）"
```

### Task 4: `docs/fork.md`

**Files:**
- Create: `docs/fork.md`

- [ ] **Step 1: spec の「`docs/fork.md`（新規）に書くこと」の項目をすべて書く。** fork だけの変更の一覧は `git diff --stat upstream/main...main` とこのブランチの変更から作り、3 つに分ける。
  - 本家に入ったもの: INZONE Buds（本家 PR #199、merge 済み）。
  - 本家に PR 中: Lightspeed の複数台（本家 PR #230）、ELECOM BlueLED Mouse（本家 PR #239）。本家に入ったら、取り込みのときに本家の版を採ること。
  - fork だけ: `build.yml`、`scripts/download-build.sh`、`fork-release.yml`、`scripts/fork-version.js`、`diagnostics.js` の `isNewer`（`// fork:`）、`docs/superpowers/` の fork の spec / plan、`docs/fork.md`。それぞれ、目的と確かめ方を 1 行ずつ。
- 止めているワークフロー: `triage.yml`（すでに止まっている）と `release.yml`（このあと止める）、その理由。
- 最初の fork のリリースだけは手でインストールすることと、インストール後に `%LOCALAPPDATA%\Programs\<インストール先>\resources\app-update.yml` の `owner` が `rurute` であることの確かめ方。インストール先のフォルダー名は、Task 5 で実際に確かめてから書き足してよい。

- [ ] **Step 2: リンクと名前を確かめる**

Run: `grep -nE "fork-release.yml|fork-version.js|isNewer|v\*-fork|#199|#230|#239" docs/fork.md`
Expected: それぞれ 1 回以上出る。

- [ ] **Step 3: コミット**

```bash
git add docs/fork.md
git commit -m "docs: fork の運用ルール（#7）"
```

### Task 5: 出して確かめる（ユーザーの確認を取りながら）

各操作の前にユーザーの確認を取る。

- [ ] **Step 1:** `npm test` が通ることを確かめ、fork に PR を作る（`gh pr create -R rurute/battery-hub --base main`）。本文の最後に `Closes #7`。CI が通るのを待つ。
- [ ] **Step 2:** 確認を取ってから `gh workflow disable release.yml -R rurute/battery-hub`。`gh workflow list -R rurute/battery-hub --all` で `Release` が `disabled_manually` になったことを確かめる。
- [ ] **Step 3:** 確認を取ってから PR を merge し、`git checkout main && git pull`。
- [ ] **Step 4:** 確認を取ってから `git tag v2.0.7-fork.1 && git push origin v2.0.7-fork.1`。`gh run watch -R rurute/battery-hub` で Fork release が通り、`Release` ワークフローが動いていないことを確かめる。
- [ ] **Step 5:** `gh release view v2.0.7-fork.1 -R rurute/battery-hub` で、draft でも pre-release でもなく、`Battery-Hub-Installer-2.0.7-fork.1.exe`、`latest.yml`（または `fork.yml`）、blockmap、`SHA256SUMS.txt` があることを確かめる。`gh release download` で yml を取り、`version: 2.0.7-fork.1` であることを確かめる。
- [ ] **Step 6:** ユーザーに `Battery-Hub-Installer-2.0.7-fork.1.exe` を手でインストールしてもらい、`app-update.yml` の `owner: rurute` と、診断の Version チェックが通ることを確かめてもらう。
- [ ] **Step 7:** 確認を取ってから、同じ `main` に `v2.0.7-fork.2` を付けて push し、リリースが出たら、アプリを起動したまま 1 分以上待つか設定画面の「更新を確認」を押してもらう。ログ（`updater:` の行）で `2.0.7-fork.2` が見つかりダウンロードされたこと、再起動後のバージョンが `2.0.7-fork.2` であることを確かめる。更新されなければ、ログの `Cannot find ... yml` などを見て、spec の「自動更新の確認すべき点」に従い、`fork-version.js` で `build.publish[0].channel` などを揃えて直す（Task 2 に戻ってテストを足す）。
- [ ] **Step 8:** `docs/fork.md` に、Step 6 で分かったインストール先のフォルダー名を書き足す必要があれば、別の小さな PR で直す。
