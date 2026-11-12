# HiTool XML 烧录包

这是与本项目八分区布局匹配的 HiTool 导出入口。生成私人包后，烧写操作可以简化为：

1. 解压私人包到 NTFS/exFAT 的英文短路径。
2. 连接 TTL 和网线，在适配目标设备的 HiTool 中导入 `TR100-Linux.xml`。
3. 核对只勾选 `bootargs`、`kernel`、`rootfs`，确认三个 `.img` 文件已关联，再烧写。

`TR100-Linux.xml` 本身只是配置模板，不包含系统文件、设备身份或登录凭据。**需要先生成私人包，不能把通用 Release 镜像直接改名搭配模板烧写。** 若工具未自动找到文件，在三行中选择同目录对应文件。不要选择擦除整片/全盘，也不要勾选无文件的保护分区。镜像和配置已经离线校验；尚未用 HiTool 在实体设备烧写，工具对超过 4 GiB 文件的支持也须核实。

## 分区与文件

| 分区 | 起点 | 大小 | 默认操作 | 文件 |
| --- | ---: | ---: | --- | --- |
| fastboot | 0 MiB | 4 MiB | 不烧写 | 原件保留 |
| bootargs | 4 MiB | 4 MiB | 烧写 | `bootargs.img` |
| kernel | 8 MiB | 12 MiB | 烧写 | `kernel.img` |
| deviceinfo | 20 MiB | 4 MiB | 不烧写 | 原件保留 |
| atf | 24 MiB | 2 MiB | 不烧写 | 原件保留 |
| baseparam | 26 MiB | 8 MiB | 不烧写 | 原件保留 |
| pqparam | 34 MiB | 8 MiB | 不烧写 | 原件保留 |
| rootfs | 42 MiB | 7414 MiB | 烧写 | `rootfs.img` |

适用范围是已经验证的 **4 MiB loader / 4 MiB 环境分区**版本。部分安卓 ROM 使用 1 MiB loader、512 KiB 环境，ATF 和硬件参数位置也不同；这类设备会被生成器拒绝，不能直接套用 XML。Linux 分区来自启动参数，不是简单向整盘写 GPT/MBR。

## 为每台目标设备生成包

在 Linux 电脑运行；需要 Python 3.11+ 和 e2fsprogs 的 `debugfs`。先按 [刷入指南](../QUICKSTART.md) 生成同一 MAC 的私人 p3 和 ext4，并取得**这台目标设备自身**前 42 MiB 的原始备份与已独立核对的 SHA256。备份应来自可信的只读导出，不能用另一台机器的备份替代。

```sh
python3 arm64/tools/make_hitool_package.py \
  --prefix /path/to/target-prefix-42MiB.bin --prefix-sha256 PREFIX_SHA256 \
  --kernel /path/to/private-kernel/installed-p3.bin --kernel-sha256 KERNEL_SHA256 \
  --rootfs /path/to/private-rootfs.ext4 --rootfs-sha256 ROOTFS_SHA256 \
  --mac YOUR:OWN:FACTORY:MAC:HERE --output /path/to/new-private-hitool-package
```

源备份前 4 MiB 必须匹配已实测 loader，ATF 必须匹配已实测版本与位置，环境 CRC 正确且前七区位置完全一致。生成器还检查 deviceinfo、DTB、rootfs 的 MAC 一致性、内核头/负载 CRC、安装参数、rootfs 身份标记、ext4 大小和 UUID。

启动环境只替换 `bootargs`、`bootcmd`、`verify`，保留其他变量与 64 KiB 环境区之外的全部原始尾部。有效 CRC 覆盖的非活动填充可被 U-Boot 留下，生成时会规范化环境区的填充。新启动命令包含已验证的 EL2 RAM 调整、uImage 校验、DTB 装载和每次重新读取原厂 ATF；不改写 loader 指令本身。

输出目录包含一个 XML、三个 IMG、`package-manifest.json`、`SHA256SUMS` 和简短操作说明。`rootfs.img` 为 7,774,142,464 字节，不能放在 FAT32；压缩传输和解压前应留足空间。包包含目标 MAC、原始环境和自己的密码散列/公钥，属于私人文件，不上传公共仓库或分享给其他盒子。新设备需用自己的参数重新生成。

工具只处理普通文件，不访问串口、不写设备、不启动 HiTool。烧写会清空 p8 并替换 p2/p3；应保留原厂完整备份和可用 TTL 恢复通道。成功与否仍需以 HiTool 的写入/校验结果、实际重启及 KVM/HDMI/网络测试为准。
