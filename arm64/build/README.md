# 从源码构建 ARM64 内核与驱动

使用同一 Release 的预备源码、BusyBox、固件缓存和 Debian 完整包闭包，在新电脑离线重建，见 [REBUILD.md](../REBUILD.md)。

在 Linux 上执行。源码、构建输出均使用不含空格的绝对路径；脚本只生成文件，不连接设备或刷写分区。

## 依赖与输入

需要 Python 3.11+、Git、GNU make、GCC 11 AArch64 交叉工具链、宿主 GCC、bison、flex、Perl、OpenSSL 开发头文件、bc 和 kmod。发行版的交叉编译器前缀通常是 `aarch64-linux-gnu-`；用 `--cc` 指定其 GCC 11 可执行文件。

另需静态 AArch64 BusyBox，以及板载无线的两份原厂固件。BusyBox 可从 Debian Bookworm 的 `busybox-static:arm64` 包解出，无需执行它；构建工具会检查 ELF 架构和静态链接属性。无线固件文件名、大小、SHA256 与来源约束见 [无线构建说明](../radio/README.md)。这些二进制输入不是本项目自行编写的源代码。

## 完整在线构建

从仓库根目录运行，先将示例路径替换为自己的目录：

```sh
WORK=/absolute/path/without-spaces/tr100-build
python3 arm64/build/prepare.py --work-dir "$WORK"
python3 arm64/build/build.py --work-dir "$WORK" \
  --cross-compile aarch64-linux-gnu- \
  --cc aarch64-linux-gnu-gcc-11 \
  --busybox /absolute/path/to/busybox-static-arm64 \
  --factory-firmware /absolute/path/to/factory-firmware \
  --source-date-epoch 1794441600
```

`prepare.py` 按 `sources.json` 的完整提交号取得内核、Goke 平台补丁、显示 SDK、板载无线和四组 USB 无线驱动。它忽略输入 Git 仓库的工作区修改，依次应用本项目补丁。准备成功后才发布 `sources/` 和来源清单。

`build.py` 构建内核、initramfs、内核模块、九个显示模块、温度模块、板载 Wi-Fi 和四组 USB 无线驱动，校验并组装固件。输出目录仅在完整构建成功后出现；失败时可复用源码、缓存和目标文件，不会把半成品标为完成。

输出位于 `$WORK/output/`：

- `Image`、`kernel.config`、`System.map`、`Module.symvers` 与 `kernel.release`。
- `modules.tar.gz`：全部运行时模块与内置模块元数据，使用 `usr/lib/` 路径，兼容 Debian 合并 `/usr` 布局。
- `firmware.tar.gz`：经过校验的固件、许可证与来源信息。
- `source-manifest.json` 和 `build-manifest.json`：源码版本、补丁和产物摘要。

构建不要求 Docker。干净系统镜像另见 [ROOTFS.md](../ROOTFS.md)；分区镜像封装见 [PACKAGING.md](../PACKAGING.md)；实际安装步骤见 [QUICKSTART.md](../QUICKSTART.md)。

## 离线复用与验证

`prepare.py` 支持现有 Git 对象库参数，固件支持经过 SHA256 验证的离线缓存，详见无线构建说明。发布源码包中的预备源码应保留 `source-manifest.json`，可直接作为上述 `--work-dir` 下的 `sources/` 输入，跳过联网取得源码的阶段。固定源码与时间戳不代表任意工具链版本都能产生逐字节相同的二进制；应同时保存编译器版本与构建清单。

```sh
python3 -m unittest discover -s arm64/tests -p 'test_*.py'
```

真实 KVM 验证程序需编译为 AArch64，再放到目标系统运行：

```sh
aarch64-linux-gnu-gcc-11 -O2 -Wall -Wextra -static \
  arm64/tests/kvm-real-probe.c arm64/tests/kvm-guest.S -o kvm-real-probe
```

它打开 `/dev/kvm`，在四个物理 CPU 上分别创建并执行真实 vCPU，检查客体 MMIO 写回值。成功标志为 `REAL_KVM_ALL_FOUR_CPUS_PASSED no_emulation_fallback`。单有内核配置、设备节点或 QEMU TCG 输出不算 KVM 验证；原厂引导器进入 EL2 的前置步骤见刷入指南。
