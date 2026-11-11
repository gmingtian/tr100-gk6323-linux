#!/bin/sh
# Fresh offline stage only: never run against an installed system or host root.
set -eu
root=${1:-}
case "$root" in ''|/|//) echo 'Refusing host root or missing stage' >&2; exit 2;; /*) ;; *) exit 2;; esac
root=$(cd "$root" && pwd -P)
[ "$root" != / ] || { echo 'Refusing host root' >&2; exit 2; }
[ ! -L "$root/etc" ] && [ -d "$root/etc" ] || exit 2
[ "$(cat "$root/etc/tr100/image-tag")" = tr100-pure-linux-20261111 ] || exit 2
for p in group gshadow passwd shadow; do
    [ -f "$root/etc/$p" ] && [ ! -L "$root/etc/$p" ] || exit 2
done
# Validate conflicts and the expected sandbox identity before changing any file.
awk -F: '$1=="inet" && $3!=3003 {bad=1} $3==3003 && $1!="inet" {bad=1} END {exit bad}' "$root/etc/group"
awk -F: '$1=="_apt" {n++; if($3!=42) bad=1} END {exit bad || n!=1}' "$root/etc/passwd"
awk -F: '$1=="systemd-timesync" {n++; if($3!=996) bad=1} END {exit bad || n>1}' "$root/etc/passwd"
awk -F: '$1=="root" {n++; if($2 !~ /^[!*]/) bad=1} END {exit bad || n!=1}' "$root/etc/shadow"
for p in usr usr/sbin; do
    [ -d "$root/$p" ] && [ ! -L "$root/$p" ] || { echo 'Unsafe policy parent directory' >&2; exit 2; }
done
# This exact 18-byte cache-only policy blocks all package service management.
# Preserve symlinks and every custom policy, including a differently terminated file.
policy=$root/usr/sbin/policy-rc.d
if [ -f "$policy" ] && [ ! -L "$policy" ] && printf '#!/bin/sh\nexit 101' | cmp -s - "$policy"; then
    rm -f -- "$policy"
fi
tmp=
trap '[ -z "$tmp" ] || rm -f -- "$tmp"' EXIT HUP INT TERM
rewrite() {
    file=$1 program=$2
    tmp=$(mktemp "$root/etc/.tr100-identity.XXXXXX")
    cp -p -- "$root/etc/$file" "$tmp"
    awk -F: -v OFS=: "$program" "$root/etc/$file" >"$tmp"
    mv -f -- "$tmp" "$root/etc/$file"
    tmp=
}
rewrite group '$1=="inet" {found=1; n=split($4,a,","); have=0; for(i=1;i<=n;i++) if(a[i]=="_apt") have=1; if(!have) $4=($4=="" ? "_apt" : $4 ",_apt")} {print} END {if(!found) print "inet:x:3003:_apt"}'
rewrite gshadow '$1=="inet" {found=1; n=split($4,a,","); have=0; for(i=1;i<=n;i++) if(a[i]=="_apt") have=1; if(!have) $4=($4=="" ? "_apt" : $4 ",_apt")} {print} END {if(!found) print "inet:!::_apt"}'
# APT and the old-kernel timesyncd fallback both discard supplementary groups.
# Preserve each UID; only change the primary GID. An absent timesync user is untouched.
rewrite passwd '$1=="_apt" || $1=="systemd-timesync" {$4=3003} {print}'
for p in var var/lib var/lib/dbus; do
    [ ! -L "$root/$p" ] || { echo 'Unsafe stage directory symlink' >&2; exit 2; }
    [ -d "$root/$p" ] || mkdir -p "$root/$p"
done
for p in hostname hosts machine-id; do
    rm -f -- "$root/etc/$p"
done
printf 'tr100\n' >"$root/etc/hostname"
printf '127.0.0.1 localhost\n127.0.1.1 tr100\n::1 localhost ip6-localhost ip6-loopback\n' >"$root/etc/hosts"
: >"$root/etc/machine-id"
chmod 0644 "$root/etc/hostname" "$root/etc/hosts"
chmod 0444 "$root/etc/machine-id"
rm -f -- "$root/var/lib/dbus/machine-id"
ln -s ../../../etc/machine-id "$root/var/lib/dbus/machine-id"
echo 'Fresh stage identity: tr100; empty machine-id; network service primary GIDs3003; cached root password lock preserved.'
