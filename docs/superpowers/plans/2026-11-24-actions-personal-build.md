# 自分用ビルドを GitHub Actions で作る 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fork（`rurute/battery-hub`）で手動実行すると Windows 用インストーラを artifact として残すワークフローを足す。

**Architecture:** `release.yml` と同じ `windows-latest` 上で `npm ci` → `dist` → `installer` を実行する新しいワークフロー `build.yml` を 1 本足す。公開の手順（Release 作成・`GH_TOKEN`）は持たない。fork の `main` に入れてから実際に実行して確かめる。

**Tech Stack:** GitHub Actions、Node 22、electron-builder（NSIS）、Windows 付属 csc

**Spec:** `docs/superpowers/specs/2026-11-24-actions-personal-build-design.md`

## Global Constraints

- トリガーは `workflow_dispatch` のみ。
- `permissions: contents: read`。`GH_TOKEN` / `secrets.GITHUB_TOKEN` を env に渡さない。
- `npm run dist -- --publish never`。
- artifact は `dist/Battery-Hub-Installer-*.exe` と `dist/Battery-Hub-Update-*.exe`、`retention-days: 14`。
- artifact 名にブランチ名と短い SHA（7 文字）を含める。
- action のバージョンは既存に合わせる（`actions/checkout@v4`、`actions/setup-node@v4`）。upload は `actions/upload-artifact@v4`。
- PR・Issue 操作は必ず `-R rurute/battery-hub`（fork の `gh pr create` は既定で upstream を向くため）。
- fork の設定変更（Actions 有効化、triage 停止）と main への merge はユーザーに確認してから行う。

## Review Focus

1. `--publish never` を付け忘れると、CI 上の electron-builder が publish を試みる。→ Task 1 の静的チェックで grep する。
2. `installer` の出力が見つからないと upload が黙って空になる。→ `if-no-files-found: error` を指定し、Task 2 で artifact の中身を確かめる。
3. `system-batteries.exe` が入らないとリリースと中身が変わる。→ Task 2 で `predist` のログに `Wrote src/main/system-batteries.exe` が出ていることを確かめる。
4. ブランチ名に `/` が入ると artifact 名として不正になる（`feat/x`）。→ 名前に使う前に `/` を `-` に置き換える。Task 1 の静的チェックで確かめ、Task 2 では `feat/` ブランチを `--ref` にして実行する。
5. fork で triage ボットが Issue を書き換える。→ Task 2 で Actions を有効化する前に triage を止める。

---

### Task 1: `build.yml` を書く

**Files:**
- Create: `.github/workflows/build.yml`

**Interfaces:**
- Produces: ワークフローファイル名 `build.yml`。artifact 名 `battery-hub-<ブランチ名の / を - に置換>-<SHA 7 文字>`。

- [ ] **Step 1: actionlint を scratchpad に用意する**

Run: `gh release download -R rhysd/actionlint -p 'actionlint_*_linux_amd64.tar.gz' -D <scratchpad>/actionlint && tar -xzf <scratchpad>/actionlint/*.tar.gz -C <scratchpad>/actionlint actionlint`
Expected: `<scratchpad>/actionlint/actionlint -version` がバージョンを表示する。

- [ ] **Step 2: `build.yml` を書く**

先頭コメントに、用途（fork での自分用ビルド、Release は作らない）と使い方の 3 コマンド（spec の「使い方」をそのまま）を書く。job は `release.yml` の Checkout / Setup Node / Install と同じ並びに `cache: npm` を足し、`npm run dist -- --publish never`、`npm run installer` と続ける。artifact 名を作るステップは `shell: bash` で `${GITHUB_REF_NAME//\//-}` と `${GITHUB_SHA::7}` を `$GITHUB_ENV` に書き出す。upload は `if-no-files-found: error`。

- [ ] **Step 3: 静的チェック**

Run: `<scratchpad>/actionlint/actionlint .github/workflows/build.yml && grep -c -- '--publish never' .github/workflows/build.yml && ! grep -n 'GH_TOKEN\|GITHUB_TOKEN' .github/workflows/build.yml`
Expected: actionlint の出力なし、grep の件数が 1、トークンの行なし。

- [ ] **Step 4: 既存テストが通ることを確かめる**

Run: `npm ci --ignore-scripts && npm test`
Expected: すべて pass。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build.yml docs/superpowers/plans/2026-11-24-actions-personal-build.md
git commit -m "ci: manual Windows build for personal test installers (fork #1)"
```

### Task 2: fork の main に入れて実行し、確かめる

**Files:** なし（GitHub 上の操作）

**Interfaces:**
- Consumes: Task 1 の `build.yml` と artifact 名。

- [ ] **Step 1: PR を作る**

Run: `git push -u origin feat/actions-personal-build && gh pr create -R rurute/battery-hub --base main --head feat/actions-personal-build --title "ci: manual Windows build for personal test installers" --body "Closes #1 ..."`
Expected: `https://github.com/rurute/battery-hub/pull/<n>` が返る（battery-hub/battery-hub ではないこと）。

- [ ] **Step 2: ユーザーに確認してから、triage を止め、Actions を有効化し、PR を squash merge する**

Run: `gh workflow disable triage.yml -R rurute/battery-hub`（Actions が無効でワークフローが見えない場合は、先に fork の Actions タブで有効化してもらってから実行する）、`gh pr merge <n> -R rurute/battery-hub --squash`。その後 `git checkout main && git pull`
Expected: `gh workflow list -R rurute/battery-hub` で triage が `disabled_manually`、Build が `active`。

- [ ] **Step 3: `feat/` ブランチ名で実行する**

Run: `git checkout -b feat/build-smoke && git push -u origin feat/build-smoke && gh workflow run build.yml -R rurute/battery-hub --ref feat/build-smoke && gh run watch -R rurute/battery-hub --exit-status`
Expected: run が成功する。ログに `Wrote src/main/system-batteries.exe` と `Wrote ...Battery-Hub-Installer-2.0.4.exe` が出る。

- [ ] **Step 4: artifact を取得して確かめる**

Run: `gh run download -R rurute/battery-hub -D <scratchpad>/dist-ci && ls -la <scratchpad>/dist-ci/*`
Expected: artifact のディレクトリ名が `battery-hub-feat-build-smoke-<sha7>`。中に `Battery-Hub-Installer-2.0.4.exe` と `Battery-Hub-Update-2.0.4.exe` がある。

- [ ] **Step 5: 後片付け**

Run: `git push origin --delete feat/build-smoke && git checkout main && git branch -D feat/build-smoke`

- [ ] **Step 6: ユーザーに Windows でのインストールと起動の確認を頼む**

Issue #1 の残りの確認項目（インストールでき、起動し、node-hid が入っているか）は、ユーザーが Windows 上で行う。結果を Issue #1 にコメントして閉じる（PR の `Closes #1` で閉じていれば、コメントだけ足す）。
