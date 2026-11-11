# TR100 pure Linux 整盘用户区离线工具

本目录与旧 800MiB p16 checkpoint 独立。几何、保护范围和后续设备执行边界见 [DESIGN.md](DESIGN.md)，固定元数据见 [layout.json](layout.json)。单独准备的数据阶段迁移脚本与恢复限制见 [MIGRATION-DATA-PHASE.md](MIGRATION-DATA-PHASE.md)；工具作者未在设备执行，不使用或修改旧 flasher。

新环境两项改动生成/验证见 [ENVIRONMENT-COMMIT.md](ENVIRONMENT-COMMIT.md)。最终普通文件交付组包接口、完整镜像/单项镜像一致性与父流程实测证据合同见 [DELIVERY.md](DELIVERY.md)；组包器未运行真实最终输入，不创建 ZIP。

工具需要当前 PC 的 Node.js 22.15+（`node:zlib.crc32`）。仅接受普通非 symlink 文件。默认直接把前缀和 root 流式压缩为完整 `.img.gz`，不创建另一份 7.8GB raw；只需要保留 canonical root raw、原 262MiB 备份、实际 42MiB 前缀与输出 gzip。前缀最多占约 42MiB 缓冲，其余数据有界流式处理。

```powershell
node .\firmware-pure-linux\tools\pure-linux-image.cjs --help
node .\firmware-pure-linux\tools\pure-linux-image.cjs layout
node --test .\firmware-pure-linux\tools\tests\pure-linux-image.test.cjs
```

## 等待父流程提供的真实输入

| 输入 | 精确长度 | 校验来源 |
| --- | ---: | --- |
| 原始前 262MiB raw 备份 | 274726912B | 父流程设备/主机对比后的 SHA256 |
| 迁移并保存新环境后实读的前 42MiB raw | 44040192B | 父流程实读/设备对比 SHA256 |
| 新 canonical root raw | 7774142464B | native 构建及独立 raw SHA256 |
| 新审核 kernel.img 长度/hash | ≤10485760B | 新 pure initrd 候选 manifest 与独立核验 |

当前只用 fixture 测试工具，没有伪造上述迁移后输入或生成最终整盘镜像。新 root UUID 必须为 `a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230`，4KiB block count 必须为 1897984。root 内 tag 与新 initrd 的 p8 策略仍须 native/实际启动证据，工具元数据会明确标记没有自行证明它们。

## 流式组装

以下路径/hash 为父流程提供输入的格式示意；占位值不是验证证据，不替换会拒绝：

```powershell
node .\firmware-pure-linux\tools\pure-linux-image.cjs assemble `
  --original-prefix 'C:\path\original-prefix-262MiB.raw' `
  --original-prefix-sha256 ORIGINAL_262M_SHA256 `
  --prefix 'C:\path\actual-post-migration-prefix-42MiB.raw' `
  --prefix-sha256 ACTUAL_PREFIX_SHA256 `
  --root 'C:\path\canonical-pure-rootfs.raw' `
  --root-sha256 CANONICAL_ROOT_SHA256 `
  --kernel-bytes REVIEWED_KERNEL_LENGTH `
  --kernel-sha256 REVIEWED_KERNEL_SHA256 `
  --out '.\firmware-pure-linux\assembled-device-image'
```

输出目录必须不存在，父目录须先存在。实际先核验原备份和新前缀，再检查 root superblock。压缩期间重新计算每个输入段及整体 SHA；错误输入只能留下一个未发布目录，不会发布正确文件名的 gzip。已有目标或已有 `.partial` 不会被覆盖/删除；失败只清理由本次 `wx` 创建的 partial。最终发布通过同目录独占 hardlink 实现，当前 NTFS 主机支持此操作。

成功输出：

- `TR100-pure-linux.img.gz`：解压后恰为 **7818182656B**，42MiB 前缀紧接完整 7414MiB root，直到用户区最后一字节。
- `manifest.json`：输入绝对路径、长度/hash、保护切片、CRC 环境、新 map / bootcmd、kernel 原载荷、root superblock 及整盘 gzip/raw SHA。
- `layout.json`：固定八分区布局。
- `SHA256SUMS`：上述三项文件摘要。

组装后会自动完整流式解压核验 gzip CRC、逻辑长度、整盘 raw SHA、前缀与 root 子流 SHA。发布状态明确为未在设备测试，不能替代父流程的 native fsck、root 内标记/权限、RAM 新 map 与默认启动验证。

## 独立重读验证

```powershell
node .\firmware-pure-linux\tools\pure-linux-image.cjs verify `
  --image '.\firmware-pure-linux\assembled-device-image\TR100-pure-linux.img.gz' `
  --manifest '.\firmware-pure-linux\assembled-device-image\manifest.json' `
  --original-prefix 'C:\path\original-prefix-262MiB.raw' `
  --original-prefix-sha256 ORIGINAL_262M_SHA256
```

verify 会重新读原始备份、流式解压成两个固定逻辑区间、重算所有 hash，并从解压出的前缀重验保护区/环境/kernel，从 root 子流重验 superblock。超过或少于固定用户区长度、gzip CRC 损坏、段摘要不符、旧 UUID/map、错误 block count 或新特性位都会拒绝。

## 安装边界

前缀 p3 使用整个 12MiB 原 recovery 槽：新镜像不超过 10MiB 读取窗口，剩余槽字节必须清零。42MiB 之后完整重写 canonical root 的逻辑字节，不能按宿主 sparse extents 跳过零区域，否则旧 Android 数据可能残留。

保留 p1、deviceinfo、ATF、baseparam、pqparam 的厂商启动固件/硬件参数与设备身份。因此这是本机绑定的完整 Linux **用户区**镜像，不包含 eMMC boot0/boot1/RPMB，不宣称主线重编译内核、无厂商固件、全原机数据备份或跨设备通用适配。
