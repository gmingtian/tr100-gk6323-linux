# TR100 纯 Linux 工具源码

面向数码视讯 TR100 / GK6323V100C 的实验性、设备绑定 Linux 适配工具。用户态方案使用 Armbian Bookworm armhf，配合本机原厂 3.18.24 内核和厂商引导固件；这里不包含内核或厂商二进制，也不宣称官方通用板型支持。

仓库只选择项目脚本、按系统配置定制的覆盖层、静态布局、说明和测试。镜像、备份、设备日志、机器身份、密码、私钥、第三方源码/运行时/安装包及本机输入 JSON 均不随源码提交。原始二进制中的 SHA/UUID 是安全门禁，不是可下载固件或兼容性证明。没有为厂商代码授予许可证；当前未擅自添加仓库许可证，复用前须另行确认相应文件权利。

## 刷入指南

[中文刷入指南](docs/TR100纯Linux刷入指南.html) 是自包含 HTML，可下载后用浏览器打开并复制命令；包含 RAM 维护、临时/最终环境切换、写入和故障处理。不要在 GitHub HTML 源码预览页直接复制带页面行号的命令。生成源为 docs/build_flashing_guide.py（Python 3 标准库），不会连接设备。

## 源码布局

- `firmware-pure-linux/`：完整用户区镜像组装/核验、最终环境、RAM 数据阶段、普通文件组包及说明。
- `firmware-analysis/board-pure-linux/`：p8 根的网络、SSH、启动交接和离线 stage 覆盖层；research 仅保留自行编写的 probe 环境生成器及测试。
- `firmware-analysis/board-pure-linux-initrd/`：小 initrd 的固定 p8 门禁与 PID1 交接源码。
- `firmware-analysis/tools/`：小 initrd/newc/Android wrapper 构建工具、TFTP/RAM loader、被动捕获及相应测试。
- `tools/`：固定本地文件 TCP 传输和 RAMONLY 大镜像封装；原相对路径保持不变。

最终设计将前 42MiB 用于必需的厂商引导/硬件参数与 kernel，剩余 7,774,142,464B 全部交给 Linux p8；完整用户区为 7,818,182,656B。它不是 HiTool Android 升级包。旧 800MiB p16 镜像和所有实际产物均被忽略，历史说明中的原机路径/旧布局引用不是当前安装输入。

子目录说明还保留工作区研究、旧目录与 receipt 的出处引用；这些历史数据或分析材料未随源码发布，不能把引用当作已经包含的输入。核心 Node 相对模块依赖保留在上述原树中。

## HDMI 文字终端

[HDMI 安装与回退](hdmi/README.md)：使用 RGB565 + fbterm 在 tty1 提供本地密码登录，不安装图形桌面。包含开机服务和离线测试，SSH 与 ttyAMA0 保留。原基础镜像不包含此后续配置，刷入后需按该说明选装。

## 测试

需要 Node.js 22.15+；没有第三方 npm 依赖，无需安装 npm 包。shell policy 测试需要 Bash 与 GNU coreutils、awk、find 等工具。Windows 使用默认安装位置的 Git for Windows Bash；非 Windows 的 npm 测试适配器只将测试中既有的 Windows Bash 路径映射为 `bash`，不改生产脚本。当前完整运行证据来自 Windows；其他环境仍须按这些依赖验证。

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

构建实际 root/boot 或组包还需要官方用户态来源、经校验的内核/模块/BusyBox、本机 prefix 与 canonical root 等本地输入。源码只提供工具，不下载、上传或伪造这些材料。输入 schema 见 `firmware-pure-linux/package-inputs.template.json`，真实含绝对本机路径的 `final-package-inputs.json` 被忽略。

## 操作边界

先阅读 `firmware-pure-linux/DELIVERY.md`、`MIGRATION-DATA-PHASE.md`、`ENVIRONMENT-COMMIT.md` 和 `MAINTENANCE-RESOURCES.md`。RAMONLY 只供内存维护，禁止当持久 ROM 写入 eMMC；数据脚本默认检查、严格限制布局/摘要，最终环境提交为独立步骤。COM4、维护 IP 和各 SHA 都是当次本机流程约束，不是其他盒子的通用配置。

说明中的历史阶段、软件重启和物理断电测试须分别理解；仓库不携带私人运行证据，不能用单元测试代替实际部署凭据。密码和公钥由设备所有者另行设置，不存在可发布的默认明文密码。

不要改写冻结脚本的字节、换行或编码来绕过摘要检查。Git 发布前须确认换行转换策略能保持已审原字节；`.gitignore` 不会清除已经进入索引的文件，提交者仍需逐项审阅候选清单和密钥/凭据检测结果。此工作区的镜像和备份应留在原路径，不要为了 Git 提交搬移到新的导出树。
