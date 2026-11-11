#!/bin/bash
# Read-only post-boot observations. No account or configuration changes.
set -euo pipefail
export LC_ALL=C
test "$(findmnt -rn -o SOURCE /)" = /dev/mmcblk0p8
test "$(findmnt -rn -o FSTYPE /)" = ext4
test "$(cat /sys/class/block/mmcblk0p8/start)" = 86016
test "$(cat /sys/class/block/mmcblk0p8/size)" = 15183872
test "$(blkid -s UUID -o value /dev/mmcblk0p8)" = a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230
test "$(cat /etc/tr100/image-tag)" = tr100-pure-linux-20261111
test "$(find /sys/class/block -maxdepth 1 -name 'mmcblk0p*' | wc -l)" = 8
test ! -e /system/build.prop
test ! -e /vendor/build.prop
test ! -e /init.rc
if ps -eo comm= | grep -Eq '^(zygote|zygote64|system_server|surfaceflinger|adbd)$'; then exit 1; fi
case "$(cat /proc/cmdline)" in *tr100.ramtest=*|*tr100.root_sha256=*|*systemd.unified_cgroup_hierarchy=*|*rdinit=*) exit 1;; esac
test "$(systemctl is-system-running)" = running
test "$(systemctl --failed --no-legend | wc -l)" = 0
test "$(cat /etc/timezone)" = Asia/Shanghai
ssh_policy=$(/usr/sbin/sshd -T -C user=root,host=tr100,addr=192.168.5.253)
for field in 'passwordauthentication yes' 'permitrootlogin yes' 'pubkeyauthentication yes'; do
    grep -qx "$field" <<<"$ssh_policy"
done
printf 'PURE_P8_CORE_RUNTIME_VERIFIED\n'
uname -a
if [ -r /etc/armbian-release ]; then cat /etc/armbian-release; else cat /etc/os-release; fi
cat /proc/cmdline
lsblk -b -o NAME,SIZE,MAJ:MIN,MOUNTPOINT
df -h /
df -B1 /
findmnt /
ip -br address
ip route
cat /run/tr100/dhcp-lease
printf 'NIC speed='; cat /sys/class/net/eth0/speed
printf 'NIC duplex='; cat /sys/class/net/eth0/duplex
systemctl is-active ssh tr100-network systemd-timesyncd
systemctl --failed --no-legend
timedatectl show -p Timezone -p NTPSynchronized
getent passwd _apt systemd-timesync
getent group inet
cat /etc/apt/sources.list.d/debian.sources
passwd -S root
printf 'machine_id_sha256='; sha256sum /etc/machine-id
printf 'boot_id='; cat /proc/sys/kernel/random/boot_id
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
openssl dgst -sha256 /dev/mmcblk0p1 /dev/mmcblk0p2 /dev/mmcblk0p4 /dev/mmcblk0p5 /dev/mmcblk0p6 /dev/mmcblk0p7
printf 'PURE_RUNTIME_READONLY_OBSERVATIONS_COMPLETE\n'
