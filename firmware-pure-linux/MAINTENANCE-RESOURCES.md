# RAMONLY 维护资源

`maintenance/` 是与最终持久 OS 镜像分开的 full-CPIO RAM 维护资源。**九片 `RAMONLY-part-*.bin` 及其组合大 boot 镜像只能加载 RAM，禁止作为 kernel 分区镜像或完整 ROM 写入 eMMC。** 它们不受持久 kernel 的 10MiB 读取窗口约束，也不能用来替代包根目录的 9863168B `boot.img`。

源资源为父流程已验证的 `RAMONLY-bookworm-full-boot-v2`。九片每片最多 16MiB，manifest 列出各片长度、SHA256、CRC32 和地址；源码工具作者的 `not-tested-by-builder` 保持不改，父流程实际 RAM 启动证据另放在 `evidence/`。

内存源从 `0x40000000` 开始，九片按 `0x01000000` 步长排列；组合长度 143294464B，SHA256 `1c2f86b70791274437e643b98dcd4839d34be935de522dc9c036056b7a51c7c2`，CRC32 `971915fc`。压缩 initrd 目标为 `0x10000000`；原 kernel 实际 uImage 目标为 32MiB，ATF 为 `0x08020000..0x08220000`，加载布局见 manifest。设备 DDR/启动固件/安全状态必须符合本机实测条件，不猜测其他设备通用地址。

父流程通过实测 TFTP/bootm 日志复现 RAM 启动，维护用 map/网络/调试参数仅放在临时 RAM 启动环境中；最终持久 bootargs 仍只有 console、新八分区 map 和 loglevel0。先核验 full RAM、MMC 无挂载和准确几何，再进入 probe → 数据 → 最终环境的独立步骤，顺序见 `DELIVERY.md`。

组包器逐片校验 SHA/CRC/地址/长度，再按顺序重算九片整体 SHA/CRC，只复制这些已固定的普通文件，不读取任何设备、不写环境、不执行 RAM 启动。原始 4MiB `factory-bootargs.bin` 与三键 `probe-bootargs-NOT-FINAL.bin` 均在 `installation/` 中，原环境不是数据阶段可以恢复的默认状态。

## 实际控制脚本和依赖

`maintenance/scripts/` 包含父流程实际使用、按固定 SHA 复制的 `tftp-server.cjs`、`load-full-ramonly.ps1`、`boot-pure-maintenance.ps1`、`capture-pure-map-probe.ps1` 和 `capture-pure-emmc-boot.ps1`。它们未被改写成自动安装器：loader 只设置 volatile 网络参数、从 eMMC **读取**原 ATF、TFTP 到 RAM 并核验 CRC；boot 脚本只设置 volatile 维护 bootargs 后启动已经核验的 RAM 图像；两个 capture 脚本只接收串口。它们不执行 saveenv、mmc write 或 erase。

PC 依赖 Node.js（源码配套使用22.15+），Windows PowerShell/PowerShell 7 及可用的 `.NET System.IO.Ports`、USB UART 驱动、可独占的 **COM4 /115200 8N1**。loader/boot 会向 COM4 发送命令及 Ctrl-C，不能同时与父流程或另一串口终端占用。脚本不会创建/安装这些依赖或修改防火墙。

父流程已用的直连网络为 **PC192.168.5.253 / 盒子RAM192.168.5.240 /24**，PC TFTP UDP69。这些是维护会话参数，最终 OS 使用 DHCP。以下仅为包内脚本的调用形状，需在父流程已确认闲置 fastboot、网络与源镜像后单独执行；日志路径必须是新文件，不能覆盖包内证据：

```powershell
node .\maintenance\scripts\tftp-server.cjs 192.168.5.253 .\maintenance 192.168.5.240
# 在另一个PowerShell窗口，使用新建日志目录：
pwsh -File .\maintenance\scripts\load-full-ramonly.ps1 -Manifest .\maintenance\RAMONLY-manifest.json -LogFile NEW_LOAD_LOG.txt
pwsh -File .\maintenance\scripts\boot-pure-maintenance.ps1 -LogFile NEW_RAM_BOOT_LOG.txt
```

TFTP 服务只接受指定 peer；现有 CLI 同时允许接收固定 `factory-*.bin` 文件作为 PC 备份，RAM 加载器只发起读取 RAMONLY 片的 TFTP 请求。服务限时10分钟。需要严格只下载时可由父流程使用已提供模块的 `startTftp({host,root,allowedPeer,writeNames:[]})` 接口；不更改设备行为。

`capture-pure-map-probe.ps1 -LogFile NEW_PROBE_LOG.txt` 在父流程另行发起软件重启前先打开串口，仅捕获 newmap/printenv/bootdelay3/fastboot prompt；`capture-pure-emmc-boot.ps1 -LogFile NEW_DEFAULT_BOOT_LOG.txt` 被动捕获默认 p8 启动。捕获成功标记仍需结合 SSH/运行状态证据，不能替代完整验证。

包根 `tools/tcp-file.cjs` 保留父流程实际使用的单 peer 固定文件传输工具，放在这个位置使它的路径约束仍覆盖包根文件。调用为 `node tools/tcp-file.cjs send|receive HOST PORT PEER FILE [MAX_BYTES]`，PC 启动后由父流程在 RAM Linux 用 BusyBox nc 收/发，上传结束核对字节/SHA 后才进入 data flasher。没有远端文件名协议，也没有新增硬件写入脚本。
