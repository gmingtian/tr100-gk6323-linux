# TR100 原生 Docker 与 5.10 内核适配记录

2026-11-11，已在同一台 TR100 / GK6323V100C 上永久安装 `5.10.165_gk6323-tr100-docker`，保留 Bookworm armhf 用户态。一次无人干预的正常重启确认从 eMMC 自动加载内核，Docker 和 HDMI 服务自动启动。用户确认 HDMI 登录文字和 USB 键盘正常，尚未做物理断电启动验收。

本记录与仓库原 3.18 基础镜像流程分别对应两个已测试阶段。仓库不包含新固件、厂商 SDK、设备备份或通用内核刷写器。

## 源码来源

| 部分 | 仓库 | 实测版本 |
| --- | --- | --- |
| Linux 内核 | [openharmony/kernel_linux_5.10](https://gitcode.com/openharmony/kernel_linux_5.10) | `OpenHarmony-v5.1.0-Release`，commit `42aae9173d8375a01e4e7d59791cd87d9b43a5c0` |
| Goke 平台 | [OpenHarmony-ChipBoards/vendor_goke_gk6320](https://gitcode.com/OpenHarmony-ChipBoards/vendor_goke_gk6320) | `bc36efa42ea3bd632b4e24f4a4542c949d5e5da3` |
| Goke SDK | [OpenHarmony-ChipBoards/device_soc_goke_gk6320](https://gitcode.com/OpenHarmony-ChipBoards/device_soc_goke_gk6320) | `92f042bc66c836c4d3b840652c9050431a8e4e98` |
| 板级配置 | [OpenHarmony-ChipBoards/device_board_goke_gk6320](https://gitcode.com/OpenHarmony-ChipBoards/device_board_goke_gk6320) | commit 前缀 `e53f972` |

仓库名带 gk6320，配套适配中包含 GK6323 平台支持。内核依次应用 vendor 基础差异和 GK6323 平台补丁，配置入口为 `linux-5.10/arch/arm/configs/gk6323v100c_standard_defconfig`；最终编译版本为 5.10.165。编译器为 SDK 的 `arm-gcc7.5-linux-gnueabihf`，GCC 7.5.0。

内核构建还需启用已有的 `drivers/goke/securec/`，关闭 `OABI_COMPAT` 以启用 `SECCOMP_FILTER`，启用 ION system/CMA heaps，并补齐 namespaces、cgroup devices/memory/pids、veth、overlayfs 和 IPv4 netfilter 等 Docker 必需功能。Docker 29 的桥接过滤还使用匹配编译的 `iptable_raw.ko`（`CONFIG_IP_NF_RAW=m`）。这里只记录本次适配要点，不能将其当作完整可复现配置清单。

## Docker 与启动交接

实机安装官方 [Docker ARMv7 静态包 29.9.3](https://download.docker.com/linux/static/stable/armhf/docker-29.9.3.tgz)，包 SHA256：

```text
946aa2687200ed7e63cc2481c2cb4f4bf1aff9b88a1abc74dbf70050a361fd64
```

运行时使用 overlay2、cgroup v1、iptables-legacy；配置关闭 containerd snapshotter，Docker 服务使用 `/opt/tr100-docker`，加入 PATH，并设置 `Delegate=yes`。本机内核不启用 nft 后端。普通 Debian 根目录下容器正常 pivot_root，无需 `DOCKER_RAMDISK=1`。

原 initrd/根启动交接有严格内核身份检查，升级时必须一并适配，不能只替换 zImage。新 initrd 携带 5.10 的 USB 模块和固定 p8 bootstrap，并要求启动参数中各有且只有一个：

```text
systemd.unified_cgroup_hierarchy=0
systemd.legacy_systemd_cgroup_controller=1
```

新内核先经 RAM 启动验证，之后经设备所有者确认写入 p3、读回校验并保存启动参数。保留了原 loader、ATF、分区布局和 bootcmd，以及原内核/环境回滚备份。上述记录不授权其他设备直接套用分区地址或跳过身份、布局与备份核验。

## HDMI 与后台负载

详见 [HDMI 模块与控制台](../hdmi/README.md)。SDK common 模块应用 [MMZ vm_mmap 补丁](../hdmi/patches/mmz-vm-mmap-for-native-modules.patch)，修复外部模块引用未导出的 `do_mmap` 以及 mmap 锁重复获取问题。模块先编译 common，再以该 `Module.symvers` 编译显示部分；本机使用 SDK Linux 5.10 配置及 `GK_DRV_BUILDTYPE=m`。

显示模块加载后必须配置 RGB 视频通路再启动 TX，避免只有输出使能而 PHY 电源关闭。`tr100-display-modules` 和配套 systemd drop-in 实现了启动顺序与实际状态检查。HDMI 为 RGB/DVI 文字视频模式，未启用音频或 HDCP。

随后应用 [后台空闲等待补丁](../hdmi/patches/idle-background-waits.patch)，更新 `gk_common`、`gk_hdmi`、`gk_vou`、`gfbg` 四个模块。四个后台线程从 D 变为 I，空闲 load 从约 4.0 降至 0.05；保留等待周期、提前唤醒重试及事件条件。此次模块修复未再次改写内核或引导环境。

## 实机验收范围

- 四核、约 2 GiB 内存、eMMC、以太网、USB 键盘与 SSH 正常。
- Docker 原生容器 PID 1，overlay2、桥接/NAT、外网 ping 和容器 DNS 通过。
- 32 MiB memory limit 和 32 pids limit 读回正确；没有启用 swap limit、CPU CFS quota 或 blkio throttling。
- 正常软件重启后 Docker、显示模块、PHY 电源/输出和 RGB565 登录服务自动恢复。
- 驱动回归脚本修复前失败、修复后多次通过；用户确认最终重启后的文字与键盘正常。

仓库默认 `npm test` 为离线测试；目标机空闲等待检查使用 `sh hdmi/tests/check-driver-idle.sh`。这些检查与物理断电启动、任意 Docker 工作负载或其他 TR100 硬件批次的兼容性验收不能互相替代。
