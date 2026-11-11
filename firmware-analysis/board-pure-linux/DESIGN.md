# TR100 纯Linux分区方案与门禁

仅为独立离线候选，未在设备验证。旧800MiB版本和其配置保持不动，作为已通过两次eMMC默认启动的回退基线。

## 布局

eMMC用户区精确7818182656字节，15269888个512字节扇区，7456MiB。保留前42MiB边界；其中旧recovery的8..20MiB改为12MiB Linux kernel。4MiB fastboot、4MiB环境、20..24MiB deviceinfo/MAC、24..26MiB ATF、26..34MiB baseparam、34..42MiB pqparam保留。它们是该板引导/硬件配置区，不是Android用户态。

剩余唯一根从42MiB（sector86016）起，15183872sectors=7774142464字节=7414MiB，设备p8/259:0。UUID固定a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230，tag为tr100-pure-linux-20261111。无Android recovery/system/data、无swap或其他Linux数据分区。blkdevparts是厂核命令行分区方案，不需要在这里另建GPT/MBR。

新map精确为：

`blkdevparts=mmcblk0:4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)`

拟定bootcmd保留ATF绝对读取0xC000/0x1000和原加载地址；kernel改读start0x4000/count0x5000至0x1FFBFC0。count0x5000只读取10MiB，尽管kernel分区12MiB，新boot镜像仍必须不超过10MiB，不能用分区大小替代这个实际读取上限。本目录不执行setenv/saveenv/写盘。

## 硬件依赖风险

实机冷启动日志default-emmc-first/second-boot显示引导器在prompt前检测遥控recovery、读取MAC和保留显示内存；ATF明确NoTSP仍成功启动Linux。故当前Linux不要求trustedcore成功提供安全OS，但不能推出所有闭源固件绝不读取旧分区。

原factory-fastboot.bin的LZMA候选（原偏移0x119a4）解出引导器代码后，真实字符串包括Logo_Main、PDM_ReadLogoData、fastplay/fastplaybak、recovery/misc、按分区名找不到时的错误提示；baseparam有明确use-default提示。仅字符串不能证明缺logo/fastplay是致命或可忽略，尚无完整控制流审计。供应Android fstab引用misc/private/cache/backup，说明是Android用户态依赖；新Linux根不运行这些脚本。

**volatile map启动与saveenv后截停不足以完全证明覆盖旧内容后的硬件路径无依赖**：它们能检验名称/缓存分区表路径，但旧内容仍在，可能掩盖闭源按绝对offset读取logo/fastplay的行为。不得把前两次门禁通过描述为已证明擦后所有隐藏路径安全。

## 必须的可逆门禁

1. 先完成并独立重读核验：0..262MiB完整前缀、原环境4MiB与环境文本、private50MiB、securestore8MiB；保留原厂完整system及现有工作800MiB Linux canonical映像、boot映像及SHA。新root覆盖旧p16，所以仅备份前缀不能恢复工作系统。若要恢复完全相同的hostkey/machine-id与当前用户数据，还需其单独一致性备份；canonical只保证功能恢复。
2. 在已有恢复工具/串口可用且旧内容完全未覆盖时，仅volatile修改新map，以RAM initrd引导核对全盘大小、8个分区、p3/p8几何、MAC/网络、基础硬件。新root尚无新UUID时停人工shell，绝不格式化、搜索旧p16或自动回退。
3. 新map持久化属于独立写环境步骤。父任务先核验保存前环境备份，saveenv后重启并截停，确认bootloader可正常完成DDR/MMC/MAC/显示初始化和到prompt；此时仍不覆盖旧数据。保留能按绝对地址恢复旧环境与前缀的手段，不依赖被移除的Android recovery入口。
4. 最终写入由另行审查的精确设备写入器完成。若目标新p8，写范围为42MiB..盘尾，会覆盖旧logo/fastplay/旧kernel/trusted/system/private/secure/userdata；不得在旧p8映射下写同名设备。新kernel只能写8..20MiB，保留其他前缀区域；环境保存区不是根镜像内容的一部分。
5. 首次覆盖后需验证一次断电冷启动及再次默认启动、rootp8容量、无Android分区、SSH/DHCP/NTP、MAC、串口和USB。若引导器在prompt前失败，前述截停门禁并不能替代硬件恢复能力。没有通过这一步就不能交付为已验证整机镜像。

## 根交接

新small initrd仅选择p8/259:0并验证上述disk/start/size/UUID/tag，不含旧800MiB下载/loop或p16回退。它挂至/newroot，写/run/tr100的root-device/root-devnum/root-uuid三个单行数据文件，将proc/sys/dev/run移到newroot，然后PID1 switch_root调用/usr/local/sbin/tr100-rom-bootstrap。

此目录复用已验证的API挂载复用、PID1救援、mdev+真实udev交接、USB模块、legacy cgroup、GPTauto generator屏蔽和六项维护mask。rootbootstrap再次校验唯一新map与几何，不从源tar运行Android脚本。DHCP、密码/公钥SSH、持久hostkey、Shanghai时区、APT/timesync inet主组及新普通用户inet默认配置均保留。
