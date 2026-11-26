# この fork の運用

`rurute/battery-hub` は、本家 [`battery-hub/battery-hub`](https://github.com/battery-hub/battery-hub) に入らない変更も持つ、自分用の配布版。`main` は「本家 + fork の変更」で、本家は merge で取り込む（rebase や force push はしない）。fork 版のアプリは fork の Releases から自動更新する。

決めた経緯は `docs/superpowers/specs/2026-11-26-fork-release-design.md`（fork Issue #7）。

## ブランチ

| 種類 | 切る元 | PR 先 | 決まりごと |
|---|---|---|---|
| 本家に出す変更 | `upstream/main` | 本家に PR し、fork の `main` にも入れる | 本家に入ったあと、取り込みで衝突したら本家の版を採る |
| fork だけの変更 | fork の `main` | fork（`gh pr create -R rurute/battery-hub`） | 新しいファイルに置く。本家のファイルへの変更は数行のつなぎだけにし、`// fork:`（言語に合わせたコメント）の目印を付ける |
| 本家の取り込み | fork の `main` | fork | `chore/merge-upstream-X.Y.Z`。下の手順 |

`gh pr create` は何も付けないと本家を向くので、fork への PR には必ず `-R rurute/battery-hub` を付ける。

## fork だけの変更の一覧

本家との差分は `git diff --stat upstream/main...main` で見られる。取り込みで衝突したら、ここに載っているものが自分の変更。

### 本家に入ったもの

- SONY INZONE Buds（本家 PR #199、merge 済み）。次の取り込みで本家の版にそろえる。

### 本家に PR 中のもの

- Logitech Lightspeed の 1 レシーバー複数台（本家 PR #230）。`src/main/hid/drivers/lightspeed.js`、`hidpp.js`、`identity.js`、`main.js`、`poller.js` など。
- ELECOM BlueLED Mouse の Bluetooth 読み取り（本家 PR #239）。`src/main/hid/drivers/elecom.js`、`get-input-report.ps1` など。

本家に入ったら、取り込みのときに本家の版を採り、この節から「本家に入ったもの」に移す。

### fork だけのもの

| もの | 目的 | 確かめ方 |
|---|---|---|
| `.github/workflows/build.yml` | ブランチを指定して自分用インストーラーを作る（バージョン `X.Y.Z-fork.0.<run>`） | `gh workflow run build.yml -R rurute/battery-hub --ref <branch>` が通る |
| `scripts/download-build.sh` | `build.yml` の成果物を速く落とす | 実行してインストーラーが `dist/ci` に来る |
| `.github/workflows/fork-release.yml` | タグ `v*-fork.*` で fork の Release を出す | 下の「fork のリリース」 |
| `scripts/fork-version.js`（`test/fork-version.test.js`） | CI の中だけで `package.json` の `version` と `build.publish` を fork 向けに書き換える | `npm test` |
| `src/main/diagnostics.js` の `isNewer`（`// fork:`） | 診断の版数比較で `-fork.N` を無視する（`2.0.7-fork.1` を本家 `2.0.7` と同じとみなす） | `npm test`。fork 版の診断で Version が通る |
| `docs/superpowers/` の spec と plan、この `docs/fork.md` | 設計と運用の記録 | — |

## 止めているワークフロー

fork のリポジトリの設定で止めている。設定なので、本家を取り込んでも戻らない。ファイルは消さない（消すと本家がそのファイルを変えるたびに衝突する）。

- `triage.yml`: 本家の Issue ボット。fork の Issue にラベルやコメントを付けないように止めている（GitHub が fork では最初から止めている）。
- `release.yml`: 本家のリリース。トリガーの `v*` が fork のタグにも当たり、本家の Releases に出そうとするので止めている（`gh workflow disable release.yml -R rurute/battery-hub`）。

本家の取り込みでワークフローが増えたら、fork で動いてよいかを見て、だめなら止める。

## 本家の取り込み

1. `git fetch upstream && git checkout main && git pull && git checkout -b chore/merge-upstream-X.Y.Z`
2. `git merge upstream/main`。衝突を解く。本家に入った変更は本家の版を採る。`// fork:` の所は fork の変更を残す。
3. `npm test`
4. `gh workflow run build.yml -R rurute/battery-hub --ref chore/merge-upstream-X.Y.Z` で作ったインストーラーで、上の一覧の fork だけの変更を確かめる。
5. fork に PR（`gh pr create -R rurute/battery-hub --base main`）して merge。
6. `main` で fork のリリース `vX.Y.Z-fork.1` を出す（下）。

本家の新しいリリースは、取り込んで fork のリリースを出すまで届かない。

## fork のリリース

バージョンは `X.Y.Z-fork.N`。`X.Y.Z` は取り込んだ本家のバージョン（`package.json` の `version`）、`N` はその上での fork のリリースの番号で 1 から数える。`X.Y.Z` が変わったら 1 に戻る。

```sh
git checkout main && git pull
git tag vX.Y.Z-fork.N && git push origin vX.Y.Z-fork.N
gh run watch -R rurute/battery-hub
gh release view vX.Y.Z-fork.N -R rurute/battery-hub
```

- タグの `X.Y.Z` が `package.json` と違うと、`fork-release.yml` は失敗する。
- リリースは確認待ちにせず、そのまま公開される。インストーラー、`latest.yml`、blockmap、`SHA256SUMS.txt` が付いていることを確かめる。
- 一度出した番号は消して使い直さない。上の番号を入れた PC が、使い直した番号に更新されなくなるため。

## 最初の 1 回は手でインストールする

これまでの版（本家版や、これまでの手動ビルド）は本家の Releases を見ている。最初の fork のリリースだけは、その Release の `Battery-Hub-Installer-X.Y.Z-fork.N.exe` を手でインストールする。それより前に本家の新しいリリースで置き換わっても、fork のリリースを入れ直せば戻る。

インストール後、`%LOCALAPPDATA%\Programs\battery-hub\resources\app-update.yml` の `owner` が `rurute` なら、fork から更新される。
