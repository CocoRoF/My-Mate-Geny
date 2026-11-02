#!/bin/sh
# My Mate Geny — Linux launcher. build/after-pack.js puts this script where the Electron binary was (the binary
# becomes "<name>.bin" next to it), so every way of starting the app goes through it: the .deb's menu entry and
# /usr/bin link, the AppImage's AppRun (a double-click passes no arguments), start at login and the app's own
# restarts.
#
# Why: Chromium sandboxes its renderers with unprivileged user namespaces, or else with the SUID-root helper
# `chrome-sandbox`. When neither is usable it aborts before any of the app's code runs —
#   FATAL:setuid_sandbox_host.cc … The SUID sandbox helper binary was found, but is not configured correctly …
# — and a launcher click shows nothing. That is the case on Ubuntu 23.10+ (AppArmor restricts unprivileged user
# namespaces: kernel.apparmor_restrict_unprivileged_userns=1) for
#   - every AppImage (its chrome-sandbox lives in a FUSE mount owned by the user and mounted nosuid), and
#   - a .deb whose chrome-sandbox was left 0755 (electron-builder's stock postinst did that: its `unshare --user
#     true` test passes there, although the namespace gets no capabilities);
# and on systems with user namespaces off (Debian's kernel.unprivileged_userns_clone=0, user.max_user_namespaces=0).
#
# So: the sandbox stays on when it can work — chrome-sandbox is root-owned SUID on a suid mount (our .deb's
# postinst sets that), or this user can create a user namespace with capabilities, or our AppArmor profile
# (installed by the .deb on AppArmor 4 systems) grants them to the binary. Otherwise the app starts with
# --no-sandbox (renderers then run without the OS sandbox; the app only loads its own pages and the user's own
# server, with context isolation). HRH_SANDBOX=off forces --no-sandbox, HRH_SANDBOX=on never adds it.

self=$(readlink -f "$0" 2>/dev/null || echo "$0")
here=$(dirname "$self")
bin="$self.bin"
helper="$here/chrome-sandbox"

suid_helper_ok() {
  [ -u "$helper" ] && [ -x "$helper" ] || return 1
  [ "$(stat -c %u "$helper" 2>/dev/null)" = 0 ] || return 1
  # no_new_privs (inherited from whatever started us) makes the kernel ignore the bit
  grep -qE '^NoNewPrivs:[[:space:]]*1' /proc/self/status 2>/dev/null && return 1
  # so does a nosuid mount
  if command -v findmnt >/dev/null 2>&1; then
    case ",$(findmnt -n -o OPTIONS --target "$helper" 2>/dev/null)," in *,nosuid,*) return 1 ;; esac
  fi
  return 0
}

userns_ok() {
  # what Chromium needs: a new user namespace in which it may map itself (Ubuntu's AppArmor restriction lets the
  # unshare succeed but refuses the uid map)
  if command -v unshare >/dev/null 2>&1; then
    unshare --user --map-root-user true >/dev/null 2>&1
    return $?
  fi
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 0 ] || return 1
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 1 ] || return 1
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" != 0 ] || return 1
  return 0
}

apparmor_profile_ok() {
  # the .deb's profile (hr-harnessor-desktop) grants `userns` to exactly this path
  f=/etc/apparmor.d/hr-harnessor-desktop
  [ -r "$f" ] && grep -qF "\"$bin\"" "$f" 2>/dev/null
}

sandbox=""
for a in "$@"; do
  [ "$a" = "--no-sandbox" ] && sandbox="off:asked"
done
if [ -z "$sandbox" ]; then
  case "${HRH_SANDBOX:-}" in
    off|0|no) sandbox="off:HRH_SANDBOX" ;;
    on|1|yes) sandbox="on:HRH_SANDBOX" ;;
    *)
      if suid_helper_ok; then sandbox="on:suid-helper"
      elif userns_ok; then sandbox="on:userns"
      elif apparmor_profile_ok; then sandbox="on:apparmor-profile"
      else sandbox="off:no-userns-no-suid-helper"
      fi ;;
  esac
fi

export HRH_SANDBOX_STATE="$sandbox"
export HRH_LAUNCHER="$self"
case "$sandbox" in
  off:no-userns-no-suid-helper)
    echo "my-mate-geny: the Chromium sandbox cannot work here (no usable user namespaces, chrome-sandbox not SUID root) — starting with --no-sandbox" >&2
    exec "$bin" --no-sandbox "$@" ;;
  off:HRH_SANDBOX)
    exec "$bin" --no-sandbox "$@" ;;
  *)
    exec "$bin" "$@" ;;
esac
