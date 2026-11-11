set -eu
h() { v=$(/usr/bin/openssl dgst -sha256 "$1"); printf '%s\n' "${v##* }"; }
test -f /etc/tr100-ram-validation
test "$(uname -r)" = 3.18.24_gk6323v100c
awk '$3!~/^0:/ {bad=1} $5=="/" {ok=($3=="0:2")} END{exit(bad||!ok)}' /proc/self/mountinfo
test "$(awk 'END{print NR}' /proc/swaps)" = 1
test "$(cat /sys/class/block/mmcblk0/size)" = 15269888
test "$(cat /sys/class/block/mmcblk0p2/start)" = 8192
test "$(cat /sys/class/block/mmcblk0p2/size)" = 8192
test "$(cat /sys/class/block/mmcblk0p2/dev)" = 179:2
test "$(stat -c '%t:%T' /dev/mmcblk0p2)" = b3:2
test -b /dev/mmcblk0p2 && test ! -L /dev/mmcblk0p2
disk=$(readlink -f /sys/class/block/mmcblk0); part=$(readlink -f /sys/class/block/mmcblk0p2)
test "${part%/*}" = "$disk"; test "$(readlink -f /sys/dev/block/179:2)" = "$part"
test "$(cat /sys/class/block/mmcblk0p8/start)" = 86016
test "$(cat /sys/class/block/mmcblk0p8/size)" = 15183872
test "$(blkid -p -s UUID -o value /dev/mmcblk0p8)" = a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230
f=/run/tr100/pure-flash/bootargs.bin
test -f "$f" && test ! -L "$f" && test "$(stat -f -c %T "$f")" = tmpfs && test "$(stat -c %s "$f")" = 4194304
test "$(h "$f")" = 06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885
test "$(h /dev/mmcblk0p2)" = 216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f
v=$(dd if=/dev/mmcblk0p3 bs=512 count=19264 iflag=fullblock status=none | openssl dgst -sha256)
test "${v##* }" = c4e63e9a104d126685885b33db2c231f7ece5b5babc85f03531cc263722de7c9
printf 'FINAL_ENV_COMMIT_START verified_data_phase_complete\n'
/usr/bin/dd if="$f" of=/dev/mmcblk0p2 bs=1048576 count=4 iflag=fullblock conv=fsync status=none
test "$(h /dev/mmcblk0p2)" = 06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885
/usr/lib/tr100/busybox sh /run/tr100/pure-flash/check-environment-from-ram.sh --check 06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885
printf 'FINAL_ENV_COMMIT_AND_READBACK_COMPLETE no_reboot_yet\n'