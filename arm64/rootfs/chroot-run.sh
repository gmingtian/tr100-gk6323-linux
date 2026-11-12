#!/bin/bash
# Called only in a private mount/PID namespace by build.py.
set -euo pipefail
root=$(realpath -- "$1")
[[ "$root" != / && -f "$root/etc/tr100/build-marker" ]]
[[ $(cat "$root/etc/tr100/build-marker") == tr100-clean-rootfs-v1 ]]
mount --make-rprivate /
cleanup() { umount -R "$root/proc" 2>/dev/null || :; umount -R "$root/dev" 2>/dev/null || :; }
trap cleanup EXIT
mkdir -p "$root/proc" "$root/dev"
mount -t proc proc "$root/proc"
mount -t tmpfs -o mode=755,nosuid tmpfs "$root/dev"
for spec in 'null 1 3 666' 'zero 1 5 666' 'random 1 8 666' 'urandom 1 9 666' 'tty 5 0 666'; do
    read -r node major minor mode <<< "$spec"
    mknod -m "$mode" "$root/dev/$node" c "$major" "$minor"
done
mkdir -p "$root/dev/pts" "$root/dev/shm"
mount -t devpts -o newinstance,ptmxmode=0666,mode=0620 devpts "$root/dev/pts"
ln -s pts/ptmx "$root/dev/ptmx"
ln -s /proc/self/fd "$root/dev/fd"
if [[ -x "$root/debootstrap/debootstrap" && ! -x "$root/usr/bin/dpkg" ]]; then
    chroot "$root" /debootstrap/debootstrap --second-stage
elif [[ -f "$root/debootstrap/debootstrap" ]]; then
    # A foreign first stage can already contain dpkg, so use its explicit completion flag.
    [[ -f "$root/debootstrap/debootstrap.log" ]] && chroot "$root" /debootstrap/debootstrap --second-stage
fi
TR100_ROOTFS_BUILD=1 TR100_OFFLINE="$2" TR100_WITH_DOCKER="${3:-0}" chroot "$root" /bin/bash /usr/local/libexec/tr100-provision-root
