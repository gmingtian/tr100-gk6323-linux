# Selected TR100 USB network firmware overlay

This directory is a download/reproduction workspace. Running its Python script
downloads into `cache/` and stages files under the local `rootfs/` directory.
It never installs on this computer, invokes a module command, changes Wi-Fi,
connects to the board, or writes a device.

```sh
python3 fetch_firmware.py
python3 fetch_firmware.py --offline --verify-only
python3 fetch_firmware.py --offline --archive
python3 -m unittest test_fetch.py
```

Python 3 and OpenSSL are required. Network downloads use HTTPS. A corrupt cache
entry is rejected rather than silently reused. `firmware-lock.json` pins every
source URL, byte count, SHA-256, output path, and applicable licence. It pins
linux-firmware tag `20241017` to commit
`22a6c7dcc1d90b6026c56e168aad2d812e3bf54b` in the official repository:
<https://gitlab.com/kernel-firmware/linux-firmware>.

The regulatory database is the signed kernel.org `2024.10.07` release:
<https://www.kernel.org/pub/software/network/wireless-regdb/>.
Both releases are intentionally fixed compatibility inputs. They are not a
claim to contain the newest firmware or current worldwide regulatory rules.

## Included drivers and files

| Driver | Paths relative to `/usr/lib/firmware` |
| --- | --- |
| RTL8152/RTL8153 | `rtl_nic/rtl8153a-2.fw`, `rtl8153a-3.fw`, `rtl8153a-4.fw`, `rtl8153b-2.fw` |
| RTL8XXXU | `rtlwifi/rtl8723aufw_A.bin`, `rtl8723aufw_B.bin`, `rtl8723aufw_B_NoBT.bin`, `rtl8192cufw_A.bin`, `rtl8192cufw_B.bin`, `rtl8192cufw_TMSC.bin`, `rtl8192eu_nic.bin`, `rtl8723bu_nic.bin` |
| R8188EU staging | `rtlwifi/rtl8188eufw.bin` |
| R8712U staging | `rtlwifi/rtl8712u.bin` |
| MT7601U | `mt7601u.bin` |
| MT76x0U | `mediatek/mt7610e.bin`, `mediatek/mt7610u.bin` |
| Vendor 5.10 MT76x2U | `mt7662.bin`, `mt7662_rom_patch.bin` |
| RT2800USB | `rt2870.bin` |
| ATH9K_HTC | `ath9k_htc/htc_7010-1.4.0.fw`, `ath9k_htc/htc_9271-1.4.0.fw` |
| CFG80211 | `regulatory.db`, `regulatory.db.p7s` |

Directory prefixes in the Realtek rows apply to each filename in that row.
The MT7601U and MT7662 root filenames are materialized as regular files from
the pinned upstream `mediatek/` payloads. They match this vendor kernel's
requests; modern `mt7662u*` firmware is not substituted. ASIX/AX88179, CDC
Ethernet/NCM, and RNDIS host need no external firmware from this selection.
Vendor-driver source power tables are added by the complete radio build.
`rtlwifi/rtl8723bu_bt.bin` is declared by a dormant Bluetooth branch in this
vendor driver but is absent from the pinned official firmware repository.
`enable_bluetooth` is never assigned in that source; ordinary Wi-Fi requests
`rtl8723bu_nic.bin`. The missing optional branch is recorded in the lock, with
no invented substitute or misleading Bluetooth filename alias.

## Regulatory signature verification

The PEM certificate set in `verification/trusted-regdb.pem` is derived from
the actual kernel tree's `net/wireless/certs/sforshee.hex` and `wens.hex`.
The lock records the SHA-256 of each original hex source, DER certificate,
and combined PEM file. Reproduction checks the combined PEM hash before
verifying the detached PKCS#7 signature with OpenSSL CMS.

The `-nointern` flag requires a signer from this exact pinned kernel
certificate set; `-CAfile` establishes that set as trusted. The signature
and detached database contents are verified. `-no_check_time` matches the
kernel's key-use model rather than applying web-certificate expiry policy.
No kernel signature verification setting is disabled. Keep
`CONFIG_CFG80211_REQUIRE_SIGNED_REGDB=y` and
`CONFIG_CFG80211_USE_KERNEL_REGDB_KEYS=y` in the final kernel configuration.
The script fails if signature verification fails.

## Archive and deployment boundary

`--archive` produces `tr100-usb-firmware-rootfs.tar.gz`, a deterministic rootfs
overlay containing only the selected `/usr/lib/firmware` files, applicable
licences/WHENCE, and provenance documentation. It includes no downloaded
upstream source archives, unrelated vendor firmware, build caches, modules,
private MAC addresses, or network credentials. File ownership is normalized
to root, modes to 0644, ordering is fixed, and timestamps use the locked epoch.

Preserve `usr/share/licenses/tr100-usb-firmware/` when distributing the selected
firmware. The matching licence for each file is recorded in the lock. These
firmware licences are separate from the kernel driver's licence. In particular,
the MediaTek licence excludes incorporating those payloads into Linux itself;
keep the firmware as normal root-filesystem files, with `CONFIG_EXTRA_FIRMWARE=""`.

The overlay is prepared for a separate, explicitly controlled rootfs deployment
step. Do not extract it into this build machine's `/`. Keeping these files on
the target's persistent root filesystem also avoids consuming the fixed 8 MiB
compressed p3 kernel budget. Driver inclusion, matching USB IDs, Wi-Fi userspace
configuration, and actual adapter operation require separate verification.
