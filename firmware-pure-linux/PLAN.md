# TR100 pure Linux 镜像离线工具实施计划

> 按父流程已授权方案在本代理内执行；不创建新 chat、不访问设备、不改旧 checkpoint / packager / flasher，不提交只读 git。

**Goal:** 生成新 map 元数据，以及能够将已验证普通文件流式组装为完整 `.img.gz` 并独立验证的工具。

**Architecture:** 固定几何和前缀保护策略，与有界 gzip 流引擎分层。CLI 固定生产几何；小 fixture 只测试通用流引擎，生产前缀策略使用真实原机载荷及可控本地备份 fixture 验证。

**Tech Stack:** Node.js 内置 fs / crypto / zlib / stream / node:test。

**Spec:** `DESIGN.md`。

## 顺序与接口

- [x] 新建 `tools/pure-linux-image.cjs` 与 `tools/tests/pure-linux-image.test.cjs`，先测试固定布局覆盖总长、p3 10MiB 读取窗口和八分区边界。
- [x] 测试保护切片、64KiB CRC 环境、新 map / bootcmd、原内核 payload 及零 padding；先运行缺实现失败，再实现 `layout()`、`validatePrefix({prefix, originalPrefix, kernelBytes, kernelSHA256})`。
- [x] 测试 `validateRootSuperblock(buffer, rootBytes)` 的新 UUID、1897984 个 4KiB block、旧 feature 白名单与长度拒绝。
- [x] 测试有界流引擎 `assembleStreams({prefixPath, rootPath, outputPath, prefixBytes, rootBytes, prefixSHA256, rootSHA256})` 的拼接 gzip / 全体与子流 SHA、输入损坏不发布、已有目标不覆盖；使用小普通文件，不为每个 case 生成 7.8GB fixture。
- [x] CLI `layout` 输出固定 JSON；`assemble` 要求原 262MiB、实际 42MiB、canonical root 与 kernel SHA/长度的明确参数；`verify` 读取 manifest 与 gzip 流，重算完整镜像与子区间 hash 并复核 metadata。
- [x] 运行所有新测试与 CLI 语法/help 检查：当前整盘组装器 11/11 fixture 通过。新输入尚未到位时只交付工具与设计，不伪造最终镜像或设备验证。

后续父流程新增的两 key 环境生成与读回工具见 `ENVIRONMENT-COMMIT.md`（5 项测试）；纯版普通文件交付组包器见 `DELIVERY.md`（7 项测试，含 probe/原环境、RAMONLY 九片及实际控制脚本材料）。相关三组共 23 项。RAM 数据 flasher 单独有 12 项 fixture 和独立复审，包含实际大于4GiB的 GNU PIPE计数与32位余数拒绝；当前数据阶段只接受已实测 printenv probe p2，工具作者未执行设备主流程。

## 不可绕过的约束

原始备份和 canonical 输入的 expected SHA256 都是必填；CLI 没有几何覆盖、校验跳过、设备路径或自动迁移选项。所有输出只写新 PC 普通文件。临时清理必须先验证绝对路径位于本测试独立根；组装失败只能移除本次 `wx` 创建的 `.partial`。
