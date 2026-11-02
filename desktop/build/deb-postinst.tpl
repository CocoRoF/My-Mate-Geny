#!/bin/bash
# postinst of the .deb (package.json build.deb.afterInstall; electron-builder fills in the ${...} names — shell
# variables here are written without braces so it leaves them alone).
#
# electron-builder's stock script made chrome-sandbox SUID only when `unshare --user true` failed. On Ubuntu
# 23.10+ that test passes (AppArmor lets the unshare happen but takes the capabilities away), the helper stayed
# 0755, and the app aborted at every start ("The SUID sandbox helper binary was found, but is not configured
# correctly"). Now: the helper is always root-owned SUID (what Chromium falls back to), and on AppArmor 4 systems
# a profile like the ones Ubuntu ships for other Electron apps lets the app use user namespaces (Chromium's
# preferred sandbox). The launcher (build/linux-launcher.sh) still starts with --no-sandbox if neither works.

APP_DIR='/opt/${sanitizedProductName}'

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' "$APP_DIR/${executable}" 100 || ln -sf "$APP_DIR/${executable}" '/usr/bin/${executable}'
else
    ln -sf "$APP_DIR/${executable}" '/usr/bin/${executable}'
fi

# The package was hr-harnessor-desktop up to 0.4.19 (launcher /opt/.../hr-harnessor-desktop, AppArmor profile
# /etc/apparmor.d/hr-harnessor-desktop). This one Replaces + Conflicts it, so dpkg has just removed it, but its postrm
# left /usr/bin/hr-harnessor-desktop behind (it gave update-alternatives the wrong path) and, when dpkg counts the old
# package as replaced ("disappear") rather than removed, skips its AppArmor clean-up. Both are done here.
OLD_EXECUTABLE='hr-harnessor-desktop'
if [ "$OLD_EXECUTABLE" != '${executable}' ]; then
    if type update-alternatives >/dev/null 2>&1; then
        update-alternatives --remove-all "$OLD_EXECUTABLE" >/dev/null 2>&1 || true
    fi
    if [ -L "/usr/bin/$OLD_EXECUTABLE" ]; then
        rm -f "/usr/bin/$OLD_EXECUTABLE"
    fi
    if [ -e "/etc/apparmor.d/$OLD_EXECUTABLE" ]; then
        if command -v apparmor_parser >/dev/null 2>&1; then
            apparmor_parser --remove "/etc/apparmor.d/$OLD_EXECUTABLE" >/dev/null 2>&1 || true
        fi
        rm -f "/etc/apparmor.d/$OLD_EXECUTABLE"
    fi
    for f in /var/cache/apparmor/*/"$OLD_EXECUTABLE"; do
        if [ -f "$f" ]; then rm -f "$f"; fi
    done
fi

# Chromium's SUID sandbox helper: root-owned, setuid
chown root:root "$APP_DIR/chrome-sandbox" 2>/dev/null || true
chmod 4755 "$APP_DIR/chrome-sandbox" || true

# AppArmor 4 (Ubuntu 24.04+): allow user namespaces for the app's binary
APPARMOR_PROFILE='/etc/apparmor.d/${executable}'
if [ -d /etc/apparmor.d ] && [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
    tmp=$(mktemp) || tmp=''
    if [ -n "$tmp" ]; then
        cat > "$tmp" <<EOF
# My Mate Geny (package ${executable}): allows everything and only exists to let the app use user namespaces
# for Chromium's sandbox (Ubuntu restricts them for unconfined programs). Removed with the package.

abi <abi/4.0>,
include <tunables/global>

profile ${executable} "$APP_DIR/${executable}.bin" flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
EOF
        if apparmor_parser --skip-kernel-load --skip-cache --quiet "$tmp" >/dev/null 2>&1; then
            install -m 0644 "$tmp" "$APPARMOR_PROFILE"
            if aa-enabled --quiet 2>/dev/null || [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; then
                apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE" >/dev/null 2>&1 || true
            fi
        else
            echo "My Mate Geny: this AppArmor does not take the profile; skipping it (the SUID sandbox helper is used)"
        fi
        rm -f "$tmp"
    fi
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

exit 0
