# TR100 / GK6323 ARM64 Linux 适配

面向数码视讯 TR100 / GK6323V100C 的实验性 Linux 适配。已完成 Linux 5.10.165 ARM64、Debian Bookworm arm64 适配及原生 Docker 验证，支持真实 EL2/KVM、ARMv7 应用兼容、TUN、IPv4/IPv6 TPROXY、HDMI 文字登录及 CPU 温度读取，保留显示后台线程的低负载修复。板载 SDIO Wi-Fi 已完成自动加载和双频扫描；常用 USB 网卡、摄像头、声卡、存储及蜂窝网卡驱动按需加载，光驱与光盘文件系统已编入内核。具体外设仍需实测，不保证所有型号可用。

当前适配与构建入口见 [ARM64 说明](arm64/README.md)。CPU 保持原厂 1.2 GHz，沿用原厂 loader 和 ATF。仓库中的 Armbian Bookworm armhf / 原厂 3.18.24 流程属于早期方案，不代表当前系统；其他 TR100 批次尚未验证。

## 下载与构建

- [下载发布镜像和完整预备源码](https://github.com/gmingtian/tr100-gk6323-linux/releases)：内核分区镜像、干净 Debian ARM64 系统、运行时驱动与 SHA256 清单。系统默认不安装 Docker。
- [刷入指南](arm64/QUICKSTART.md)：先填写目标设备 MAC 和本地登录凭据，再经 TTL/RAM 维护环境写入 p3、p8；无需重新编译内核。
- [工具说明](arm64/TOOLS.md)：运行位置、参数、输入输出、校验与备份恢复。
- [源码来源与引用](arm64/SOURCES.md)：OpenHarmony 内核、Goke 平台与 SDK、无线驱动、固件和 Debian 的上游地址、锁定版本及许可证说明。
- [内核和全部驱动构建](arm64/build/README.md)、[干净系统构建](arm64/ROOTFS.md)：固定公开源码版本与补丁，支持在另一台 Linux 电脑复用。

公开镜像不包含私人密码、SSH 主机密钥或机器身份。镜像、预备源码包与构建输入通过 Release 提供；Git 仓库保留维护代码、补丁、锁定版本和测试。固件属于二进制输入，不宣称为本项目开放源码。

仓库只选择项目脚本、按系统配置定制的覆盖层、静态布局、说明和测试。镜像、备份、设备日志、机器身份、密码、私钥、第三方源码/运行时/安装包及本机输入 JSON 均不随源码提交。原始二进制中的 SHA/UUID 是安全门禁，不是可下载固件或兼容性证明。没有为厂商代码授予许可证；当前未擅自添加仓库许可证，复用前须另行确认相应文件权利。

## 早期 ARMHF 刷入指南

[中文刷入指南](docs/TR100纯Linux刷入指南.html) 是自包含 HTML，可下载后用浏览器打开并复制命令；包含 RAM 维护、临时/最终环境切换、写入和故障处理。不要在 GitHub HTML 源码预览页直接复制带页面行号的命令。生成源为 docs/build_flashing_guide.py（Python 3 标准库），不会连接设备。

## 源码布局

- `firmware-pure-linux/`：完整用户区镜像组装/核验、最终环境、RAM 数据阶段、普通文件组包及说明。
- `firmware-analysis/board-pure-linux/`：p8 根的网络、SSH、启动交接和离线 stage 覆盖层；research 仅保留自行编写的 probe 环境生成器及测试。
- `firmware-analysis/board-pure-linux-initrd/`：小 initrd 的固定 p8 门禁与 PID1 交接源码。
- `firmware-analysis/tools/`：小 initrd/newc/Android wrapper 构建工具、TFTP/RAM loader、被动捕获及相应测试。
- `tools/`：固定本地文件 TCP 传输和 RAMONLY 大镜像封装；原相对路径保持不变。
- `arm64/`：当前 64 位内核与显示适配补丁、配置、温度驱动、板载 Wi-Fi 服务、用户态构建工具及功能验证程序。

最终设计将前 42MiB 用于必需的厂商引导/硬件参数与 kernel，剩余 7,774,142,464B 全部交给 Linux p8；完整用户区为 7,818,182,656B。它不是 HiTool Android 升级包。旧 800MiB p16 镜像和所有实际产物均被忽略，历史说明中的原机路径/旧布局引用不是当前安装输入。

子目录说明还保留工作区研究、旧目录与 receipt 的出处引用；这些历史数据或分析材料未随源码发布，不能把引用当作已经包含的输入。核心 Node 相对模块依赖保留在上述原树中。

## HDMI 文字终端

[HDMI 安装与回退](hdmi/README.md)：使用 RGB565 + fbterm 在 tty1 提供本地密码登录，不安装图形桌面。当前 ARM64 系统构建已集成该配置；早期基础镜像需按独立说明选装。包含开机服务和离线测试，SSH 与 ttyAMA0 保留。

## 原生 Docker 与 5.10 内核

[源码来源及实机验收](docs/TR100-native-docker.md)：记录 OpenHarmony/Goke 源码版本、内核适配要点、Docker 和自动启动验证，以及驱动空闲等待修复。配套 HDMI 模块加载器、服务依赖、MMZ 和低负载补丁已纳入源码；原基础镜像构建流程仍是 3.18 方案，不会因拉取更新而自动升级设备。

## 测试

需要 Node.js 22.15+；没有第三方 npm 依赖，无需安装 npm 包。shell policy 测试需要 Bash 与 GNU coreutils、awk、find 等工具。Windows 使用默认安装位置的 Git for Windows Bash；非 Windows 的 npm 测试适配器只将测试中既有的 Windows Bash 路径映射为 `bash`，不改生产脚本。默认测试已在 Windows 和 Linux 环境运行；设备回归须单独在目标机验证。

```sh
npm test
```

默认只运行不依赖私有二进制的测试：TCP/TFTP loopback、小型合成 tar/newc/gzip、布局/文件系统 feature 拒绝、纯 initrd policy、PID1/host-root 拒绝及合成 stage/DHCP/账户门禁。测试使用自建临时文件，不连接设备，不运行刷写器。initrd 的真实 ARM ELF/归档案例被名称过滤排除；默认测试通过不等于 ARM 启动或 eMMC 刷写验证。

```sh
npm run test:windows-guards
npm run test:device-fixtures
```

`test:windows-guards` 另需 Windows、Git Bash、GNU 工具及 `fsutil`；包含大于 4GiB 的本次临时稀疏普通文件和真实 PIPE 计数测试，不写设备。

`test:device-fixtures` **不是干净 clone 可直接通过的默认测试**。它保留真实本机已验输入的集成用例，当前 shell/archive harness 也要求上述 Windows 工具和 `tar.exe`。至少需要以下被忽略的本地数据，必须由设备所有者合法准备并独立核验，不可上传：

- `firmware-analysis/factory-backup/factory-bootargs.bin`、`factory-kernel.bin`。
- `firmware-analysis/sources/busybox-static-bookworm-armhf`，须匹配源码固定 ARM ELF/SHA 门禁。
- `firmware-analysis/rom-final/boot.img`，仅作为原 kernel 载荷保留测试的旧本地 fixture，不能用于纯版部署。
- `firmware-analysis/ram-test/RAMONLY-bookworm-full-boot-v2/` 九片及 manifest。
- `firmware-analysis/board-pure-linux/research/probe-environment/probe-candidate/` 本地 probe binary/receipt；缺失时可在拥有原环境后用生成器重新离线创建。

早期 ARMHF root/boot 组包还需要官方用户态来源、经校验的内核/模块/BusyBox、本机 prefix 与 canonical root 等本地输入。这组历史工具不下载或伪造这些材料。输入 schema 见 `firmware-pure-linux/package-inputs.template.json`，真实含绝对本机路径的 `final-package-inputs.json` 被忽略；当前 ARM64 的源码取得和干净系统构建入口见上方链接。

## 操作边界

先阅读 `firmware-pure-linux/DELIVERY.md`、`MIGRATION-DATA-PHASE.md`、`ENVIRONMENT-COMMIT.md` 和 `MAINTENANCE-RESOURCES.md`。RAMONLY 只供内存维护，禁止当持久 ROM 写入 eMMC；数据脚本默认检查、严格限制布局/摘要，最终环境提交为独立步骤。COM4、维护 IP 和各 SHA 都是当次本机流程约束，不是其他盒子的通用配置。

说明中的历史阶段、软件重启和物理断电测试须分别理解；仓库不携带私人运行证据，不能用单元测试代替实际部署凭据。密码和公钥由设备所有者另行设置，不存在可发布的默认明文密码。

不要改写冻结脚本的字节、换行或编码来绕过摘要检查。Git 发布前须确认换行转换策略能保持已审原字节；`.gitignore` 不会清除已经进入索引的文件，提交者仍需逐项审阅候选清单和密钥/凭据检测结果。此工作区的镜像和备份应留在原路径，不要为了 Git 提交搬移到新的导出树。

64 位内核和 Debian arm64 适配的增量源代码、配置及验证程序见 [ARM64 适配](arm64/README.md)。
