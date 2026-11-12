#!/bin/bash
# Only execute inside the builder's clean staged Debian ARM64 chroot.
set -euo pipefail
[[ ${TR100_ROOTFS_BUILD:-} == 1 && $EUID == 0 ]]
[[ -f /etc/tr100/build-marker && $(cat /etc/tr100/build-marker) == tr100-clean-rootfs-v1 ]]
[[ -d /proc/1/root ]]
[[ $(stat -Lc '%d:%i' /) != $(stat -Lc '%d:%i' /proc/1/root) ]] || { echo 'Refusing the running host root' >&2; exit 1; }
[[ $(dpkg --print-architecture) == arm64 && $(getconf LONG_BIT) == 64 ]]
export DEBIAN_FRONTEND=noninteractive
export TZ=Asia/Shanghai
mkdir -p /run/sshd /etc/apt/sources.list.d /etc/tr100 /usr/lib/tr100
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d
# Multiarch provides the real ARMHF dynamic loader and libraries; kernel old-time
# syscall support is separately enabled and tested by compat-probe-armhf.c.
dpkg --add-architecture armhf
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
snapshot=$(cat /etc/tr100/build-snapshot)
printf 'deb [check-valid-until=no] %s bookworm main\ndeb [check-valid-until=no] %s bookworm-updates main\n' "$snapshot" "$snapshot" > /etc/apt/sources.list
security_snapshot=${snapshot/\/archive\/debian\//\/archive\/debian-security\/}
printf 'deb [check-valid-until=no] %s bookworm-security main\n' "$security_snapshot" >> /etc/apt/sources.list
mapfile -t packages < <(sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' /etc/tr100/build-packages)
mapfile -d '' -t debs < <(find /var/cache/tr100-build -type f -name '*.deb' -print0 2>/dev/null || :)
apt_flags=(-y --no-install-recommends -o Dpkg::Use-Pty=0 -o Dpkg::Options::=--force-confold)
if [[ ${TR100_OFFLINE:-0} == 1 ]]; then
    [[ ${#debs[@]} -gt 0 ]] || { echo 'Offline mode needs complete verified ARM64 and ARMHF .deb archives' >&2; exit 1; }
    apt-get "${apt_flags[@]}" -o Acquire::http::Proxy=http://127.0.0.1:9 -o Acquire::https::Proxy=http://127.0.0.1:9 install "${debs[@]}" "${packages[@]}"
else
    apt-get -o Acquire::Check-Valid-Until=false update
    if [[ ${#debs[@]} -gt 0 ]]; then
        apt-get "${apt_flags[@]}" install "${debs[@]}"
    fi
    apt-get "${apt_flags[@]}" install "${packages[@]}"
fi
[[ -x /sbin/init && -x /usr/bin/fbterm && -x /usr/bin/openvt && -x /usr/bin/fbset && -x /usr/sbin/sshd ]]
[[ -e /lib/ld-linux-armhf.so.3 ]]
# Use the packaged native static BusyBox for predictable DHCP hook applets.
install -m 0755 /bin/busybox /usr/lib/tr100/busybox
if [[ ${TR100_WITH_DOCKER:-0} == 1 ]]; then
if [[ ! -x /opt/tr100-docker/dockerd ]]; then
    [[ ${TR100_OFFLINE:-0} != 1 ]] || { echo 'Offline mode requires verified Docker archive' >&2; exit 1; }
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 https://download.docker.com/linux/static/stable/aarch64/docker-29.9.3.tgz -o /tmp/docker.tgz
    printf '%s\n' '1b27fd739378ef938401e81ce5afb73b7ad7432d4f598814a9ff5f826bb464d2  /tmp/docker.tgz' | sha256sum -c -
    mkdir -p /opt/tr100-docker
    tar xzf /tmp/docker.tgz -C /opt/tr100-docker --strip-components=1
    rm /tmp/docker.tgz
fi
[[ $(/opt/tr100-docker/docker --version) == 'Docker version 29.9.3,'* ]]
chown -R root:root /opt/tr100-docker
for binary in /opt/tr100-docker/*; do ln -snf "$binary" "/usr/local/bin/${binary##*/}"; done
getent group docker >/dev/null || groupadd --system docker
mkdir -p /etc/docker
printf '%s\n' '{"storage-driver":"overlay2","log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}' > /etc/docker/daemon.json
systemctl enable docker.service
sha256sum /opt/tr100-docker/* > /etc/tr100/docker.lock
else
    # A supplied cache must not silently turn the minimal profile into Docker.
    rm -rf /opt/tr100-docker /etc/docker
    rm -f /etc/tr100/docker.lock /etc/systemd/system/docker.service
    for binary in /usr/local/bin/*; do
        [[ -L "$binary" && $(readlink "$binary") == /opt/tr100-docker/* ]] && rm "$binary" || :
    done
fi
ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
printf '%s\n' Asia/Shanghai > /etc/timezone
mkdir -p /etc/systemd/journald.conf.d /etc/systemd/timesyncd.conf.d
printf '%s\n' '[Journal]' 'SystemMaxUse=64M' 'RuntimeMaxUse=16M' 'MaxRetentionSec=7day' > /etc/systemd/journald.conf.d/tr100.conf
printf '%s\n' '[Time]' 'NTP=ntp.aliyun.com cn.pool.ntp.org' > /etc/systemd/timesyncd.conf.d/tr100.conf
# Runtime mirror preference; build provenance remains the fixed Debian snapshot.
rm /etc/apt/sources.list
cat > /etc/apt/sources.list.d/debian.sources <<'EOF'
Types: deb
URIs: https://mirrors.cloud.tencent.com/debian
Suites: bookworm bookworm-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://mirrors.cloud.tencent.com/debian-security
Suites: bookworm-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
systemctl enable ssh.service tr100-network.service systemd-timesyncd.service fake-hwclock.service
systemctl enable serial-getty@ttyAMA0.service
systemctl mask systemd-networkd.service systemd-networkd.socket systemd-resolved.service
systemctl set-default multi-user.target
# depmod targets the image's module ABI, not the build worker's running kernel.
for modules in /lib/modules/*; do
    [[ -d "$modules" ]] || continue
    depmod -a "${modules##*/}"
done
if [[ -e /lib/modules/5.10.165_gk6323-tr100-arm64/extra/gfbg.ko || -e /lib/modules/5.10.165_gk6323-tr100-arm64-kvm/extra/gfbg.ko ]]; then
    chmod 755 /usr/local/sbin/tr100-display-modules /usr/local/sbin/tr100-hdmi-console
    systemctl enable tr100-display-modules.service tr100-hdmi-console.service
    systemctl mask getty@tty1.service
fi
if [[ ( -e /lib/modules/5.10.165_gk6323-tr100-arm64-kvm/updates/tr100-onboard/sprdwl_ng.ko || -e /lib/modules/5.10.165_gk6323-tr100-arm64-kvm/extra/sprdwl_ng.ko ) && -e /lib/firmware/unisoc/wcnmodem.bin && -e /lib/firmware/unisoc/wifi_56630001_3ant.ini ]]; then
    chmod 755 /usr/local/sbin/tr100-onboard-wifi
    systemctl enable tr100-onboard-wifi.service
fi
fc-cache -f
# Record exact resolved packages and binaries for review/rebuild comparisons.
dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' | sort > /etc/tr100/packages.lock
rm -f /usr/sbin/policy-rc.d /usr/bin/qemu-aarch64-static
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/tr100-build /root/provision-root.sh /debootstrap
# Host builder sanitizes after this returns; never publish this intermediate root.
printf '%s\n' clean-rootfs-provisioned-v1 > /etc/tr100/provisioned
printf '%s\n' ARM64_DEBIAN_PROVISIONED
