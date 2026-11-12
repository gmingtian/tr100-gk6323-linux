# Portable ARM64 image packaging

For verified Release downloads, local MAC/credential personalization, TTL RAM
boot prerequisites, and guarded p3/p8 installation, see [QUICKSTART.md](QUICKSTART.md).

`build/pack.py` runs on a Linux build machine with Python 3 and `dtc`; it has no
board connection and performs no device writes. Use the raw ARM64 `Image` built
with this repository's initramfs and zero `text_offset`. An ELF `vmlinux`, gzip
file, or existing uImage is not an input substitute. The `Image` header's memory
extent, including BSS, must fit below the DTB destination.

From the repository root, package a generic download:

```sh
python3 arm64/build/pack.py \
  --image /path/to/kernel-output/arch/arm64/boot/Image \
  --dts arm64/tr100.dts \
  --dtc /path/to/kernel-output/scripts/dtc/dtc \
  --source-date-epoch 1735689600 \
  --unconfigured \
  --output /path/to/new-release-directory
```

`--dtc` defaults to `dtc` on `PATH`. Paths with spaces are supported; quote them
as usual. The output must be new or empty. `SOURCE_DATE_EPOCH` can replace the
timestamp argument. Use the timestamp recorded by the source build, with the
same inputs and compiler, to reproduce the package. No current clock time,
build-host path, source filename, or gzip filesystem timestamp enters a binary.
The gzip and uImage timestamps both use the specified epoch. Exact compression
also depends on the Python/zlib version.

## Personalize on another computer

Generic outputs have `requires_personalization: true`, the explicit template
MAC `02:00:00:00:00:01`, and no boot command sequences. They are distribution
templates, including the full p3 layout; personalize before booting or installing
them. Download the package and repository, then run:

```sh
python3 arm64/build/pack.py \
  --image /path/to/download/Image \
  --dts /path/to/download/source.dts \
  --dtc /path/to/dtc \
  --source-date-epoch 1735689600 \
  --mac "$FACTORY_MAC" \
  --output /path/to/new-personalized-directory
```

Set `FACTORY_MAC` to the address from the target device's original configuration
or verified backup. The packager never reads an identity from the build host.
Zero, multicast, broadcast, malformed, and template addresses are rejected.
The source DTS must retain its template identity; generated `candidate.dts` and
`installed.dts` are diagnostic outputs, not replacement templates. Keep
personalized outputs private: their DTBs, generated DTS files, and manifest
contain the target MAC.

## Output files and boot layout

| File | Purpose |
| --- | --- |
| `Image`, `source.dts` | Exact packaging inputs, usable for repackaging |
| `candidate.uImage` | Legacy Linux/AArch64 kernel, gzip payload, load/entry `0x02000000` |
| `candidate.dts`, `candidate.dtb` | RAM trial configuration without installed-root token |
| `candidate-ram-bundle.bin` | RAM-only uImage plus DTB aligned to 64 KiB; never a partition image |
| `installed.dts`, `installed.dtb` | Exactly one `tr100.arm64.root=installed` boot token |
| `installed-p3.bin` | Full 12 MiB kernel partition image; DTB starts at byte 8 MiB |
| `manifest.json` | Input/tool SHA-256, artifact size/SHA-256/CRC32, layout and boot sequences |
| `boot-commands.txt` | Commands for personalized outputs; personalization notice otherwise |

The RAM bundle stages at `0x40000000`, entirely inside the DTS's reserved 16 MiB
scratch range. Copy its DTB from the manifest's `ram.dtb_source_address` to
`0x06000000`. Installed boot reads the first 10 MiB of p3 at sector `0x4000`,
with the installed DTB at `0x40800000`; the unused partition tail stays zero.
The packager validates both DTBs by parsing the compiled FDT, including the MAC,
installed-root token, `mmz=ddr,0,0,44M`, and scratch/ATF reservations.

For personalized packages, `manifest.json` records the ordered kernel/DTB load
sequences for RAM and installed boot. These sequences do not configure EL2 or
save a loader environment. Before a KVM boot, follow the loader-version and
instruction-signature checks in [QUICKSTART.md](QUICKSTART.md), apply the verified
RAM-only EL2 adjustment, and set `verify=yes`. Run commands individually and compare the
reported bundle/read-window and DTB CRC32 with the manifest's corresponding
values before continuing. `crc32` prints a checksum; it does not stop the next
command on a mismatch. Do not paste a semicolon-separated sequence blindly.

Every sequence ends by reloading the target's original ATF from eMMC, after
copying the DTB and immediately before `bootm`:

```text
mmc read 0 0x08020000 0xc000 0x1000
crc32 0x08020000 0x200000
bootm 0x40000000 - 0x06000000
```

ATF is device firmware and is not included in a release. Compare its CRC against
the verified original backup; the manifest intentionally has no invented ATF
checksum. The installed sequence assumes p3 was separately installed and
verified, and that the installed root filesystem was prepared using the
repository's installation instructions. This utility supplies no flashing,
partitioning, root-filesystem installation, `saveenv`, or `mmc write` operation.

## Verification

Run the binary integration tests with a real `dtc`:

```sh
DTC=/path/to/dtc python3 -m unittest discover -s arm64/tests -p test_pack.py
```

Tests decompress and compare the payload, independently verify both uImage
CRCs and header fields, ask `dtc` to parse both generated DTBs, check partition
padding and the 10 MiB read checksum, compare repeated outputs byte for byte,
and reject invalid Image headers, decompression overlap, oversized compressed
kernels/DTBs, unsafe identities, and missing reservations. Without `dtc`, only
the validation tests run and the integration tests are explicitly skipped.
