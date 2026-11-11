# TR100 / GK6323V100C ARM64 适配

本目录保存 2026-11-11 实机适配的增量源代码、最终内核配置及验证程序。目标是原生 AArch64 Linux 5.10.165、Debian Bookworm arm64 与 Docker arm64，保留 ARMv7 应用兼容、HDMI RGB565 文字控制台和四个显示后台线程的空闲等待修复。CPU 保持原厂 1.2 GHz，未部署超频驱动。蓝牙未作驱动操作。

## 源码基线和补丁顺序

源码提交及仓库见 [原生 Docker 适配记录](../docs/TR100-native-docker.md#源码来源)。沿用同一 OpenHarmony 5.10 基础内核、Goke vendor/平台补丁和 SDK，不需要更换原厂 loader 或 ATF。

`patches/kernel-arm64.patch` 是相对本机已经完成的 ARM32 5.10 平台源码树的**增量**，不是对未经 Goke 平台补丁处理的纯净 Linux 树直接应用的补丁。该基线已启用 securec 和原来的平台修复。补丁增加 ARM64 平台入口、早期 ATAGS/eMMC 调谐参数导入、PDM 预留、ION/CMA/显示所需接口，以及 ARM64 DMA 缓存同步修复。新增加的源文件包含在补丁中。

显示 SDK 先应用现有 [MMZ 修复](../hdmi/patches/mmz-vm-mmap-for-native-modules.patch) 与 [后台等待修复](../hdmi/patches/idle-background-waits.patch)，再应用 `patches/display-arm64.patch`。后者切换 SDK 架构、修复内核接口和 PQ shadow buffer 指针截断。编译时先 common，再通过其 Module.symvers 编译 pdm/pq/vo/gfbg/tde/hdmi。

最终 `kernel.config` 来自已实机启动的构建。使用 GCC 11 AArch64 交叉工具链；`CONFIG_INITRAMFS_SOURCE` 是本地构建路径，复现时需要覆盖为自己的 initramfs 目录。`init` 需配套静态 AArch64 BusyBox 以及由 `tests/probe64.S` 链接得到的探针 `/bin/probe64`，并创建 dev/proc/sys/run/newroot 等目录。此目录不包含完整工具链、厂商源码或可直接刷入的镜像。

关键配置包括 COMPAT、COMPAT_32BIT_TIME、TUN、IPv4/IPv6 TPROXY/socket/mark、多路由表、nftables、namespaces/cgroups、overlayfs、veth/bridge、USB HID、ION/CMA/FB。`BASE_FULL=y`、`BASE_SMALL=0` 避免精简内核的 PID 数量限制导致 Debian systemd-sysctl 失败。

## 已解决的 ARM64 平台问题

- 从官方引导器的有界 ATAGS 导入每次启动的 eMMC sample phase/DLL，避免读盘 CRC 错误。
- 在伙伴系统初始化前预留厂商 PDM 参数，禁止旧接口误释放已管理内存；保留参数只需约 520 KiB。
- 只保留一次 SDK CMA heap 注册，图形 44 MiB、通用 CMA 4 MiB。
- ION 新分配原始页面的空 device 缓存同步改用 ARM64 的物理页同步路径；初始化 page pool 的 cached 标志。
- PQ sharpen shadow buffer 地址保持完整 uintptr_t，避免模块加载时访问截断后的低 32 位地址。
- initramfs 在切根前检查目标真实 systemd 文件，避免绝对 `/sbin/init` 软链接在 RAM 根中解析失败。
- 四个 SDK 后台线程保持 TASK_IDLE 等待，空闲时不把 load 固定抬到 4。

## 温度

`temperature/` 提供匹配 GK6323 的 hwmon 模块。读取 PMC 采样和 OTP 工厂 trim，不烧写 OTP；启动等待 100 ms，并逐项拒绝未填满的采样窗口。温度单位为毫摄氏度：

```sh
cat /sys/class/hwmon/hwmon*/name
cat /sys/class/hwmon/hwmon*/temp1_input
```

数学回归验证：

```sh
cc -Wall -Wextra -Werror arm64/temperature/test-temp-math.c -o /tmp/tr100-temp-math
/tmp/tr100-temp-math
```

## 验证程序

`tests/capability-probe.c` 实际创建 TUN 并设置 IPv4/IPv6 transparent socket；`compat-probe-armhf.c` 必须编译成动态 ARMHF ELF 并使用真实 32 位运行库执行，且直接验证旧 clock_gettime32/clock_nanosleep32 系统调用，防止简单输出测试遗漏老程序计时兼容问题；`tproxy-flow-probe.c` 配合 `test-tproxy-flow.sh` 在两个临时网络命名空间内验证 IPv4/IPv6 的 iptables-legacy 和 nftables 真实 UDP 收发。程序固定使用 `/root/tproxy-flow-probe-aarch64`，测试完成删除命名空间，不写现有网卡或防火墙规则。

## 安装布局与恢复

本次保留原分区布局和 p8 UUID：p3 为 12 MiB，legacy AArch64 uImage 位于开头，正式 DTB 位于 p3 的 8 MiB 偏移。读取前 10 MiB 至 RAM 0x40000000，复制 DTB 到 0x06000000，并每次从 p5 重新读取原厂 ATF 到 0x08020000。

`tr100.dts` 默认用于 RAM 救援；公开版本将实机 MAC 替换为 `02:00:00:00:00:01` 示例值，构建前必须填回目标机器的原厂 MAC，不能让多台设备共用该地址。正式 DTB 在 chosen.bootargs 增加 `tr100.arm64.root=installed`；initramfs 先校验磁盘大小、p8 几何与 UUID，再挂载 p8、验证镜像标签并交接 systemd。其余情况保留 RAM shell。

根目录切换在 RAM 中进行：保留旧根到回退目录，再把已验证的 ARM64 根提升到 p8 顶层。切换前保存临时停留 loader 的 bootcmd；完整 p3 写入和读回、正式 eMMC 启动验证后，才保存正常启动命令。完整旧内核和原环境备份保留在主机，未上传仓库。

原厂 loader 只有分号命令序列，不支持 if、&&、run 或 crc32 -v。自动启动打印内核、DTB、ATF CRC 供诊断；bootm 校验 uImage 头和数据，CRC 输出本身不构成条件门禁。安装时分别核对完整 SHA256 和各项 CRC，不改写 loader/ATF。

这些固定地址与 UUID 只对应实测设备，其他硬件批次需重新核验。物理断电启动与 USB 键盘人工操作另行记录，不能用软件重启或驱动加载代替。

## 本次实机结果（2026-11-11）

正式安装内核 `5.10.165_gk6323-tr100-arm64`，构建 `#22`，Debian Bookworm arm64、systemd 252.39、Docker 29.9.3 arm64。已从 eMMC 完成正常软件重启自动启动；根目录为 p8 顶层，systemd 无失败服务。原 root 访问配置、SSH 主机密钥、原厂 MAC 保持，网卡 DHCP；时区 Asia/Shanghai、NTP 同步、腾讯 APT 源。

原生 Docker 容器运行及桥接 DNS、真实 ARMHF 动态程序、旧 time32 原始系统调用及 libc 计时、TUN、legacy/nft 双路径 IPv4/IPv6 TPROXY 实际收发均通过。HDMI 帧缓冲抓图可见登录文字，四个后台线程为 I，温度约 54–56°C。USB EHCI/OHCI/HID/evdev 已启用、控制器可见，但本次 ARM64 验收时未连接物理键盘，未把旧 ARM32 阶段的人工键盘确认当作新系统确认。尚未实测物理断电冷启动。

最终完整 p3（12 MiB）SHA256 为 `7158a349d4eda9d32929bc6fe866b672ae8ec039edbe8a342bea0d5039f6b3e6`；启动时前 10 MiB CRC32 为 `eb3eec9a`，DTB 为 `de83786b`，ATF 为 `96266b1b`。完整读回通过。p2 只有 bootcmd 值改变，环境 CRC 正确且 64 KiB 环境外字节不变；原 loader/ATF 哈希不变。
