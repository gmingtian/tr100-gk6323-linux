# 重建通用包

先按 `../build/README.md` 和 `../ROOTFS.md` 重建公开内核/模块/通用系统，或校验已发布的干净 rootfs tar。不能从运行盒子的快照生成公共包。

以下命令在仓库根目录的 Linux 电脑执行，依赖 Docker（ARM64 原生或已注册的 qemu/binfmt）、Python 3.11+、debugfs、dtc。Docker 构建工具镜像由 `arm64/rootfs/docker-run.sh` 首次自动生成。WORK 必须是已有、专用的绝对路径；使用本机 Docker named volume，避免 Docker Desktop bind mount 丢失 root 权限。

```sh
# 将经校验的干净 rootfs tar 放入自己的 WORK 目录，SHA256 从原发布获取。
WORK=/absolute/path/to/universal-work
ROOT_TAR_SHA256=YOUR_VERIFIED_GENERIC_ROOTFS_SHA256
export TR100_ROOTFS_VOLUME=tr100-universal-build
arm64/rootfs/docker-run.sh "$WORK" restore --root /build/stage/root \
  --archive /work/tr100-bookworm-arm64-rootfs.tar.gz --sha256 "$ROOT_TAR_SHA256"

# 只在通用 staging root 中叠加自动读取身份/串口设置密码的服务。
docker run --rm --platform linux/arm64 \
  --mount "type=volume,src=$TR100_ROOTFS_VOLUME,dst=/build" \
  --mount "type=bind,src=$PWD,dst=/src,readonly" \
  --entrypoint python3 tr100-rootfs-tools:bookworm-arm64 \
  /src/arm64/universal/build.py install-profile --root /build/stage/root

arm64/rootfs/docker-run.sh "$WORK" audit --root /build/stage/root
arm64/rootfs/docker-run.sh "$WORK" archive --root /build/stage/root \
  --output /work/universal-rootfs.tar.gz
arm64/rootfs/docker-run.sh "$WORK" image --root /build/stage/root \
  --size-mib 7414 --output /work/universal-rootfs.ext4

# --unconfigured 只供此通用流程。手动安装仍要先按原指南个性化。
python3 arm64/build/pack.py --image /path/to/Image --dts arm64/tr100.dts \
  --dtc /path/to/dtc --source-date-epoch 1729123200 --unconfigured --output "$WORK/kernel"
sha256sum "$WORK/kernel/installed-p3.bin" "$WORK/universal-rootfs.ext4"
python3 arm64/universal/build.py make-media \
  --kernel "$WORK/kernel/installed-p3.bin" --kernel-sha256 YOUR_KERNEL_SHA256 \
  --rootfs "$WORK/universal-rootfs.ext4" --rootfs-sha256 YOUR_EXT4_SHA256 \
  --output "$WORK/TR100-Universal"
# 可使用 zipfile ZIP_DEFLATED/allowZip64=True 压缩整个目录，勿转换为Android sparse。
```

生成器使用已验证输入的快照进行检查/复制，拒绝已存在输出；只产出普通文件，从不连接串口、挂载块设备或烧写盒子。
`make-media` 验证 uImage 头/载荷 CRC、ARM64 Image、占位 MAC、正式 DTB 分区参数、ext4 大小/UUID、锁定账户、空身份、首次启动脚本和服务依赖。电脑助手另行验证包 SHA256。

测试：

```sh
DTC=/path/to/dtc python3 -m unittest discover -s arm64/tests -p 'test_*.py'
```

首次启动 shell 测试使用主机 BusyBox，串口测试使用字节流模型，不接触设备。发布前还需校验真实 ext4、ZIP 全文件流和服务依赖；这些检查不能代替 HiTool 大文件导入与第二台盒子的首次实机启动。
