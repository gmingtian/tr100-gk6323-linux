# 刷写与构建工具说明

完整操作顺序见 [刷入指南](QUICKSTART.md)，离线重新编译见 [重建说明](REBUILD.md)。以下工具针对已核对的 TR100 八分区布局；原厂烧录工具的整包格式尚未适配。

| 工具 | 在哪里运行 | 用途与输出 |
| --- | --- | --- |
| `tools/download_release.py` | Linux 电脑，Python 3.11+ | 下载 Release，逐文件检查大小及 SHA256 |
| `build/prepare.py` | Linux 构建电脑 | 按完整提交号取得源码并应用补丁，生成 `sources/` |
| `build/build.py` | Linux 构建电脑 | GCC 11 交叉编译内核、显示、无线和温度驱动，生成模块、固件及来源清单 |
| `build/pack.py` | Linux 电脑，Python 与 dtc | 填入目标 MAC，封装 RAM 镜像及完整 12 MiB p3 镜像 |
| `rootfs/build.py` | Linux root 或 ARM64 Docker worker | 准备/恢复干净 rootfs、配置身份、审计、导出 tar/ext4 |
| `tools/receive-backups.py` | 同局域网电脑 | 接收指定 TR100 上传的原始 p2/p3，返回 SHA256 |
| `tools/flash-from-ram.sh` | TR100 的 TTL RAM shell | 校验私人镜像、备份、写 p8/p3、完整读回并恢复只读 |
| `tests/kvm-real-probe.c` | 编译后在 TR100 运行 | 让真实 KVM 客体在四个物理 CPU 分别执行，检查 MMIO 返回值 |

## 下载与封装

从仓库根目录运行。每个 Python 工具的 `--help` 列出实际支持的参数。

```sh
python3 arm64/tools/download_release.py --tag latest --output downloads
python3 arm64/build/pack.py --help
python3 arm64/rootfs/build.py --help
```

下载器可重复指定 `--only 文件名`，只下载需要的资产。已有文件必须与发布清单完全一致，不会默默覆盖不匹配的文件。

`pack.py` 必须提供 `--image`、模板 `--dts`、新的 `--output` 目录、构建清单中的 `--source-date-epoch`，以及目标原厂 `--mac`。`--unconfigured` 只供产生公共模板。RAM bundle 不能当 p3 分区镜像写入；正式刷写使用个性化后的 `installed-p3.bin`。

`rootfs/build.py restore` 先核验发布 tar 的 SHA256，再还原新的 staging root。`personalize` 设置原厂 MAC 和 SSH 公钥/本地密码；`audit --personalized` 检查私人配置；`image --personalized` 生成私人 ext4。公开 rootfs 默认锁定账户，没有通用 root 密码。密码用权限为 600 的文件传入，不放到命令参数或发布清单中。

## 备份接收器

```sh
python3 arm64/tools/receive-backups.py \
  --bind 192.168.1.10 --client 192.168.1.20 --port 8001 \
  --output original-backups
```

IP 是示例，需替换为刷写电脑和目标盒子的实际静态地址。输出目录必须不存在。工具仅接收这个客户端的 `original-p2.bin`（4 MiB）和 `original-p3.bin`（12 MiB），拒绝其他名称、大小和覆盖请求。两份文件收到后退出，并打印校验值；它不备份 p8 的旧系统数据。

## RAM 刷写器

只读检查可在 Linux 电脑先运行，不接触设备：

```sh
bash arm64/tools/flash-from-ram.sh --check-inputs \
  private-kernel/installed-p3.bin private-rootfs.ext4.gz flash-manifest.txt
```

`flash-manifest.txt` 的生成方法见刷入指南。它记录私人 p3、压缩 rootfs、完整展开 rootfs 的 SHA256 及精确大小，不是可执行 shell 配置。校验会完整读取和展开约 7.24 GiB 的 rootfs，耗时随电脑性能变化。

真正写入必须在盒子的 RAM 维护环境，通过 TTL 执行：

```sh
/bin/busybox sh /run/install/flash-from-ram.sh \
  /run/install/installed-p3.bin /run/install/private-rootfs.ext4.gz \
  /run/install/flash-manifest.txt /run/original-backup \
  http://192.168.1.10:8001 ERASE-P3-P8-PERSONALIZED
```

脚本要求自身和输入均位于 `/run` 的 RAM，无块文件系统挂载或 swap，且磁盘/分区容量及 UUID 完全匹配。核对电脑收到的备份后，在 TTL 输入 `BACKUPS-COPIED` 才开始写入。成功标志是 `P3_P8_FULL_READBACK_VERIFIED`；没有成功标志就停留在 RAM 排查。

脚本会清空 p8、替换 p3；不更改 loader、ATF、分区表或 p2 环境，也不自动重启。EL2、ATF 每次重载以及最终启动环境的设置，必须按刷入指南另行核对。失败时的输入散列、串口记录和原始备份是恢复依据。
