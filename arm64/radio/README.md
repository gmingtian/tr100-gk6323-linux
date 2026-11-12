# Reproducing the radio bundle

`arm64/build/prepare.py` exports only the committed source objects locked in
`arm64/build/sources.json`: CoreELEC UWE5621 and four Realtek USB drivers
(8851BU, 8821CU, 88x2BU and 8812AU). It checks each USB source's GPL license
hash and applies the repository's TR100 native SDIO patch to the onboard driver.
No vendor driver source tarballs or precompiled modules are committed here.

A fresh machine needs Git, Python 3.11+, GNU make, GCC 11 AArch64 cross tools,
host GCC, bison, flex, perl, OpenSSL, kmod (`depmod` and `modinfo`), and the
usual Linux kernel build dependencies. Use an absolute work path without spaces.

```sh
python3 arm64/build/prepare.py --work-dir /tmp/tr100-build
python3 arm64/build/build.py --work-dir /tmp/tr100-build \
  --busybox /absolute/path/to/static-arm64-busybox \
  --factory-firmware /absolute/path/to/original-rom-firmware \
  --source-date-epoch 1729123200
```

Preparation fetches the exact full commits into the work directory's `downloads/`.
Optional `--kernel-repo`, `--vendor-repo`, `--sdk-repo`, `--onboard-repo` and
`--usb-repos` reuse committed Git objects on an offline machine. `--usb-repos`
contains repositories named as the four `usb_wifi[].name` entries in the lock.
Working tree edits in these repositories are ignored. The original SDK contains
binary-only components; the build exports the specific SDK paths needed for the
public display module build rather than claiming that the entire SDK is open.

The factory directory must contain `wcnmodem.bin` (837120 bytes, SHA256
`07157b90122c80b87ac72a72fd385dc4887392502cce8a82a5c0925d179c66b6`) and
`wifi_56630001_3ant.ini` as locked in `factory-firmware.json`. These are the
verified original TR100 ROM inputs. No verified public source or redistribution
license is known, so they are not included in this source repository. A clone
alone cannot reproduce the onboard runtime firmware: supply your own original
ROM files. Incorrect or missing files fail the build. No substitute is invented.

`arm64/usb-firmware/firmware-lock.json` pins the official linux-firmware commit,
regulatory database release, selected payloads, sizes, SHA256 hashes and licenses.
The downloaded detached regulatory signature is checked against the exact pinned
kernel certificate set. GoogleSource base64 transport is decoded before checking
payload hashes. The optional `--firmware-cache` selects a cache, and `--offline`
requires that every locked resource is already present and valid.

The build requires all six radio modules with the target kernel's vermagic.
`modules.tar.gz` contains them under `usr/lib/modules/<release>/extra` alongside
the kernel/display modules. `firmware.tar.gz` contains the official firmware,
factory firmware under `usr/lib/firmware/unisoc`, 8851BU power tables, licenses,
and provenance under `usr/share`. Archive ownership and timestamps are stable.
There are no top-level `lib` archive members, preserving merged `/usr` rootfs
symlinks. Preserve the license and source provenance files when distributing.
Hardware functionality beyond the tested USB adapters still requires testing.

Preparation and build publish their final directories only after success. Failed
runs clean their temporary output, retain reusable download caches, and return a
nonzero exit status. Build object trees can be reused after a failure. No command
installs on the build host or writes a board. `prepare.py` refuses a nonempty
source destination; use a fresh work directory to prepare again.
