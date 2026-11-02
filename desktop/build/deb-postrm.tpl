#!/bin/bash
# postrm of the .deb (package.json build.deb.afterRemove; electron-builder fills in the ${...} names).

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# The AppArmor profile from postinst goes with the package (an upgrade's new postinst writes it again)
case "$1" in
    remove|purge)
        if [ -e '/etc/apparmor.d/${executable}' ]; then
            if command -v apparmor_parser >/dev/null 2>&1; then
                apparmor_parser --remove '/etc/apparmor.d/${executable}' >/dev/null 2>&1 || true
            fi
            rm -f '/etc/apparmor.d/${executable}'
        fi
        ;;
esac

exit 0
