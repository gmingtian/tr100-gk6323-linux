# 用发布输入离线重建

这里重建同一套内核、驱动、固件和无 Docker 的 Debian Bookworm 系统。先按 [QUICKSTART.md](QUICKSTART.md) 下载并验证同一 Release 的全部资产，源码也使用该 Release 对应版本。所有命令从仓库根目录执行，构建目录必须是**不含空格的新目录**。

主机先安装 Python 3.11+、GNU make、宿主 GCC、GCC 11 AArch64 交叉工具链、binutils、Git、bison、flex、Perl、bc、OpenSSL/ELF 开发头文件、kmod、tar、gzip 和 Docker。Debian/Ubuntu 对应交叉编译包通常为 `gcc-11-aarch64-linux-gnu`。发布构建实际使用的 GCC 完整版本记录在 `build-manifest.json`。x86 主机还需 ARM64 binfmt/QEMU；Docker Desktop 通常已经提供。

首次安装工具和构建下面的 Docker 工具镜像需要联网；提前完成后，源码、固件和目标系统包的构建均可断网执行。工具链和工具镜像本身不包含在输入包里。

```bash
docker build --platform linux/arm64 -t tr100-rootfs-tools:bookworm-arm64 \
  -f arm64/rootfs/Dockerfile arm64/rootfs
docker run --rm --platform linux/arm64 debian:bookworm-slim uname -m
# 上一条必须输出 aarch64。
```

## 解包并校验输入

`ASSETS` 指向下载器生成的资产目录。预备源码包已经应用全部内核、SDK 和无线补丁，**不要再运行 prepare.py 或重复应用补丁**。

```bash
ASSETS=$(realpath downloads)
WORK=/tmp/tr100-rebuild
mkdir -p "$WORK"
tar -xzf "$ASSETS/tr100-arm64-prepared-sources.tar.gz" -C "$WORK"
tar -xzf "$ASSETS/tr100-arm64-build-inputs.tar.gz" -C "$WORK"
python3 - "$WORK/build-inputs" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
for name, expected in json.loads((root / 'input-manifest.json').read_text()).items():
    path = root / name
    assert path.stat().st_size == expected['bytes'], name
    assert hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == expected['sha256'], name
print('All build inputs verified')
PY
```

解包后应有 `$WORK/sources/source-manifest.json`、`build-inputs/kernel/busybox-static-arm64`、按 SHA256 命名的固件缓存，以及 `build-inputs/rootfs/` 中的公开基础 tar 和完整 142 个 `.deb` 闭包。`debian-provenance/` 保留 Debian 签名源信息和包散列；全部已安装版本见发布的 `rootfs-packages.lock`。

## 构建内核、全部模块和固件

原厂板载固件从已校验的公共 `firmware.tar.gz` 中提取，构建器还会按源码中的大小/SHA256 锁再次校验这两份文件。无需设备备份、设备登录或研究目录。

```bash
mkdir -p "$WORK/factory"
tar -xzf "$ASSETS/firmware.tar.gz" -C "$WORK/factory" \
  usr/lib/firmware/unisoc/wcnmodem.bin \
  usr/lib/firmware/unisoc/wifi_56630001_3ant.ini
EPOCH=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_date_epoch"])' \
  "$ASSETS/build-manifest.json")
# 本次发布记录的内核 SOURCE_DATE_EPOCH 为 1729123200。
python3 arm64/build/build.py --work-dir "$WORK" \
  --cross-compile aarch64-linux-gnu- --cc aarch64-linux-gnu-gcc-11 \
  --busybox "$WORK/build-inputs/kernel/busybox-static-arm64" \
  --factory-firmware "$WORK/factory/usr/lib/firmware/unisoc" \
  --firmware-cache "$WORK/build-inputs/kernel/firmware-cache" \
  --source-date-epoch "$EPOCH" --offline
python3 arm64/build/pack.py --image "$WORK/output/Image" \
  --dts arm64/tr100.dts --dtc "$WORK/output/dtc" \
  --source-date-epoch "$EPOCH" --unconfigured --output "$WORK/packaged"
```

成功输出在 `$WORK/output/`，封装后的通用 p3 和 RAM bundle 在 `$WORK/packaged/`。新系统必须使用这次构建产生的 `modules.tar.gz` 和 `firmware.tar.gz`，不要混入其他内核的模块。

## 从原始 Debian 输入构建系统

Docker 原生 volume 保存 staging root，避免 Docker Desktop 的 host bind mount 丢失 Unix 拥有者。`/work` 只用于输入和输出。以下 volume 名称也应是新的；已存在的 staging root 会被拒绝覆盖。

```bash
ROOTFS_WORK="$WORK/rootfs-files"
mkdir -p "$ROOTFS_WORK"
cp "$WORK/build-inputs/rootfs/debian-bookworm-arm64-rootfs.tar" "$ROOTFS_WORK/"
cp "$WORK/build-inputs/rootfs/debian-complete-packages.tar" "$ROOTFS_WORK/"
cp "$WORK/output/modules.tar.gz" "$WORK/output/firmware.tar.gz" "$ROOTFS_WORK/"
export TR100_ROOTFS_VOLUME=tr100-offline-rebuild
docker volume create "$TR100_ROOTFS_VOLUME"
sha() { sha256sum "$1" | cut -d' ' -f1; }
arm64/rootfs/docker-run.sh "$ROOTFS_WORK" prepare --root /build/stage/root \
  --rootfs-tar /work/debian-bookworm-arm64-rootfs.tar \
  --rootfs-sha256 "$(sha "$ROOTFS_WORK/debian-bookworm-arm64-rootfs.tar")" \
  --packages-tar /work/debian-complete-packages.tar \
  --packages-sha256 "$(sha "$ROOTFS_WORK/debian-complete-packages.tar")" \
  --modules-tar /work/modules.tar.gz \
  --modules-sha256 "$(sha "$ROOTFS_WORK/modules.tar.gz")" \
  --firmware-tar /work/firmware.tar.gz \
  --firmware-sha256 "$(sha "$ROOTFS_WORK/firmware.tar.gz")"
arm64/rootfs/docker-run.sh "$ROOTFS_WORK" provision --root /build/stage/root --offline
arm64/rootfs/docker-run.sh "$ROOTFS_WORK" audit --root /build/stage/root
arm64/rootfs/docker-run.sh "$ROOTFS_WORK" archive --root /build/stage/root \
  --output /work/tr100-bookworm-arm64-rootfs.tar.gz
arm64/rootfs/docker-run.sh "$ROOTFS_WORK" image --root /build/stage/root \
  --output /work/tr100-bookworm-arm64-p8.ext4 --size-mib 7414
gzip -n -k "$ROOTFS_WORK/tr100-bookworm-arm64-p8.ext4"
```

`--offline` 不获取网络缺包，默认不安装 Docker。完整 ARM64/ARMHF 闭包已合并在一个包归档里。ext4 为 7,774,142,464 字节，UUID 与当前 p8 启动保护一致；生成镜像不会写任何设备。通用产物锁定账户、清空身份信息，安装前按 [QUICKSTART.md](QUICKSTART.md) 在本地恢复、配置自己的 MAC 和凭据，再生成私人 p3/p8。

这里复用精确源代码和二进制输入；不同 GCC 补丁版本、宿主工具、Python/zlib 或 ext4 工具可能改变字节摘要。内核时间戳取构建清单；rootfs tar 使用构建器单独固定的归档时间，ext4 还包含创建时间等元数据。比较新旧 `build-manifest.json`、`packages.lock` 和模块 ABI，不能把逻辑上同一构建误称为任意电脑上的逐字节复现。
