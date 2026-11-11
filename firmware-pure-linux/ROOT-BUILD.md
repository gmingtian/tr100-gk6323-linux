# RAM-only large root file build

`tools/build-root-on-ram.sh` is intended for the already booted, verified full-CPIO RAM maintenance system. It never formats a block device, writes an eMMC partition, saves a boot environment or reboots. It refuses a block-backed `/`, a non-tmpfs `/run`, symlink inputs, input/tool paths outside `/run`, and pre-existing work directories. The PC source and tools must first be uploaded and independently verified by the parent. `--plan` validates arguments and prints an explicitly unverified plan; `--execute` performs the build only after the runtime guards pass.

Fixed source: `system.ext4.gz`, 144829793 bytes, SHA256 `f341812dbb2848e1316a60c8f612eb75368e218728c68f97fd3576c0f6ca6946`; raw 838860800 bytes, SHA256 `9b6a93e8caed7abb17a56c3d7e603934b5a37ac0e815a10e30d40671979fff90`. GNU coreutils `dd`, not BusyBox dd, writes a bounded sparse source file in `/run/tr100-pure-base`. Pigz decompression and pipefail must both succeed, a one-byte in-memory probe rejects overflow, and exact raw length/hash are checked before a read-only loop and `ro,noload` source mount.

A separately created tmpfs at `/mnt/tr100-pure-root-build` contains the only large root raw file. The script creates that ordinary sparse file exclusively, checks its filesystem and type again, then invokes mke2fs on the **file path**, never a loop/block node: 1897984 blocks of 4096 bytes, UUID `a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230`, label `TR100ROOT`, inode ratio 32768, inode size 256, reserved percent 0, journal 32 MiB, explicit legacy feature whitelist, nodiscard and fully initialized inode/journal tables. `mke2fs -d` reads only the RO canonical mount, not the running maintenance root or a Windows extraction.

After attaching the new ordinary file to an owned loop and mounting it RW, copy exactly the pure bootstrap and two identity markers from the parent-staged overlay. Preserve the canonical account/password/group, authorized-key, SSH, inet/adduser and network files byte-for-byte. Keep machine-id empty and all host keys absent. Write the supplied, validated UTC timestamp to `etc/fake-hwclock.data`. Restore journal access and default ACLs to owner rwx, owning group r-x, named group 4 r-x, mask r-x, other r-x; require ping `cap_net_raw=ep` to have survived `mke2fs -d`.

Unmount, detach the RW loop, require `e2fsck -f -n` success, reattach RO and inspect the same policies, three overlays and ACL/capabilities again. Only then release the source RO loop and remove the exact source raw file created by this invocation. This frees its approximately 350 MiB before hashing/compressing the target. OpenSSL computes raw SHA256; pigz uses `-p 4 -1`. A compressed reread must produce the exact raw byte count and SHA256 before the gzip is published. No second large raw is created.

Memory is explicitly gated with `/proc/meminfo`, `du` allocated bytes and `free`: initial MemAvailable at least 900 MiB, after source creation at least 550 MiB, after target population at least 200 MiB, after releasing the source and before compression at least 384 MiB. Source allocation must stay below 450 MiB and target allocation below 600 MiB. These are conservative abort gates, not guarantees against every kernel allocation failure. Fixed input gzip and the final gzip also occupy RAM; sparse logical length alone is not a memory measurement.

Cleanup unmounts/detaches only loops recorded by this invocation and only while sysfs still identifies their exact ordinary backing files. It does not erase evidence or unmount the output tmpfs, which would discard the files the parent needs to retrieve. On failure, partial output remains explicitly partial, with logs; restart requires parent-directed cleanup or a fresh RAM session. No cleanup touches an input gzip or another job's files.

Example argument shape (run `--plan` first; filenames are parent-provided staged inputs):

```text
bash build-root-on-ram.sh --plan --source-gz /run/system.ext4.gz --overlay /run/pure-overlay --build-utc '2026-11-11 03:00:00'
bash build-root-on-ram.sh --execute --source-gz /run/system.ext4.gz --overlay /run/pure-overlay --build-utc '2026-11-11 03:00:00'
```

Defaults for optional tool arguments are `/run/pure-tools/pigz/usr/bin/pigz`, `/run/pure-tools/acl/bin/setfacl` and `/run/pure-tools/acl/bin/getfacl`. Override with `--pigz`, `--setfacl`, `--getfacl` when the verified package layout differs. The script contains no package download or installation step and never prints shadow contents or authorized-key contents.
