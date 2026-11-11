# 纯 Linux 迁移数据阶段审查

本脚本的工具作者仅在 PC 完成实现与审查，没有操作设备。父流程的实际部署和默认启动结果另见包内 runtime-evidence.json 与 evidence/，不能把作者范围误读为设备尚未运行。脚本就绪不等于已批准迁移，也不证明独立 ROM 恢复链可用；父流程仍须完成恢复能力与断电风险判断，向用户说明后决定执行。旧 800MiB checkpoint、旧 packager/flasher 均保留。

## 当前证据与范围

原前 262MiB 备份为 `firmware-analysis/pure-linux/backups/before-pure-prefix-262MiB.bin`，274726912B，SHA256 `a8330d0eed9736e91029bf64abc797082b3b8614a1c20f5ea1683838b1ae98c2`。分段证据在同目录 `prefix-verification.json`。这是部分原机区域备份，不是全盘备份。private/securestore/SSH 私钥备份未包含在该证据中；此前相关导出被自动审查拒绝，不重试其他路径导出。

独立 ROM 恢复目前仅有 hiloot 头匹配证据，尚未实测。数据写入开始后若丢失 RAM 会话/电源，不能据此承诺仍可恢复。前 262MiB 也不包含完整 Android system/userdata；清空这些区域后不能宣称恢复完整原机内容。

`tools/flash-pure-from-ram.sh` 只写两个范围：新 p8 从 42MiB 到用户区末尾，以及新 p3 的完整 8..20MiB 槽。p8 会覆盖旧 p12 内核及旧系统/数据区域。父流程已用新八分区 map、`bootcmd=printenv`、`bootdelay=3` 的 probe 环境实测软件重启并重新进入 RAM；数据阶段必须保留它，不能恢复旧 bootcmd。这样意外复位默认停在原 fastboot 的只读 CLI，不会尝试加载被 p8 覆盖的旧 kernel。脚本故障后仍应保留 RAM 会话供检查，不自动重启或断电；这不等于独立 ROM 恢复或物理断电重启已实测。

## 默认只读检查

脚本固定读取 `/run/tr100/pure-flash/boot.img` 和 `system.ext4.gz`。它们须上传结束、无其他写入者、普通非 symlink 且单 hardlink，路径实际所在文件系统必须为 RAM rootfs/tmpfs。预检期间仅创建、使用并清理一个本次 mktemp 生成的小 RAM 文件；绝不写块设备。identity/mtime 检查不能隔离恶意并发 root 改写，因此父流程须冻结上传与输入。

```sh
/usr/lib/tr100/busybox sh /run/tr100/pure-flash/flash-pure-from-ram.sh --check \
  --boot-sha256 c4e63e9a104d126685885b33db2c231f7ece5b5babc85f03531cc263722de7c9 \
  --root-gzip-sha256 CANONICAL_GZIP_SHA256 \
  --root-raw-sha256 CANONICAL_RAW_SHA256
```

两个占位值须替换成父流程最终构建和独立核验的 64hex 摘要；占位值会被拒绝。不传 mode 等同 `--check`。唯一写入 mode 是显式 `--write`；本说明不执行它。

脚本要求原 3.18.24 内核、full RAM marker、可写 rootfs/tmpfs 根、所有挂载设备号为 0:*、没有 swap，以及唯一精确新八分区 token。它检查 mmcblk0 的 15269888 sectors / 512B block、真实块节点、sysfs alias/parent 和全部八分区几何。p3 必须为 179:3/start16384/size24576；p8 必须为 259:0/start86016/size15183872。

boot 输入严格固定 pure v2 的 9863168B 和上述 SHA，不接受旧 p16 initrd。root gzip 最大 1GiB，完整解码有 7414MiB 双层写上限，解码长度必须为 7774142464B；先读 ext4 magic/new UUID，再以原生 OpenSSL 完整计算 raw SHA。无需保留另一份 7.7GB 解压文件。

超过 4GiB 的流量计数只使用固定 `/usr/bin/wc -c`，启动前要求实测 GNU coreutils9.1 首 banner。主计数输入必须来自解压/有界 copier/2048B header 消费后的 **PIPE**；本机已观测 GNU wc 在可寻址普通文件的快速路径会返回 32 位余数，而同一 gzip 的完整 GNU PIPE 计数为 7774142464B。不要用 `wc -c < rootfs.raw` 作为本机大文件长度证据；可用 `stat -c %s` 和完整 SHA，或真实管道计数。数据阶段扣除 header 后必须为 7774140416B；错误会报告实际 remaining，失败仍没有设备写入。仅用于 overflow probe 的 BusyBox wc 始终只计0或1字节，保留原上限行为。

p1/p4/p5/p6/p7 按原始分段 SHA 校验；p2 唯一允许 SHA 为 `216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f` 的已实测 probe 环境。旧原厂 p2 和最终自动启动 p2 均不接受，也没有 bypass。脚本不修改 p2。任意预检失败均不能出现 `CHECK_PASSED` 或启动写入。

## 显式数据写入顺序

1. 再核对 RAM/输入/节点/几何，gzip 经有界流写完整 p8，dd 使用 fsync。
2. OpenSSL 整分区读取 p8，必须等于 canonical raw SHA；失败不清 p3，保留 probe 的 printenv 启动路径。
3. 再核对门禁，把 p3 全 12MiB 写零，再写 reviewed boot 的 9863168B。
4. 读回 kernel prefix SHA，并核验剩余 2719744B 的 SHA 等于全零 SHA。
5. 复核 p1/p2/p4/p5/p6/p7 全 SHA 不变，才报告 `DATA_WRITE_COMPLETE`，同时输出 `PERSISTENT_BOOT_CONFIGURATION_PENDING`。

整个流程启用 pipefail；解压、上限、写入、fsync 或读回失败均停止，不重试、不重启、不写环境。12MiB 清零与 10MiB 有效读取窗口分别约束分区残留和 U-Boot 可见范围。

## 父流程后续独立提交

脚本结束时持久 bootargs 是 probe 的新布局，但 bootcmd 仍仅 printenv，不能声称默认启动 Linux。数据完整读回成功后，父流程才单独控制最终 4MiB 两键环境提交及完整读回，核对 kernel read 从 0x4000 读取 0x5000 sectors、ATF read 保持不变；随后捕获默认启动、p8 身份与完整运行状态。最终环境 SHA 仍为 `06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885`。只有实际最终环境/新 kernel 写入后实读的 42MiB prefix，才可用于整盘镜像组装。

若数据阶段失败且 RAM 会话仍可用，父流程须根据具体已完成步骤制定恢复；原始 prefix 与原 kernel/system 备份可恢复对应已备份区域，但不能补回未备份的 private/securestore/userdata。恢复不得覆盖 MAC/deviceinfo/ATF/baseparam/pqparam。此脚本不提供自动恢复执行器。

## 离线验证

```powershell
node --test .\firmware-pure-linux\tools\tests\flash-pure-from-ram.test.cjs
```

测试只在 PC 执行独立 guard 函数、CLI 拒绝路径和替代底层设备 IO 的写入顺序 fixture；不运行设备主流程，不接串口，不操作块设备。真实 Linux/BusyBox/native OpenSSL 的平台行为和设备预检须由父流程另行验证。
