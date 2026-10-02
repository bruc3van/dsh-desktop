#!/bin/sh
set -eu

# The old package's postrm can run during upgrade: leave the new registration
# intact. Only explicit removal/purge owns cleanup; never touch user data.
case "${1:-remove}" in
    remove|purge) ;;
    *) exit 0 ;;
esac
if update-alternatives --query dsh-desktop >/dev/null 2>&1; then
    update-alternatives --remove dsh-desktop '/opt/DSH Desktop/dsh-desktop'
fi
profile_target='/etc/apparmor.d/dsh-desktop-deb'
if [ -f "$profile_target" ]; then
    if apparmor_status --enabled >/dev/null 2>&1 && ! ischroot; then
        apparmor_parser --remove "$profile_target"
    fi
    rm -f "$profile_target"
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
