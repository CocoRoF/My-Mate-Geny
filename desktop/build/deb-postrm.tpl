#!/bin/bash
# postrm of the .deb (package.json build.deb.afterRemove; electron-builder fills in the ${...} names).

case "$1" in
    remove|purge)
        # The link to the launcher (electron-builder's stock script named /usr/bin/… here, which is not the
        # alternative's path, so update-alternatives refused and the link stayed behind)
        if type update-alternatives >/dev/null 2>&1; then
            update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' >/dev/null 2>&1 || true
        fi
        if [ -L '/usr/bin/${executable}' ] && [ ! -e '/usr/bin/${executable}' ]; then
            rm -f '/usr/bin/${executable}'
        fi

        # The AppArmor profile from postinst goes with the package (an upgrade keeps it; its postinst writes it again)
        if [ -e '/etc/apparmor.d/${executable}' ]; then
            if command -v apparmor_parser >/dev/null 2>&1; then
                apparmor_parser --remove '/etc/apparmor.d/${executable}' >/dev/null 2>&1 || true
            fi
            rm -f '/etc/apparmor.d/${executable}'
        fi
        for f in /var/cache/apparmor/*/'${executable}'; do
            if [ -f "$f" ]; then rm -f "$f"; fi
        done
        ;;
esac

exit 0
