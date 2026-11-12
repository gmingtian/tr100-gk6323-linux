# Debian Bookworm ARM64 rootfs

使用完整发布输入在新电脑上重建内核和系统，见 [离线重建步骤](REBUILD.md)。

`rootfs/build.py` 从干净的公开 Debian ARM64 基础系统构建 rootfs，不读取、克隆或打包正在运行的 TR100。产物包含 systemd PID 1、SSH、BusyBox DHCP、HDMI `openvt + fbterm`、字体、传感器自动加载及真实 ARMHF 动态运行库。Docker 默认不安装，只有 `provision --with-docker` 才包含原生 ARM64 Docker 29.9.3。硬件驱动须另行从本仓库 SDK/内核构建后提供。

默认发布状态：所有账户密码锁定，SSH 主机密钥不存在，`machine-id` 空白，无 random seed、DHCP 租约、Docker 数据、shell history、工厂 MAC 或登录凭据。必须在本地副本设置自己的 MAC 和凭据，再生成私人安装镜像。通用 rootfs 不启用 SSH 登录；首次启动密钥由目标设备生成。

## 两种构建环境

推荐 Linux Docker ARM64 worker。x86 Linux 需要 Docker 已启用 ARM64 binfmt/QEMU；先用 `docker run --rm --platform linux/arm64 debian:bookworm-slim uname -m` 确认输出 `aarch64`。Docker Desktop 通常自带模拟。也可在原生 ARM64 Linux 上直接 `sudo python3 arm64/rootfs/build.py ...`。

推荐给 staging root 使用 Docker 原生 named volume，避免 Docker Desktop 的 host bind mount 不能保留 Unix 拥有者而导致 dpkg `Permission denied`。下面所有 Docker 示例先执行：

```bash
export TR100_ROOTFS_VOLUME=tr100-rootfs-build
docker volume create "$TR100_ROOTFS_VOLUME"
```

原生文件系统挂到 `/build`，构建 root 位于 `/build/stage/root`；输入和输出仍通过 `/work` 访问宿主工作目录。省略该变量时只挂载 `/work`，适用于支持完整 Unix 权限的 Linux bind mount；此时自行将 root 参数改成 `/work/stage/root`。

容器工具镜像定义在 `rootfs/Dockerfile`，固定官方 Debian 多架构镜像索引摘要。`rootfs/docker-run.sh WORKDIR ...` 只读挂载源码到 `/src`，将指定构建目录挂到 `/work`。`provision` 需要 mount/PID namespace 权限，wrapper 仅为该步骤增加 `SYS_ADMIN`、`MKNOD` capability 并关闭该容器的 seccomp/AppArmor 过滤；不挂载宿主设备、Docker socket 或其他宿主目录。

直接在 x86 Linux 构建时，安装 `python3 debootstrap debian-archive-keyring qemu-user-static binfmt-support e2fsprogs util-linux openssh-client openssl`，启用 `qemu-aarch64` binfmt，再给 `provision` 传 `--qemu /usr/bin/qemu-aarch64-static`。单独复制 QEMU 而不注册 binfmt 不能运行 chroot 中的子程序。所有 staging 路径必须是独立的子目录；脚本拒绝 `/`、用户家目录、符号链接路径、未标记目录及仍挂载子文件系统的目录。

## 取得干净的公开基础系统

可从固定的 Debian 官方 OCI 镜像导出基础 tar；以下摘要是本项目构建所用公开 Debian Bookworm 索引，指定 ARM64 平台。导出的 tar 的散列会随 Docker 导出元数据变化，因此需要记录实际 tar SHA256，公开来源由 OCI 摘要固定。

```bash
mkdir -p "$PWD/rootfs-work/stage"
WORK="$PWD/rootfs-work"
BASE='debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc'
docker pull --platform linux/arm64 "$BASE"
CONTAINER=$(docker create --platform linux/arm64 "$BASE")
docker export "$CONTAINER" --output "$WORK/debian-bookworm-arm64-rootfs.tar"
docker rm "$CONTAINER"
sha256sum "$WORK/debian-bookworm-arm64-rootfs.tar"
```

`prepare` 验证提供的 SHA256 后才创建 staging root。只接受干净的 Bookworm tar，不接受设备快照。基础 tar 的 `dev/` 条目被丢弃，其他路径中的设备节点和路径穿越被拒绝；构建时只在私有 namespace 创建临时 `/dev` 和 `/proc`。

```bash
ROOTFS_SHA=$(sha256sum "$WORK/debian-bookworm-arm64-rootfs.tar" | cut -d' ' -f1)
arm64/rootfs/docker-run.sh "$WORK" prepare \
  --root /build/stage/root \
  --rootfs-tar /work/debian-bookworm-arm64-rootfs.tar \
  --rootfs-sha256 "$ROOTFS_SHA"
```

另一个公开基础入口是 debootstrap，无需先导出 OCI：

```bash
arm64/rootfs/docker-run.sh "$WORK" bootstrap --root /build/stage/root \
  --snapshot https://snapshot.debian.org/archive/debian/20261110T000000Z/
```

debootstrap 校验 Debian 归档签名，使用 ARM64 foreign 第一阶段；`provision` 在 ARM64 worker/QEMU 中完成第二阶段。工具环境需要 Debian 当前有效归档 keyring。

## Provision：在线与离线

在 `prepare` 时可以同时传以下输入，每个都必须带单独 SHA256：

| 参数 | 内容 |
| --- | --- |
| `--packages-tar /work/arm64-packages.tar --packages-sha256 SHA` | ARM64/architecture-all `.deb` 包，可有目录层级；也可把完整 ARMHF 闭包合并放入此 archive |
| `--armhf-tar /work/armhf-packages.tar --armhf-sha256 SHA` | ARMHF `.deb` 及依赖 |
| `--docker-tar /work/docker-29.9.3-aarch64.tgz --docker-sha256 SHA` | 官方 static archive，包含 `docker/dockerd` 等文件 |
| `--firmware-tar /work/firmware.tar.gz --firmware-sha256 SHA` | 配套 firmware 及许可证，使用 `usr/lib/firmware`（兼容 Debian usrmerge） |
| `--modules-tar /work/hardware-modules.tar --modules-sha256 SHA` | 本项目编译的 `lib/modules/5.10.165_gk6323-tr100-arm64/...` 等文件 |

硬件模块归档的来源必须与当前内核和 SDK 配套。模块源码、构建方式见主 ARM64 构建文档；不需要把研究目录或设备上的文件当作公共基础输入。仓库内 DHCP 和 `hdmi/bin`、`hdmi/systemd` 的唯一 HDMI 脚本来源会覆盖模块归档和 rootfs overlay 中的旧版本配置，保留已验证的 framebuffer 模式和启动顺序。

```bash
arm64/rootfs/docker-run.sh "$WORK" provision --root /build/stage/root
arm64/rootfs/docker-run.sh "$WORK" sanitize --root /build/stage/root
arm64/rootfs/docker-run.sh "$WORK" audit --root /build/stage/root
```

在线 provisioning 从固定 Debian snapshot 安装 `rootfs/packages.txt` 的软件包；本地 `.deb` 优先作为显式输入。APT 仍校验归档签名和包散列，仅关闭 snapshot 的过期日期检查。只有启用 `--with-docker` 且未提供 Docker archive 时，才从 [Docker 官方 ARM64 static archive](https://download.docker.com/linux/static/stable/aarch64/docker-29.9.3.tgz) 下载，并校验源码内固定 SHA256。构建完成后运行时 APT 配置切换为腾讯镜像，时区为 Asia/Shanghai，NTP 为阿里云和中国池。

当前发布产物采用完整离线 Debian Bookworm 包闭包构建；相应输入 tar 的 SHA256、解析出的全部包版本和签名源信息随发布保留。在线 snapshot 服务不可达时可直接复用这些已验证输入，无需克隆设备。

`provision --offline` 禁止从网络获取缺包，需要完整、相互兼容的 ARM64 + ARMHF `.deb` 闭包；只有同时指定 `--with-docker` 才需要 Docker archive；缺包会失败，不会将半成品标为成功。它通过无可达外部代理的 APT 处理本地包，不使用会破坏本地包安装的 `--no-download`。完整包版本输出到 `/etc/tr100/packages.lock`，可选 Docker 二进制摘要输出到 `/etc/tr100/docker.lock`，归档输入摘要在 `/etc/tr100/build-inputs.json`。若要严格复用某次包版本，请保存这些清单和原始 `.deb` 输入；固定 snapshot 和源码并不等于不同版本 debootstrap、Docker 导出及 ext4 工具能生成逐字节相同的文件。

直接由 ARM64 构建 worker 执行内部脚本时，需要在 **staging chroot** 内挂载临时 `/proc` 和 `/dev`，然后执行 `TR100_ROOTFS_BUILD=1 TR100_OFFLINE=0 TR100_WITH_DOCKER=0 chroot ROOT /bin/bash /usr/local/libexec/tr100-provision-root`。宿主入口仅在 provisioning 期间将 worker DNS 内容写入 staging 的普通 resolver 文件，退出时清除。脚本校验 build marker、64 位 ARM64 dpkg 架构，并比较 `/` 与 `/proc/1/root` 的 inode，拒绝在 worker 正在运行的根目录执行。正常使用 wrapper 可自动完成这些步骤并清理 mounts。

## 发布通用 rootfs

```bash
arm64/rootfs/docker-run.sh "$WORK" archive --root /build/stage/root \
  --output /work/tr100-bookworm-arm64-rootfs.tar.gz
arm64/rootfs/docker-run.sh "$WORK" image --root /build/stage/root \
  --output /work/tr100-bookworm-arm64-rootfs.ext4 --size-mib 7414
```

两者都先检查身份清理和 provisioning 成功标记。tar 保留文件拥有者/权限，固定归档时间并排序；ext4 用 `mke2fs -d` 从目录直接生成，不挂 loop 设备。ext4 关闭新工具可能默认启用、而旧内核不支持的 `orphan_file`、`metadata_csum_seed`。镜像是稀疏文件，用 `gzip` 或 `zstd` 压缩后分发。

默认文件系统 UUID 为 `a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230`，与当前 initramfs 的 p8/UUID 启动保护一致。7414 MiB 只适用于已验证的同分区尺寸；安装前必须检查目标分区容量。UUID 是启动契约，不是设备身份；MAC 和凭据才是每台设备本地输入。改变 `prepare/bootstrap --uuid` 还必须同步 initramfs、显示模块脚本和打包配置的 UUID gate；单改 rootfs 不足以启动。生成 ext4 不会写入任何真实分区。

## 本地个性化后再安装

保留通用产物，复制或从通用 tar 解包一个新的私人 staging root（保留所有文件拥有者和权限），然后运行：

```bash
ROOTFS_SHA=$(sha256sum "$WORK/tr100-bookworm-arm64-rootfs.tar.gz" | cut -d' ' -f1)
# 与发布清单的 SHA256 比较后，将通用包恢复到新的私人 staging。
arm64/rootfs/docker-run.sh "$WORK" restore --root /build/stage/private-root \
  --archive /work/tr100-bookworm-arm64-rootfs.tar.gz --sha256 "$ROOTFS_SHA"
# restore 保留构建来源、权限和成功标记，不会重新配置或个性化。
# 密码文件位于构建工作目录，权限必须为 600；不要提交它。
# 可以只提供 SSH 公钥，也可同时配置本地 HDMI/串口密码。
arm64/rootfs/docker-run.sh "$WORK" personalize --root /build/stage/private-root \
  --mac 'YOUR:OWN:FACTORY:MAC:HERE' \
  --authorized-key /work/my-key.pub \
  --password-file /work/root-password.txt
arm64/rootfs/docker-run.sh "$WORK" audit --root /build/stage/private-root --personalized
arm64/rootfs/docker-run.sh "$WORK" image --root /build/stage/private-root \
  --output /work/private-tr100-rootfs.ext4 --size-mib 7414 --personalized
```

将 MAC 替换为本机原厂非零 unicast MAC，与启动镜像打包的 `--mac` 保持一致。脚本用 stdin 将密码交给 `openssl passwd -6`，不将密码放入进程参数或记录到清单。只用公钥时，SSH 禁用密码登录，HDMI/串口没有默认密码。发布前重新 `sanitize` 会移除个人 MAC、公钥及密码散列并锁定账户；不要公开私人镜像。

systemd 直接作为最终 PID 1；本 rootfs 不替换主启动 initramfs。ARMHF 运行库和内核 `CONFIG_COMPAT_32BIT_TIME` 两者都必须存在；在目标系统实际运行 `tests/compat-probe-armhf.c` 编译的动态程序，检查旧 time32 系统调用，不能用 QEMU 用户态执行结果代替目标内核验证。HDMI 模式、传感器和 DHCP 仍需要目标硬件启动验证；选择 Docker 的私人构建还需要验证 Docker 容器。

## 本地检查

```bash
python3 -m unittest discover -s arm64/tests -p 'test_rootfs*.py'
bash -n arm64/rootfs/{chroot-run,provision-root,docker-run}.sh
```

测试真实运行 CLI，覆盖宿主根目录保护、未标记目录拒绝、散列不匹配、tar 路径穿越、身份文件符号链接、发布前身份清理、个性化 MAC/凭据和归档发布保护。完整 provisioning 另需 ARM64 worker、网络或完整离线输入，以及 Linux root/mount 权限。
