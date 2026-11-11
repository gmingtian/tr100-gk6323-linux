#!/bin/sh
# Linux/root only, against a disposable freshly extracted stage, never an update.
set -eu
root=${1:-}
case "$root" in ''|/|//) echo 'Refusing host root or missing stage' >&2; exit 2;; /*) ;; *) exit 2;; esac
root=$(cd "$root" && pwd -P)
[ "$root" != / ] || { echo 'Refusing host root' >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo 'Run as root only against a disposable stage' >&2; exit 2; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$here/check-stage.sh" "$root" || { echo 'Unexpected stage metadata' >&2; exit 2; }
# All parents receiving writes must remain real directories inside this stage.
for p in etc etc/tr100 etc/apt etc/apt/sources.list.d etc/systemd etc/systemd/system-generators etc/systemd/system etc/systemd/system/ssh.service.d \
         etc/systemd/system/systemd-timesyncd.service.d \
         etc/systemd/system/multi-user.target.wants etc/systemd/system/getty.target.wants \
         etc/systemd/network etc/ssh etc/ssh/sshd_config.d \
         usr usr/local usr/local/sbin usr/local/libexec usr/sbin usr/lib usr/lib/tr100 var var/lib var/lib/dbus; do
    [ ! -L "$root/$p" ] || { echo "Unsafe stage directory: $p" >&2; exit 2; }
    mkdir -p "$root/$p"
done
for p in init etc/tr100-ram-validation usr/local/sbin/tr100-ram-network usr/local/sbin/tr100-ram-ssh-hostkeys \
         etc/systemd/system/tr100-ram-network.service etc/systemd/system/multi-user.target.wants/tr100-ram-network.service \
         etc/systemd/system/serial-getty@ttyAMA0.service.d/tr100-ram-autologin.conf \
         etc/systemd/system/ssh.service.d/tr100-ram.conf etc/ssh/sshd_config.d/00-tr100-ram.conf \
         etc/systemd/network/10-tr100-ram-eth0.link usr/bin/tr100-busybox \
         etc/ssh/ssh_host_rsa_key etc/ssh/ssh_host_rsa_key.pub etc/ssh/ssh_host_ecdsa_key \
         etc/ssh/ssh_host_ecdsa_key.pub etc/ssh/ssh_host_ed25519_key etc/ssh/ssh_host_ed25519_key.pub \
         etc/resolv.conf; do
    parent=${p%/*}
    if [ "$parent" != "$p" ] && [ -d "$root/$parent" ]; then
        resolved=$(cd "$root/$parent" && pwd -P)
        case "$resolved" in "$root"|"$root"/*) ;; *) echo 'Stage parent escapes root' >&2; exit 2;; esac
    fi
    rm -f -- "$root/$p"
done
cp -R --remove-destination -- "$here/overlay/." "$root/"
for p in usr/local/sbin/tr100-rom-bootstrap usr/local/sbin/tr100-network usr/local/sbin/tr100-enable-network \
         usr/local/libexec/tr100-udhcpc-hook usr/local/sbin/tr100-ssh-hostkeys usr/sbin/mdev; do
    chmod 0755 "$root/$p"
done
mkdir -p "$root/etc/systemd/system/multi-user.target.wants" "$root/etc/systemd/system/getty.target.wants"
ln -sfn /usr/share/zoneinfo/Asia/Shanghai "$root/etc/localtime"
ln -sfn /dev/null "$root/etc/systemd/system-generators/systemd-gpt-auto-generator"
ln -sfn /usr/lib/systemd/system/multi-user.target "$root/etc/systemd/system/default.target"
ln -sfn ../tr100-network.service "$root/etc/systemd/system/multi-user.target.wants/tr100-network.service"
ln -sfn /usr/lib/systemd/system/serial-getty@.service "$root/etc/systemd/system/getty.target.wants/serial-getty@ttyAMA0.service"
for unit in getty@tty1.service systemd-resolved.service dbus-org.freedesktop.resolve1.service \
            systemd-networkd.service dbus-org.freedesktop.network1.service systemd-networkd-wait-online.service \
            systemd-repart.service fstrim.timer fstrim.service e2scrub_all.timer e2scrub_all.service e2scrub_reap.service; do
    ln -sfn /dev/null "$root/etc/systemd/system/$unit"
done
sh "$here/prepare-identity.sh" "$root"
echo 'ROM overlay installed in fresh stage. Copy verified BusyBox/modules and PC public key separately; see README.'
