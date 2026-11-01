#!/usr/bin/env bash
# Put a new web console build live without breaking pages that are already open.
#
#   deploy/swap-frontend.sh [--build] [--keep-days N] [FRONTEND_DIR]
#
# FRONTEND_DIR (default: this repo's frontend/) holds dist/ (served as STATIC_DIR) and the new build in dist-next/.
# --build first runs `vite build --outDir dist-next` there (inside `capped -m 4G` when available).
#
# Why: a page (console, Mate windows, a phone) that loaded the previous build keeps importing the previous build's
# code-split files (assets/<View>-<hash>.js) as views are opened. Deleting them with the old dist/ made those imports
# fail → a black window. So:
#   1. dist-next/ is checked (index.html exists, every /assets/ file it names exists);
#   2. the files of the live dist/assets/ that the new build does not have are copied into dist-next/assets/, and
#      kept for --keep-days (default 7) after the deploy that retired them (ledger: FRONTEND_DIR/.dist-retired.tsv);
#   3. dist-next/ and dist/ are swapped atomically (`mv --exchange`, coreutils ≥ 9.5; else two renames), the old
#      directory is removed. dist/ is replaced by a rename, never emptied in place, and keeps its path (STATIC_DIR is
#      read by path, so the backend needs no restart).
# The backend serves index.html with `Cache-Control: no-cache` and assets/* as immutable (backend/app/static_files.py),
# so every page that loads after the swap gets the new build.
set -euo pipefail

KEEP_DAYS=7
BUILD=0
FE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --keep-days) KEEP_DAYS="${2:?--keep-days needs a number}"; shift ;;
    --keep-days=*) KEEP_DAYS="${1#*=}" ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) FE="$1" ;;
  esac
  shift
done
case "$KEEP_DAYS" in ''|*[!0-9]*) echo "--keep-days: not a number: $KEEP_DAYS" >&2; exit 2 ;; esac
[ -n "$FE" ] || FE="$(cd "$(dirname "$0")/../frontend" && pwd)"
FE="$(cd "$FE" && pwd)"
DIST="$FE/dist"
NEXT="$FE/dist-next"
LEDGER="$FE/.dist-retired.tsv"

if [ "$BUILD" = 1 ]; then
  cap=()
  command -v capped >/dev/null 2>&1 && cap=(capped -m 4G --)
  (cd "$FE" && "${cap[@]}" npx vite build --outDir dist-next --emptyOutDir)
fi

# 1. the new build is complete
[ -f "$NEXT/index.html" ] || { echo "no build at $NEXT (index.html missing) — nothing swapped" >&2; exit 1; }
missing=0
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  if [ ! -f "$NEXT/$ref" ]; then echo "dist-next/index.html names $ref, which the build does not have" >&2; missing=1; fi
done < <(grep -oE '/assets/[A-Za-z0-9._@+-]+\.[A-Za-z0-9]+' "$NEXT/index.html" | sed 's#^/##' | sort -u)
[ "$missing" = 0 ] || { echo "incomplete build — nothing swapped" >&2; exit 1; }
mkdir -p "$NEXT/assets"

# 2. carry the live build's files forward (for pages still open on it), dropping those retired > KEEP_DAYS ago
now=$(date +%s)
limit=$((KEEP_DAYS * 86400))
declare -A retired=()
if [ -f "$LEDGER" ]; then
  while IFS=$'\t' read -r name t; do
    [ -n "$name" ] && [[ "$t" =~ ^[0-9]+$ ]] && retired["$name"]="$t"
  done < "$LEDGER"
fi
carried=0
dropped=0
tmp_ledger="$LEDGER.tmp.$$"
: > "$tmp_ledger"
if [ -d "$DIST/assets" ]; then
  for f in "$DIST/assets"/* "$DIST/assets"/.[!.]*; do
    [ -f "$f" ] || continue
    name="${f##*/}"
    [ -e "$NEXT/assets/$name" ] && continue # still part of the new build
    t="${retired[$name]:-$now}"
    if [ $((now - t)) -gt "$limit" ]; then
      dropped=$((dropped + 1))
      continue
    fi
    cp -p "$f" "$NEXT/assets/$name"
    printf '%s\t%s\n' "$name" "$t" >> "$tmp_ledger"
    carried=$((carried + 1))
  done
fi
mv -f "$tmp_ledger" "$LEDGER"

# 3. swap
if [ ! -e "$DIST" ]; then
  mv "$NEXT" "$DIST"
elif mv --help 2>/dev/null | grep -q -- '--exchange'; then
  mv -T --exchange "$NEXT" "$DIST" # atomic: no moment without a dist/
  rm -rf "$NEXT"
else
  rm -rf "$DIST-old"
  mv "$DIST" "$DIST-old"
  mv "$NEXT" "$DIST"
  rm -rf "$DIST-old"
fi

new=$(find "$DIST/assets" -maxdepth 1 -type f | wc -l)
echo "frontend swapped: $DIST — $new files in assets/ ($carried kept from earlier builds, $dropped older than ${KEEP_DAYS}d removed)"
