#!/bin/sh
# Read actual cache metadata as data; never source os-release as shell code.
set -eu
root=${1:-}
case "$root" in ''|/|//) echo 'Refusing host root or missing stage' >&2; exit 2;; /*) ;; *) exit 2;; esac
root=$(cd "$root" && pwd -P)
[ "$root" != / ] || { echo 'Refusing host root' >&2; exit 2; }
os=$root/etc/os-release
status=$root/var/lib/dpkg/status
[ -f "$os" ] && [ ! -L "$os" ] && [ -f "$status" ] && [ ! -L "$status" ] || exit 2
grep -qx 'ID=debian' "$os" || exit 2
grep -qx 'VERSION_CODENAME=bookworm' "$os" || exit 2
grep -qx 'PRETTY_NAME="Armbian 26.11.0-trunk.123 bookworm"' "$os" || exit 2
awk 'BEGIN {RS=""; FS="\n"} {pkg=arch=installed=0; for(i=1;i<=NF;i++) {if($i=="Package: systemd") pkg=1; if($i=="Architecture: armhf") arch=1; if($i=="Status: install ok installed") installed=1} if(pkg && arch && installed) found=1} END {exit !found}' "$status" || exit 2
