# TR100 纯Linux候选覆盖层

本目录独立于已工作的800MiB `board-rom`。新的唯一Linux根占盘尾全部7414MiB，前42MiB保留引导/硬件区域（其中8..20MiB由旧recovery改为Linux kernel）。精确布局、隐藏依赖风险和写前门禁见 [DESIGN.md](DESIGN.md)。这还是待验证候选，不是已通过冷启动的交付镜像。

## 新身份与交接

- 根设备 `/dev/mmcblk0p8`，sysfs设备号 `259:0`；start86016、size15183872；全盘15269888sectors。
- UUID `a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230`；tag `tr100-pure-linux-20261111`。
- 仅接受DESIGN中精确且唯一的8分区blkdevparts；拒绝旧p16、loop和旧tr100.ramtest/root_sha参数。新small initrd不得搜索或回退到旧根。
- initrd移交proc/sys/dev/run和三个单行/run/tr100记录后，仍调用 `/usr/local/sbin/tr100-rom-bootstrap`。bootstrap重复核验当前根ext4/rw、device/UUID/tag、全盘/根几何与新map，保留已验证的PID1/udev/cgroup/USB流程。

旧厂核配置已确认 `CONFIG_LBDAF=y`、`CONFIG_EXT4_FS=y`、`CONFIG_CMDLINE_PARTITION=y`、`CONFIG_MMC_BLOCK_MINORS=8`。7414MiB文件系统按4096块为1897984块，不需要启用ext4的64bit新feature。仍须保留已验证的旧内核ext4特性白名单，并在原3.18内核对新普通镜像 `ro,noload` 验证；不能仅凭配置就宣称新尺寸已实测。新raw长度大于4GiB，构建/传输/写入器的计数必须使用64位或精确安全整数，旧800MiB限长器不可直接复用。

## 构建使用

`overlay/`、symlinks/file-modes/remove-paths/conditional-remove-paths与安装工具来自已验证board-rom；变更出处与原文件SHA在 `derivation.json`。仅root身份/map/geometry有行为变化，网络、密码及公钥SSH、inet兼容、新普通用户默认联网、Shanghai时区和维护mask均复用。

有两条构建路径，不能混用：

1. 从已审查官方源tar和匹配timesyncd包创建**新的可丢弃stage**：Linux root可运行 `sh install-overlay.sh /absolute/stage`。它验证源os-release/dpkg、应用此overlay/链接、清除源模板hostkey、初始化新machine-id/hostname/inet账户；之后父任务秘密设置用户指定密码。prepare-identity的缓存root锁定检查只针对这条路径。
2. 从PC静态canonical800MiB映像派生新普通文件：由父任务另外离线扩容/改UUID并**只替换本目录bootstrap与两marker及其他确认缺失配置**。不要对已经设置密码的canonical或在线根重跑整个安装脚本，不要把其fresh-stage identity重置当升级；更不能从活根复制动态hostkey/machine-id。本目录没有resize/格式化/分区/写盘工具。

Linux根UUID、marker、initrd验证值必须一起更新；kernel放置在新p3但bootloader仍沿用Android格式封装来传递Linux内核/initrd，这一封装不是Android用户态或recovery。kernel分区12MiB，拟定bootcmd实际只读10MiB，所以boot.img必须继续在10MiB之内。

## 依赖审查证据

`research/inspect-fastboot.cjs`对本机原fastboot备份做有界LZMA静态解码，不访问设备。已找到精确完整流：偏移0x119a4、压缩289064B、展开813924B、7z exit0，SHA/字符串偏移记录在 `research/fastboot-static.json`。其中确有logo/fastplay/recovery查找代码，不能凭Linux已启动就认定它们在bootloader阶段可随意删除。没有发现足以宣称“缺失绝不会影响启动”的完整控制流证据。

先volatile新map RAM initrd核对，再按父任务批准步骤保存环境并重启截停；仍需警惕旧内容掩盖绝对offset读取。私有/安全区备份必须在旧map节点尚存在时按已确认几何完成，或保留等价绝对offset恢复资料。旧800MiB Linux根位于新root覆盖范围内，故0..262MiB前缀备份必须搭配工作系统映像才能回退。

## 离线验证

```text
node tests/layout.test.cjs
node tests/check-rom.cjs
node tests/network-access.test.cjs
node research/inspect-fastboot.cjs
```

layout测试提取真实纯函数，验证唯一新map、旧模式拒绝、设备/几何及总容量算术。其余测试复用已验证DHCP/身份/权限/SSH/维护mask测试，均不执行设备命令。rootbootstrap非PID1执行立即拒绝。任何“已实测纯布局启动”结论须等父任务真实日志，不能由这些离线测试代替。
