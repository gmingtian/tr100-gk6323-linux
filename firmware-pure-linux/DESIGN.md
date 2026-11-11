# TR100 全用户区 Linux 镜像设计

状态：新布局设计与离线工具；工具作者尚未执行本布局的设备写入或持久启动验证。旧 800MiB p16 checkpoint 与旧打包/写入工具保持原样。本设计的整盘组装器只处理 PC 普通文件；后续单独准备的 RAM 数据写入脚本及执行前提见 [MIGRATION-DATA-PHASE.md](MIGRATION-DATA-PHASE.md)，它不改环境或重启，作者未在设备执行。

## 固定布局

eMMC 用户区为 **7818182656 字节 / 15269888 个 512B 扇区**。分区来源是原厂内核 `blkdevparts`，本方案不改写成 GPT/MBR。

| Linux 分区 | 名称 | 起始字节 | 长度字节 | 策略 |
| --- | --- | ---: | ---: | --- |
| p1 | fastboot | 0 | 4194304 | 与原备份 SHA 保持 |
| p2 | bootargs | 4194304 | 4194304 | 父流程实际新环境；前 64KiB CRC32 有效 |
| p3 | kernel | 8388608 | 12582912 | 原 recovery 槽改 Linux kernel；候选 ≤10MiB；槽内余量清零 |
| p4 | deviceinfo | 20971520 | 4194304 | 与原备份 SHA 保持，保留设备身份 |
| p5 | atf | 25165824 | 2097152 | 与原备份 SHA 保持 |
| p6 | baseparam | 27262976 | 8388608 | 与已核验原前缀中的切片 SHA 保持 |
| p7 | pqparam | 35651584 | 8388608 | 与已核验原前缀中的切片 SHA 保持 |
| p8 | rootfs | 44040192 | 7774142464 | 覆盖用户区全部剩余空间；15183872 扇区 |

固定 map：`4M(fastboot),4M(bootargs),12M(kernel),4M(deviceinfo),2M(atf),8M(baseparam),8M(pqparam),-(rootfs)`。

新 root 的 4KiB block 数为 **1897984**，UUID 为 `a8d4abf7-6ae4-4f9b-a39a-ef1b79c63230`，预期文件标记为 `tr100-pure-linux-20261111`，目标设备为 `/dev/mmcblk0p8`（`259:0`）。label 读取并记录，不擅自新增用户未指定的固定 label。

环境中的 ATF 读取仍是设备 0、目标 `0x08020000`、起始 `0xc000`、`0x1000` 个扇区；kernel 改为起始 `0x4000`、读取 `0x5000` 个扇区，源/bootm 地址 `0x01ffbfc0`。因此 kernel 分区虽然有 12MiB，原厂启动读取窗口仍只有 10MiB。

## 输入与信任边界

组装接受三个独立输入，均要求普通文件、显式预期 SHA256：

1. 原始前 262MiB 备份（274726912B）：父流程完成只读设备备份及设备/主机 SHA 对比后提供。工具核对完整文件 SHA，并从中计算五个保护分区的切片 SHA。p1 / deviceinfo / ATF 另与现有原机固定 SHA 比较；baseparam / pqparam 以完整已核验原备份切片为准。
2. 实际迁移后重新读取的 42MiB 前缀（44040192B）：不能从计划字符串伪造。父流程实际写入新 kernel、保存新环境后读回、校验，再提供给工具。除 p2 / p3 之外的保护区必须与原备份切片逐一相同。解析 p2 起点处的标准 64KiB 环境（4B LE CRC32 + 数据），核验 map 与 bootcmd；不执行其中任何内容。
3. canonical 大 root raw（7774142464B）：来自全新 Linux stage / ext4 构建，显式 SHA 必须匹配；工具读 superblock 核验长度、UUID、4KiB block count、clean 状态和旧内核保守 feature 白名单。

另接受已审核新 `kernel.img` 的预期 SHA / 长度，用于检查前缀 p3 的镜像和零 padding。原厂 Android 包装内核载荷 SHA 必须保持 `a3668f0fd0e3f7b89eb4ea9293d03c8b32c7c01c7a13c520e3b2615ce84f84e6`；本工作不编译内核，不声称获得主线内核或官方 Armbian 板级支持。

工具的字节/环境/superblock 检查不能证明 initrd 的 p8 选根逻辑或 root 内文件 tag 已正确适配；这部分必须由父流程的新 map RAM 验证、native fsck/只读内容核验和后续启动证据补充。元数据显式保留该界限，不把计划 tag 当成已观察结果。

## 流式组装与核验

默认只生成 `TR100-pure-linux.img.gz`：按顺序压入 42MiB 前缀和大 root 的所有逻辑字节，得到解压后恰为 7818182656B 的完整用户区镜像。不再创建第二份约 7.8GB raw，保留 C 盘空间。单个 chunk 有界，SHA 与 gzip 均流式处理；先写新的 `.partial`，完整长度、输入 SHA 和流程均成功后才发布输出及 manifest。拒绝覆盖现有输出。

独立 verify 流式解压，限制总输出不超过固定用户区长度，分别计算完整 raw、42MiB 前缀与其后 root 的 SHA，并重查前缀保护切片、环境、kernel 和 root superblock。gzip CRC/EOF 失败、短流或多一字节都会失败。

root raw 在宿主机上可使用稀疏文件来节省分配；镜像的逻辑零字节必须保留。未来设备安装必须写入所有逻辑字节，不能把宿主 sparse hole 解释为“跳过旧设备扇区”。完整 root 覆盖 42MiB 到磁盘末尾，p3 剩余槽清零，因此本布局不保留旧 Android recovery/system/cache/private/securestore/userdata 区域。必需的厂商启动固件、设备信息和硬件参数仍保留在前缀，不把“清 Android”描述成删除必需 boot 固件。

## 备份与后续执行

父流程先备份原前 262MiB、private 50MiB、securestore 8MiB，保留已有原 kernel / 原 system 备份和设备证据，然后先做可撤回的 RAM 新布局验证。未备份原 userdata / cache / backup 的所有内容，不能宣称完整用户数据可恢复或原全盘 forensic rollback。

整盘镜像覆盖 eMMC **用户区**，不包括硬件 boot0 / boot1 / RPMB。它带有这台设备的 deviceinfo 等原机内容，是设备绑定镜像，不承诺可跨其他 TR100 通用刷入。新迁移 flasher 需要另行设计、独立严格 gate，并由父流程单独执行；旧 p12/p16 flasher 禁止用于新 map。
