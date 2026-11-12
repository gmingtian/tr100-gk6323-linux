# 下载、个性化和安装 ARM64 Release

适用对象是**已核对原厂 loader、ATF 和八分区布局的 TR100/GK6323**。其他硬件批次未验证。保留能打断启动的 3.3 V TTL 串口、原厂备份和恢复方法；安装会覆盖 p3 与 p8，不能保留旧 p8 的文件。工具不写 loader、ATF、分区表或 p2 环境分区。不要将整盘镜像、RAM bundle 或裸 `Image` 当成 p3。

公共 Release 是可复用模板：MAC 为模板地址，账户锁定，没有 SSH 主机密钥和登录凭据。下载后必须在本地配置本机原厂 MAC 和自己的 SSH 公钥/密码，再安装私人镜像。此过程只重新打包 DTB 和 rootfs，**不需要重新编译内核**。不要发布私人镜像、密码文件或设备备份。

## 1. 在 Linux 电脑取得同一 Release

需要 Python 3.11+、`git`、`device-tree-compiler`、`e2fsprogs`、`gzip`、`tar`；本地 rootfs 操作需要 sudo。也可按 [ROOTFS.md](ROOTFS.md) 使用 Linux Docker worker。电脑的磁盘至少留出 rootfs staging、7.24 GiB 稀疏 ext4 和压缩副本的空间。

```bash
git clone https://github.com/gmingtian/tr100-gk6323-linux.git
cd tr100-gk6323-linux
python3 arm64/tools/download_release.py --tag YOUR_RELEASE_TAG --output "$PWD/downloads"
```

将 `YOUR_RELEASE_TAG` 替换为 [Releases](https://github.com/gmingtian/tr100-gk6323-linux/releases) 的实际 tag；源码也切换到该 tag。下载器验证清单中的每个文件大小和 SHA256，失败即停止。`release-manifest.json` 是公开 Release 的完整性清单；它不能验证本地个性化后的新文件。保留它和下载的通用文件。

主要资产：`Image`、`source.dts`、内核 `manifest.json`、`installed-p3.bin`、`candidate-ram-bundle.bin`、`tr100-bookworm-arm64-rootfs.tar.gz` 和 `tr100-bookworm-arm64-p8.ext4.gz`。通用 ext4.gz 是可审查的编译产物；下面从通用 tar 生成配置了自己身份的私人 ext4。编译来源和可复现性边界见 [PACKAGING.md](PACKAGING.md)、[ROOTFS.md](ROOTFS.md) 和 [README.md](README.md)。

## 2. 本地个性化

`FACTORY_MAC` 必须来自**这台目标设备**的原厂配置/备份；不能使用电脑网卡 MAC、模板 MAC 或随意生成的地址。内核 DTB 与 rootfs 必须填同一个值。

```bash
FACTORY_MAC='YOUR:OWN:FACTORY:MAC:HERE'
EPOCH=$(python3 -c 'import json;print(json.load(open("downloads/manifest.json"))["source_date_epoch"])')
python3 arm64/build/pack.py \
  --image "$PWD/downloads/Image" --dts "$PWD/downloads/source.dts" \
  --source-date-epoch "$EPOCH" --mac "$FACTORY_MAC" \
  --output "$PWD/private-kernel"

WORK="$PWD/private-work"
mkdir -p "$WORK/stage/private-root"
sudo tar --numeric-owner -xpf downloads/tr100-bookworm-arm64-rootfs.tar.gz \
  -C "$WORK/stage/private-root"
sudo python3 arm64/rootfs/build.py personalize \
  --root "$WORK/stage/private-root" --mac "$FACTORY_MAC" \
  --authorized-key "$HOME/.ssh/id_ed25519.pub"
sudo python3 arm64/rootfs/build.py audit --root "$WORK/stage/private-root" --personalized
sudo python3 arm64/rootfs/build.py image --root "$WORK/stage/private-root" \
  --output "$WORK/private-rootfs.ext4" --size-mib 7414 --personalized
gzip -n -c "$WORK/private-rootfs.ext4" > "$WORK/private-rootfs.ext4.gz"
```

公钥路径替换为自己的文件；如需 HDMI/串口密码，向 `personalize` 另传权限为 600 的 `--password-file`，见 [ROOTFS.md](ROOTFS.md)。仅配置公钥不会产生默认本地密码。主机密钥在目标机首次启动时生成。

创建仅用于此次私人安装的散列清单（不是要 source 的 shell 文件）：

```bash
mkdir "$PWD/private-transfer"
cp private-kernel/installed-p3.bin "$WORK/private-rootfs.ext4.gz" \
  arm64/tools/flash-from-ram.sh "$PWD/private-transfer/"
python3 - <<'PY'
import hashlib
from pathlib import Path
out = Path('private-transfer')
def sha(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()
raw = Path('private-work/private-rootfs.ext4')
assert raw.stat().st_size == 7774142464
(out / 'flash-manifest.txt').write_text(
    'kernel_sha256=' + sha(out / 'installed-p3.bin') + '\n'
    'rootfs_gz_sha256=' + sha(out / 'private-rootfs.ext4.gz') + '\n'
    'rootfs_ext4_sha256=' + sha(raw) + '\n'
    'rootfs_ext4_bytes=7774142464\n')
PY
bash arm64/tools/flash-from-ram.sh --check-inputs \
  private-transfer/installed-p3.bin private-transfer/private-rootfs.ext4.gz \
  private-transfer/flash-manifest.txt
```

检查完整解压流需要顺序读过数 GiB 数据，属正常行为；不用将 7.24 GiB 原始 ext4 放进目标机 RAM。清单同时固定压缩文件、完整解压文件和 p3 的 SHA256，工具另检查解压大小和 ext4 UUID。

## 3. 先启动私人 candidate 到 RAM

用 TTL 打断原厂 loader。先备份并记录原厂 MAC、环境、分区几何和 ATF CRC；仓库不附带厂商 loader/ATF。以下 EL2 指令只在已经核对的原厂 loader 上验证过：

```text
md.l 0x00c8ed80 0xa
```

逐字核对输出：

```text
00c8ed80: e58d40b4 e1cd2cf0 e3a03000 e3a02802
00c8ed90: e1cd2cf8 e30033c5 e58d00b0 ea00001b
00c8eda0: e3590020 1a00001a
```

**不一致就停止，不能在其他 loader 上盲写这个地址。** 完全一致才作 RAM 修改：

```text
mw.l 0x00c8ed94 0xe30033c9
setenv verify yes
```

这只修改当次启动 RAM 中的 EL1h→EL2h 指令，不改写原厂 loader；掉电后失效。KVM 需要正确的 EL2 启动，不能把此修改省略后仍声称 KVM 可用。

在电脑为 `private-kernel/candidate-ram-bundle.bin` 提供 TFTP，配置 loader 的本机 `ipaddr` 和电脑 `serverip`。严格按 `private-kernel/boot-commands.txt` 的 **RAM** 部分逐条执行：TFTP 到 `0x40000000`、比对 bundle CRC、复制 DTB、比对 DTB CRC、**重新从 eMMC 载入原厂 ATF**、比对 ATF CRC，最后才 `bootm`。DTB 长度和 CRC 取此次私人 `manifest.json`，不要照抄其他构建的值。

每次启动都必须在 DTB 复制后、`bootm` 前执行：

```text
mmc read 0 0x08020000 0xc000 0x1000
crc32 0x08020000 0x200000
```

已测试那台设备的原厂 2 MiB ATF CRC 是 `96266b1b`；新设备须与自己的经核实原厂备份一致，不能把示例值作为其他批次的授权。`crc32` 只显示结果，**不会阻止下一条命令**；任何 CRC/读取结果不一致都停止。该 loader 不支持常见的 `if`、`&&`、`run` 或 `crc32 -v` 自动保护语法。

RAM candidate 应显示 `TR100_ARM64_RAM_PROBE_SHELL_NO_STORAGE_MOUNTED`。默认 RAM init 不挂载 p8、不启动 SSH，并把 eMMC 设为只读。安装操作通过 TTL shell 进行。

## 4. 经 HTTP 下载到 RAM 并检查安装

在电脑的 `private-transfer` 目录启动只供局域网临时使用的 HTTP 服务：

```bash
python3 -m http.server 8000 --bind 0.0.0.0 --directory private-transfer
```

在目标 TTL RAM shell 配置同网段、未被占用的静态 IP（以下 TR100 为 `192.168.1.20/24`、电脑为 `192.168.1.10`；替换为自己的局域网配置，以 `/bin/busybox ip link` 的实际网卡名为准）。精简 RAM initramfs 没有 DHCP lease hook，不能仅运行 `udhcpc` 就假定 IP 和路由已配置；这里直接使用静态地址访问电脑：

```sh
/bin/busybox ip link set eth0 up
/bin/busybox ip addr add 192.168.1.20/24 dev eth0
/bin/busybox mkdir /run/install
cd /run/install
/bin/busybox wget http://192.168.1.10:8000/installed-p3.bin
/bin/busybox wget http://192.168.1.10:8000/private-rootfs.ext4.gz
/bin/busybox wget http://192.168.1.10:8000/flash-manifest.txt
/bin/busybox wget http://192.168.1.10:8000/flash-from-ram.sh
/bin/busybox sha256sum installed-p3.bin private-rootfs.ext4.gz flash-manifest.txt flash-from-ram.sh
```

将输出与电脑上的 `sha256sum private-transfer/*` 独立核对，尤其是脚本和私人清单；HTTP 不提供身份认证。压缩 rootfs、p3 和备份必须能同时放进 `/run` 的 RAM；下载不完整或 RAM 不足就停止，不能改在 p8 上运行或把流直接写入分区。

运行 `/bin/busybox ip addr` 记下 TR100 的地址。在电脑另一个终端启动只接收这台 TR100、仅允许固定 4 MiB p2 和 12 MiB p3 的备份接收器（替换两端 IP，输出目录必须不存在）：

```bash
python3 arm64/tools/receive-backups.py \
  --bind 192.168.1.10 --client 192.168.1.20 --port 8001 \
  --output "$PWD/original-backups"
```

目标 RAM 中先以 `/bin/busybox wget --help` 确认支持 `--post-file`，再执行：

```sh
/bin/busybox sh /run/install/flash-from-ram.sh \
  /run/install/installed-p3.bin /run/install/private-rootfs.ext4.gz \
  /run/install/flash-manifest.txt /run/original-backup \
  http://192.168.1.10:8001 ERASE-P3-P8-PERSONALIZED
```

脚本首先验证所有输入、完整解压大小/散列和 rootfs UUID，再要求 RAM 根、无 installed token、无块文件系统挂载/holders/swap，以及精确的 512B sector 布局：

| 区域 | 起始 sector | sectors | 写入 |
| --- | ---: | ---: | --- |
| 整盘 | 0 | 15269888 | 不写 |
| p2 环境 | 8192 | 8192 | 只读备份 |
| p3 内核 | 16384 | 24576 | 完整 12 MiB |
| p8 rootfs | 86016 | 15183872 | 完整 7414 MiB |

原始 p2/p3 备份留在 `/run/original-backup`，各自与设备重读散列比较。脚本将两个备份自动 POST 到电脑，检查接收器返回的 SHA256，再暂停显示本地 `SHA256SUMS`；必须与电脑端显示的两个 SHA256 逐项核对，再在 TTL 输入 `BACKUPS-COPIED`。备份在 RAM，重启即丢失；它们不包含被覆盖的旧 p8 数据，旧 p8 的数据备份须在本节之前完成。接收器不接受其他文件名、路径穿越、其他客户端或覆盖现有备份，收到两个文件后退出。将电脑显示的散列和串口日志一并保存；上传失败或未核对就不要确认。

确认后先写 p8、同步并完整重读 SHA256，再写 p3、同步并完整重读 SHA256；成功标志为 `P3_P8_FULL_READBACK_VERIFIED`。退出时恢复存储只读。此阶段保持稳定供电，不要挂载任何 eMMC 分区；失败后停留 RAM shell，检查串口记录，不能继续启动未经验证的镜像。脚本从不改分区大小、不自动重启、不保存 loader 环境。

## 5. 从安装的 p3/p8 启动

重新进入 loader，重新核对相同 loader 指令签名，应用相同的 RAM EL2 修改并 `setenv verify yes`。按私人 `boot-commands.txt` 的 **INSTALLED** 部分逐条运行并核对 CRC：

- 从 p3 sector `0x4000` 读 `0x5000` sectors（10 MiB）到 `0x40000000`。
- 比对这 10 MiB 的 CRC；从 `0x40800000` 复制 DTB 到 `0x06000000`，长度取 manifest（已测试构建为 `0x3491`），再比对 DTB CRC。
- 重新载入并核对原厂 ATF，然后 `bootm 0x40000000 - 0x06000000`。

installed DTB 中的 `tr100.arm64.root=installed` 让 initramfs 在 p8 几何和 UUID `a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230` 全部匹配后才挂载并切换根目录。首次启动会生成 SSH 主机密钥；使用自己配置的密钥登录 DHCP 分配的地址，不能使用默认凭据。

只在人工试启动成功、备份已导出且确认 loader 完全匹配后，才考虑持久化环境。若手动设置 `bootcmd`，必须用**单引号**保护整串命令，包含 `setenv verify yes`、本版本的 RAM EL2 修改、p3 读取、DTB 复制、最后重新载入原厂 ATF 和 `bootm`；该 loader 只可用分号串联，不能加入不支持的条件语法。`saveenv` 会改写 p2，不属于上述 p3/p8 安装脚本；先保留原始环境和恢复路径。不能用一条示例 bootcmd 为未知 loader 自动启用 EL2。

检查 `uname -a`、`dmesg`、`/dev/kvm`、四核 KVM probe、HDMI 和 Wi-Fi 的实际行为；驱动编入配置不等于外围设备已经实测。当前源码配置包含光驱/USB 等支持，但物理 USB 光驱、摄像头、音频及其他外设仍未逐项验证，蓝牙没有完成驱动适配。
