# TR100 纯 Linux 整盘交付

这是绑定本机数码视讯 TR100 / GK6323V100C 的实验性 Linux 用户区镜像。用户态为 Armbian Bookworm armhf，内核沿用原厂 `3.18.24_gk6323v100c` 字节，只更换启动 initrd。它不是官方 TR100 通用板型支持、主线重编译内核或 HiTool Android 升级包。

完整镜像解压后恰为 7818182656B：前 42MiB 保留所需厂商引导固件、deviceinfo/MAC 和硬件参数，其中环境/p3 kernel 按纯 Linux 方案修改；其余 7774142464B 全部交给固定 p8 Linux root。旧 Android recovery/system/cache/private/securestore/userdata 区域不保留。镜像不包含 eMMC boot0/boot1/RPMB，也不是原机全部数据备份。

旧 800MiB p16 checkpoint 单独保留供父流程恢复参考，不能当作本布局最终交付。纯版包内不混入该旧 boot/root 镜像。

## 包内容

| 文件 | 用途 |
| --- | --- |
| `TR100-pure-linux.img.gz` | 实际迁移后读回的 42MiB prefix + canonical 7414MiB root，完整用户区 raw gzip |
| `boot.img` | pure v2 小 initrd + 原 kernel，9863168B，10MiB 读取窗口内 |
| `rootfs.ext4.gz` | canonical p8 root，解压恰 7774142464B |
| `bootargs.bin` | 4MiB 新环境，仅 active bootargs/bootcmd 两项变更 |
| `installation/probe-bootargs-NOT-FINAL.bin` | 数据阶段必须保留的 printenv/bootdelay3/newmap 三键 probe 环境 |
| `installation/factory-bootargs.bin` / `probe-environment-receipt.json` | 原 4MiB 环境与 probe 离线差异/CRC/摘要证据 |
| `maintenance/RAMONLY-part-000.bin` … `008.bin` / `RAMONLY-manifest.json` | 独立 RAM 维护资源，禁止刷入 eMMC；地址/CRC/SHA 见 manifest |
| `maintenance/scripts/` / `tools/tcp-file.cjs` | 父流程实际使用的 TFTP loader、RAM boot、被动串口捕获和固定文件 TCP 工具，依赖及用法见维护说明 |
| `scripts/flash-pure-from-ram.sh` | 已审 RAM 数据阶段脚本；只写 p8/p3，环境独立提交 |
| `scripts/check-environment-from-ram.sh` | 环境独立提交后的只读 p2 整区核验器 |
| `assembly-manifest.json` / `layout.json` | 整盘几何、分区保护与镜像摘要 |
| `package-manifest.json` / `SHA256SUMS` | 全文件摘要和打包器实际核验范围 |
| `runtime-evidence.json` / `evidence/` | 可选的父流程实测凭据；缺失时明确为 absent |

打包器只执行 PC 普通文件操作，不访问串口或设备、不生成 ZIP。它完整解压核验整盘 gzip、长度、全体/子段 SHA，再比对单独 boot/env 与整盘 prefix 字节一致，核验单独 root gzip 解压后的 exact raw SHA/UUID/旧内核 feature 白名单；所有输出复制后再重算摘要。

运行证据始终归属于父流程提供者。打包器不把自己未接设备写成“亲自实测”；提供 evidence 后也保留 `hardwareAccessPerformedByPackager=false`。软件 reboot 和物理断电重启分别记录，没有断电重启证据不能标为已测试。

## 普通文件组包接口

以下组包接口用于父流程源码工作区，不是设备安装操作：`tools/package-pure-firmware.cjs --inputs INPUTS.json --out NEW_DIRECTORY`。所有路径为父流程明确选定的本地普通文件；输出目录必须全新，不覆盖旧 checkpoint。模板在本源码目录 `package-inputs.template.json`，占位路径/hash 不能作为实际证据。

```json
{
  "assemblyDirectory": "C:/actual/whole-image-assembly",
  "originalPrefix": {"file": "C:/actual/original-prefix-262MiB.bin", "sha256": "ORIGINAL_262M_SHA256"},
  "boot": {"file": "C:/actual/pure-v2/boot.img"},
  "rootGzip": {"file": "C:/actual/rootfs.ext4.gz", "sha256": "GZIP_SHA256", "rawSHA256": "ROOT_RAW_SHA256"},
  "environment": {"file": "C:/actual/environment-candidate/bootargs.bin"},
  "evidence": [{"name": "first-boot.txt", "file": "C:/actual/log.txt", "sha256": "LOG_SHA256"}],
  "runtimeEvidence": null
}
```

`assemblyDirectory` 必须来自实际 prefix/root 的 `pure-linux-image.cjs assemble`，不是计划数据。boot 和 env 摘要分别固定为 pure v2 `c4e63e9a...22de7c9`、两键最终环境 `06ea9291...f498885`；probe 的 printenv/bootdelay3 环境会被拒绝。

可选 `runtimeEvidence` 是 `{"file":"...json","sha256":"..."}`。JSON 合同：`mode="pure-linux-emmc-boot"`、`result="passed"`、`kernelSHA256`、`rootSHA256`、`environmentSHA256` 与包一致；`observedAt` 为 UTC ISO；`physicalPowerCycleTested` 明确 true/false；`serialLog`、`runtimeLog` 引用 evidence 中已复制的简单文件名。若物理断电测试为 true，必须再给出已复制的 `powerCycleLog`，文件名和 SHA 都不能复用普通启动/运行日志。未提供时清楚记录 absent，不能从旧 800MiB 证据推导新版通过。

父流程只加入已脱敏的预检、实际写入/读回、环境提交/读回、默认启动、运行状态、canonical 构建/native fsck/superblock 等证据。不要加入密码明文、私钥或终端中含密码的原始命令；工具拒绝 evidence 中标准私钥头，但不能代替人工脱敏。

实际安装/恢复的边界见 `MIGRATION-DATA-PHASE.md` 和 `ENVIRONMENT-COMMIT.md`。任何部署动作必须由父流程按当次实机状态审核执行，文件包存在不表示可以把整盘镜像写到任意设备。

## 单机安装材料顺序

完整目标只有 `TR100-pure-linux.img.gz`。组件与下列维护资源用于在已验证 RAM 环境中分阶段安全安装，不是另一个 Android ROM。最终 Linux 从 p8 独占剩余用户区运行，所需厂商引导固件及硬件参数位于前 42MiB。

1. 使用单独 `maintenance/` RAMONLY 九片，按本包父流程实测的 TFTP/bootm 证据与 manifest 地址启动 full RAM 维护环境，检查 RAM 根、MMC 无挂载/交换及精确新 map。所有 RAMONLY 文件始终只加载内存。
2. 父流程独立核验并提交 `installation/probe-bootargs-NOT-FINAL.bin` 到 p2、完整读回 SHA `216e4422...6b2db13f`；它只把原环境的 bootdelay 改3、bootcmd 改 printenv、bootargs 改新 map，保留其他值/顺序/tail。先捕获软件重启到 printenv/fastboot CLI 的证据，再重新进入已验证 RAM 环境。原 `factory-bootargs.bin` 供差异核验/受控恢复参考，不能在数据阶段恢复旧 bootcmd。
3. 保持 probe 环境，上传 canonical boot/root gzip，执行数据脚本默认 `--check`；父流程另行审核显式 `--write`，完整 p8 读回、p3 prefix/零尾和所有保护区通过后才继续。
4. 单独提交包根目录的最终 `bootargs.bin`，其 SHA 为 `06ea9291...f498885`，再运行只读核验器并捕获完整读回。仅此最终环境会默认启动新 p3/p8；随后捕获默认启动与网络/SSH/系统运行证据。

具体环境写入和 TFTP/串口操作属于父流程受控步骤，记录在包内实际安装证据中；打包器不提供自动全流程烧写器。软件重启 probe、数据阶段、最终环境和物理断电启动分别保留证据，不能合并为未经观察的成功结论。

## 本次交付状态与历史记录

本机已由父流程完成大根分区/内核写入及完整读回、最终环境提交，并通过两次默认 eMMC 软件重启；运行凭据见 runtime-evidence.json 和 evidence/。工具作者与打包器自身未访问硬件的字段仅限定各自执行范围。未进行物理断电测试，不能把软件重启称为冷启动验证。

evidence/software-map-probe.json 中关于 subsequent exact original p2 restore 的 note 是探测时的早期计划记录，已被后续策略取代，不能作为安装指令。本次数据阶段一直保留已实测的 probe p2（printenv/bootdelay3，SHA216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f）；数据脚本只接受该值。大根/内核完整读回后才独立切换到最终环境 SHA06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885。
