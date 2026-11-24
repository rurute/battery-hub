# 自分用ビルドを GitHub Actions で作る（fork Issue #1）

## 目的

Windows に Node.js を入れず、WSL からの操作だけで、自分の変更を入れたインストーラを作り、手元の Windows で試せるようにする。リリースと同じ中身にする（`system-batteries.exe` も含める）。

## ゴール / 非ゴール

- ゴール: fork（`rurute/battery-hub`）で手動実行するワークフローを動かし、`Battery-Hub-Installer-<version>.exe` を artifact として受け取る。ブランチを指定してビルドできる。
- 非ゴール: WSL 上で直接ビルドすること（Wine 案、installer の作り直し案）。upstream への提案。
- アンチゴール: GitHub Release やタグを作ってしまうこと。upstream のリリースや自動更新に影響を出すこと。

## 検討した案

1. **WSL + Wine で `npm run dist`**: Wine を入れる必要がある。`installer` と `system-batteries.exe` は別途 WSL interop で Windows の csc を呼ぶ必要があり、リリースとの差が出やすい。
2. **installer を Linux 向けに作り直す**: WPF が mono で動かず作業が大きい。interop で csc を呼べるので作り直す理由も薄い。
3. **GitHub Actions（windows-latest）で手動ビルド**（採用）: `release.yml` と同じ環境なので中身がリリースと揃い、WSL 側に何も入れずに済む。代わりに 1 回数分待ち、push 済みの変更しかビルドできない。

## 設計

新しいファイル `.github/workflows/build.yml` を fork の `main` に追加する。

- トリガー: `workflow_dispatch` のみ。実行時に `--ref <branch>` でビルドするブランチを選ぶ。
- `runs-on: windows-latest`、`permissions: contents: read`。
- 手順: checkout → setup-node 22（npm キャッシュあり）→ `npm ci` → `npm run dist -- --publish never` → `npm run installer` → `actions/upload-artifact` で `dist/Battery-Hub-Installer-*.exe` と `dist/Battery-Hub-Update-*.exe` を保存する。
- `GH_TOKEN` は渡さない。`--publish never` と合わせて Release を作らないようにする。
- artifact 名にはブランチ名と短い SHA を入れて、どのビルドかわかるようにする。

使い方（ワークフローファイルの先頭コメントに書く）:

```sh
gh workflow run build.yml -R rurute/battery-hub --ref <branch>
gh run watch -R rurute/battery-hub
gh run download -R rurute/battery-hub -D dist/ci
```

## 運用で必要なこと

- fork の Actions がまだ一度も動いていない。最初に Actions タブで有効化する必要があるかもしれない。
- `triage.yml`（Issue ボット）は fork でも Issue のイベントで動き、fork の Issue にラベルを付けたりコメントしたりしうる。fork では `gh workflow disable triage.yml -R rurute/battery-hub` で止める（ユーザーの確認を取ってから実行する）。
- fork の `main` が upstream より 1 コミット進むので、upstream の取り込みは fast-forward ではなく merge か rebase になる。

## 制約・メモ

- 作ったビルドのバージョンは `package.json` のままなので、同じ番号の公式リリースとは区別がつかない。自動更新は upstream の Release を見るため、新しい公式リリースが出たときにだけ上書きされる。
- artifact の保持期間は 14 日に設定する（作り手の判断。自分用の試しビルドなので長期保存は不要）。

## 作り手に任せること

- ステップ名やコメントの文言、artifact 名の細かな形式。
