#!/bin/bash
set -euo pipefail

# Runner setup only: no global sandbox-disable flags or sysctl changes.
test "${GITHUB_ACTIONS:-}" = true
sudo apt-get update
sudo apt-get install -y xvfb dbus-x11 libnss3 libasound2t64 libfuse2t64 apparmor

# Keep Node's tmpdir and AppImage's extraction base aligned with the profiles,
# even when the runner started with a different TMPDIR.
smoke_tmp="$RUNNER_TEMP/dsh-desktop-smoke"
mkdir -p "$smoke_tmp"
echo "TMPDIR=$smoke_tmp" >> "$GITHUB_ENV"

if [[ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] &&
   [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]; then
  profile_file="$RUNNER_TEMP/dsh-desktop-ci.apparmor"
  cat > "$profile_file" <<EOF
abi <abi/4.0>,
include <tunables/global>
profile dsh-electron-ci "$GITHUB_WORKSPACE/node_modules/**/dist/electron" flags=(unconfined) { userns, }
profile dsh-unpacked-ci "$GITHUB_WORKSPACE/release/linux-unpacked/dsh-desktop" flags=(unconfined) { userns, }
profile dsh-appimage-ci "$GITHUB_WORKSPACE/release/dsh-desktop-*-linux-x86_64.AppImage" flags=(unconfined) { userns, }
profile dsh-apprun-ci "$smoke_tmp/dsh-appimage-*/squashfs-root/AppRun" flags=(unconfined) { userns, }
profile dsh-extracted-ci "$smoke_tmp/dsh-appimage-*/squashfs-root/dsh-desktop" flags=(unconfined) { userns, }
# The AppImage entry profile is normally inherited by its children. Also
# cover direct execution from its extract-and-run tree explicitly.
profile dsh-runtime-extracted-ci "$smoke_tmp/appimage_extracted_*/dsh-desktop" flags=(unconfined) { userns, }
EOF
  sudo apparmor_parser -r "$profile_file"
fi

nohup Xvfb :99 -screen 0 1280x800x24 > "$RUNNER_TEMP/dsh-xvfb.log" 2>&1 &
echo 'DISPLAY=:99' >> "$GITHUB_ENV"
echo "DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)" >> "$GITHUB_ENV"
