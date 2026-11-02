#!/bin/bash
# Starts a built Linux app the way a desktop launcher does (no extra flags) on a throwaway X server and HOME, and
# reports whether it stayed up and mapped its window.
#
#   launch-check.sh <out dir> <label> <secs> <command...>
#
# e.g. launch-check.sh ~/.cache/launch appimage 20 ./my-mate-geny-0.4.99-linux-x86_64.AppImage
#      launch-check.sh ~/.cache/launch deb 20 "/path/to/extracted/opt/My Mate Geny/hr-harnessor-desktop" --ozone-platform=x11
#
# Writes <out dir>/<label>.log (the app's stdout/stderr, the X windows, alive or not) and <out dir>/<label>.png (the
# screen; needs ImageMagick's `import`). Only the process group it started is killed. Extra env for the app can be
# passed as usual (`HRH_FOO=1 launch-check.sh …`); SECOND=1 also starts a second instance after <secs>/2 (it must
# hand over to the first and exit); FIRST_EXTRA="--hidden" starts the first one in the tray only.
out=$1; label=$2; secs=$3; shift 3
[ -n "$out" ] && [ -n "$label" ] && [ -n "$secs" ] && [ $# -gt 0 ] || { echo "usage: $0 <out dir> <label> <secs> <command...>" >&2; exit 2; }
mkdir -p "$out"
out=$(cd "$out" && pwd)
H="$out/home-$label"
rm -rf "$H"
mkdir -p "$H"
log="$out/$label.log"
export HOME="$H" XDG_CONFIG_HOME="$H/.config" XDG_CACHE_HOME="$H/.cache" OUT="$out" LABEL="$label"
unset APPIMAGE APPDIR OWD ARGV0 WAYLAND_DISPLAY XDG_SESSION_TYPE ELECTRON_OZONE_PLATFORM_HINT
cd "$H" || exit 1
timeout -k 5 $((secs * 2 + 30)) xvfb-run -a -s "-screen 0 1400x900x24" bash -c '
  secs=$1; shift
  setsid "$@" $FIRST_EXTRA &
  pid=$!
  if [ -n "$SECOND" ]; then
    sleep $((secs / 2))
    echo "--- windows before the second launch:"
    xwininfo -root -tree | grep -iE "geny|harness" | grep -v "\.bin" | head -20
    echo "--- second instance:"
    timeout 20 "$@"; echo "--- second instance exit: $?"
  fi
  sleep "$secs"
  echo "--- windows:"
  xwininfo -root -tree | grep -iE "geny|harness" | head -20
  import -window root "$OUT/$LABEL.png" 2>/dev/null ||
    ffmpeg -loglevel error -y -f x11grab -video_size 1400x900 -i "$DISPLAY" -frames:v 1 "$OUT/$LABEL.png" 2>/dev/null || true
  echo "--- alive after ${secs}s: $(kill -0 $pid 2>/dev/null && echo yes || echo no)"
  # quit like a desktop logout: SIGTERM to the app'"'"'s main process (the one without --type=), then the rest
  main=$(ps -o pid=,args= -g "$pid" | awk '"'"'!/--type=/ && /\.bin|electron/ {print $1; exit}'"'"')
  [ -n "$main" ] && kill -TERM "$main" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -TERM -- -$pid 2>/dev/null
  sleep 1
  kill -KILL -- -$pid 2>/dev/null
  wait $pid
  echo "--- exit: $?"
' _ "$secs" "$@" > "$log" 2>&1
echo "runner exit=$? log=$log"
grep -v "^\s*$" "$log" | head -80
