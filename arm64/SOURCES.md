# 源码来源、版本与引用

本项目在上游 Linux/OpenHarmony 与 Goke 平台代码基础上适配 TR100；下表区分上游来源与本仓库新增工作。构建锁定值以 [sources.json](build/sources.json) 和固件锁文件为准，不以网页当前默认分支为准。

## 内核和平台

| 部分 | 上游仓库 | 锁定提交 |
| --- | --- | --- |
| Linux 5.10 / OpenHarmony | [kernel_linux_5.10](https://gitcode.com/openharmony/kernel_linux_5.10) | `42aae9173d8375a01e4e7d59791cd87d9b43a5c0` |
| Goke 平台补丁 | [vendor_goke_gk6320](https://gitcode.com/OpenHarmony-ChipBoards/vendor_goke_gk6320) | `bc36efa42ea3bd632b4e24f4a4542c949d5e5da3` |
| Goke SDK / 显示驱动 | [device_soc_goke_gk6320](https://gitcode.com/OpenHarmony-ChipBoards/device_soc_goke_gk6320) | `92f042bc66c836c4d3b840652c9050431a8e4e98` |

OpenHarmony 内核基线为 `OpenHarmony-v5.1.0-Release`。Goke 仓库虽以 GK6320 命名，配套平台补丁包含 GK6323 支持。当前目标内核版本为 5.10.165。具体补丁顺序见 [构建说明](build/README.md) 与构建产物 `source-manifest.json`。

本仓库增加或维护 ARM64 平台入口、早期 ATAGS/eMMC 调谐参数导入、PDM/CMA 与 DMA 适配、显示指针与空闲等待修复、板载 SDIO 初始化、温度接口、内核配置、构建/封装/刷写和验证工具。并不将这些改动描述为从零编写 Linux 内核。

原厂 loader 和 ATF 沿用设备原件；EL2 启动使用经过版本/指令核对的 RAM 修改，不提供改写后的厂商 loader。原厂固件和 SDK 的全部组件并非都具有公开源码；上游 SDK 中已有的非源码对象不等同于本项目可重新编译的源码。

## 无线驱动

| 芯片/驱动 | 上游 | 锁定提交 |
| --- | --- | --- |
| 板载 UWE5621 家族 / Marlin3E | [CoreELEC/uwe5631-aml](https://github.com/CoreELEC/uwe5631-aml) | `08165b5d56f46b569ee6461d7082ff795efafb2e` |
| 8851bu | [rtl8851bu](https://github.com/fofajardo/rtl8851bu) | `9e37e7a1101316a05d5daede91549ea779b64539` |
| 8821cu | [8821cu-20210916](https://github.com/morrownr/8821cu-20210916) | `bda65aac150d2cde0df9603206eec23a6f3b77c4` |
| 88x2bu | [88x2bu-20210702](https://github.com/morrownr/88x2bu-20210702) | `418d71cc00cd18b4a671f8c49ecce9b19cbfd3c9` |
| 88XXau | [rtl8812au](https://github.com/aircrack-ng/rtl8812au) | `734485506a30d6237c2deaad666a19f8ca5379f2` |

CoreELEC 上游描述的是面向 Amlogic 的 UWE5621 Wi-Fi/BT 驱动。本项目只构建经 TR100 适配的 Wi-Fi BSP 与 WLAN 部分；实际检测到芯片 ID `0x56630001`、Marlin3E 固件，不据仓库名推断模块丝印型号，也不宣称蓝牙已经可用。USB 驱动的许可证文件摘要随锁文件记录。

## 固件与用户态

- USB 无线固件来自 [linux-firmware](https://git.kernel.org/pub/scm/linux/kernel/git/firmware/linux-firmware.git/) 的锁定版本；国家/地区数据库来自 [wireless-regdb](https://git.kernel.org/pub/scm/linux/kernel/git/wens/wireless-regdb.git/)。逐文件 URL、SHA256、大小和许可证见 [firmware-lock.json](usb-firmware/firmware-lock.json)，签名校验与来源说明见 [固件文档](usb-firmware/README.md)。
- 板载无线固件和射频参数为原 TR100 ROM 输入，锁定文件及摘要见 [factory-firmware.json](radio/factory-firmware.json)。它们是二进制固件，不宣称其源代码已开放。
- 基础用户态为 [Debian Bookworm arm64](https://www.debian.org/releases/bookworm/)，另带真实 ARMHF 运行库。基础 OCI 摘要在 [Dockerfile](rootfs/Dockerfile)，构建使用的包版本、Debian 签名源信息和二进制输入摘要随 Release 提供。镜像不是 Armbian 官方板型发行版。
- 可选 Docker 运行时来自 [Docker 官方静态安装说明](https://docs.docker.com/engine/install/binaries/)，当前公开系统镜像默认不安装 Docker。

## 许可证、验证与引用方式

原上游版权和许可证继续适用，固件包保留对应许可证及来源信息。本项目没有替厂商 SDK、原厂固件或第三方代码重新授予许可证；仓库不通过统一标签把不同来源的内容声明成同一许可证。

引用本次适配时，可同时给出本仓库链接、使用的 Release/tag、`source-manifest.json` 与 `build-manifest.json`，再引用本页对应上游仓库和完整提交号。这样读者能区分 Linux/OpenHarmony/Goke 原有工作与本次 TR100 适配。

本机 ARM64、真实 EL2/KVM、HDMI、板载 Wi-Fi 扫描及低负载修复的结果见 [适配记录](README.md)。发布 rootfs 另通过包状态、模块 ABI、身份清理、ext4 检查和恢复后的 SSH 登录测试；该干净系统镜像尚未在第二台实体盒子上验证，其他批次及未接入的 USB 外设仍需实测。
