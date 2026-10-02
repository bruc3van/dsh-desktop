#!/bin/sh
set -eu

# This hook runs as root; the application itself always runs as the desktop user.
update-alternatives --install /usr/bin/dsh-desktop dsh-desktop '/opt/DSH Desktop/dsh-desktop' 100
# Ubuntu 24.04 uses user namespaces with the application-scoped AppArmor grant.
chmod 0755 '/opt/DSH Desktop/chrome-sandbox'

profile_source='/opt/DSH Desktop/resources/apparmor-profile'
profile_target='/etc/apparmor.d/dsh-desktop-deb'
# Keep the profile on disk even when installing into an offline image. On older
# AppArmor versions, do not install a profile using an unsupported ABI.
if command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser --skip-kernel-load --debug "$profile_source" >/dev/null 2>&1; then
    install -m 0644 "$profile_source" "$profile_target"
    if apparmor_status --enabled >/dev/null 2>&1 && ! ischroot; then
        apparmor_parser --replace --write-cache --skip-read-cache "$profile_target"
    fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
