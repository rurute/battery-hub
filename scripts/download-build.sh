#!/usr/bin/env bash
# Downloads the installer that .github/workflows/build.yml made, into dist/ci/<artifact name>/.
#
#   scripts/download-build.sh            the latest successful build of the current branch
#   scripts/download-build.sh <run-id>   a given run
#
# Does the same as `gh run download -D dist/ci`, but faster: GitHub serves artifacts slowly over one
# connection (about 0.3 MB/s here), so this fetches the zip in several byte ranges at once and joins
# them. Needs gh (signed in), curl and python3 (to unzip).
#
# Environment: BATTERY_HUB_REPO (default rurute/battery-hub), PARTS (parallel ranges, default 16).
set -euo pipefail

REPO="${BATTERY_HUB_REPO:-rurute/battery-hub}"
PARTS="${PARTS:-16}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist/ci"

run_id="${1:-}"
if [ -z "$run_id" ]; then
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  run_id="$(gh run list -R "$REPO" -w build.yml -b "$branch" -s success -L 1 --json databaseId --jq '.[0].databaseId // empty')"
  if [ -z "$run_id" ]; then
    echo "No successful build.yml run for branch $branch. Start one with:" >&2
    echo "  gh workflow run build.yml -R $REPO --ref $branch" >&2
    exit 1
  fi
fi

artifacts="$(gh api "repos/$REPO/actions/runs/$run_id/artifacts" \
  --jq '.artifacts[] | select(.expired | not) | "\(.id) \(.size_in_bytes) \(.digest // "-") \(.name)"')"
if [ -z "$artifacts" ]; then
  echo "Run $run_id has no artifacts left (they are kept for 14 days)." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

while read -r id size digest name; do
  echo "Run $run_id: $name ($((size / 1048576)) MB, $PARTS parts)"
  start=$SECONDS

  # The API answers with a redirect to a short-lived signed URL; ranges are fetched from that.
  url="$(curl -fsS -o /dev/null -w '%{redirect_url}' \
    -H "Authorization: Bearer $(gh auth token)" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO/actions/artifacts/$id/zip")"
  if [ -z "$url" ]; then
    echo "Could not get a download URL for artifact $id." >&2
    exit 1
  fi

  chunk=$(((size + PARTS - 1) / PARTS))
  pids=()
  for ((i = 0; i < PARTS; i++)); do
    from=$((i * chunk))
    to=$((from + chunk - 1))
    ((to >= size)) && to=$((size - 1))
    ((from > to)) && break
    curl -fsS --retry 3 --retry-all-errors -r "$from-$to" -o "$work/part.$i" "$url" &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || { echo "A part failed to download." >&2; exit 1; }
  done

  zip="$work/$name.zip"
  : >"$zip"
  for ((i = 0; i < ${#pids[@]}; i++)); do cat "$work/part.$i" >>"$zip"; done

  got=$(stat -c %s "$zip")
  if [ "$got" -ne "$size" ]; then
    echo "Downloaded $got bytes, expected $size." >&2
    exit 1
  fi
  if [ "$digest" != "-" ]; then
    actual="sha256:$(sha256sum "$zip" | cut -d' ' -f1)"
    if [ "$actual" != "$digest" ]; then
      echo "Checksum mismatch: got $actual, expected $digest." >&2
      exit 1
    fi
  fi

  dest="$OUT_DIR/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  python3 -I -m zipfile -e "$zip" "$dest"
  echo "Wrote $dest in $((SECONDS - start))s:"
  ls -1 "$dest" | sed 's/^/  /'
done <<<"$artifacts"
