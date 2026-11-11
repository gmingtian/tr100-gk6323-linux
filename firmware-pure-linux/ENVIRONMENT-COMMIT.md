# 纯 Linux 环境独立提交检查清单

本阶段与 `flash-pure-from-ram.sh` 的 p8/p3 数据阶段分开。工具作者只生成 PC 普通文件，未访问设备、未提交环境、未重启。数据 flasher 的 p2 唯一初始状态是父流程已实测新 map 软件重启的 `bootcmd=printenv` probe，SHA `216e44221aff6cf13f4cfeba8a2b97194a4a162220354a338b3fb8536b2db13f`。不得恢复旧原厂环境后再写数据；probe 默认回 fastboot CLI，避免意外复位加载被 p8 覆盖的旧 kernel。提交最终环境后，也不能再次把它作为 probe 环境的数据写入预检运行。

`tools/build-environment.cjs` 输入固定原始 4MiB `factory-bootargs.bin`，SHA `489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac`。原格式是首 64KiB 内 4B LE CRC32 加 65532B NUL 数据。工具拒绝错误格式/CRC、重复 key、非 ASCII/隐藏 padding；只替换 `bootcmd`、`bootargs` 的值，保留全部其他 key/value 和原顺序，以及 64KiB 后 4128768B 原字节。

原存储 ethaddr、bootargs_2G 等备用值均保留；不把运行时由原 deviceinfo 提供的 MAC 写回环境。deviceinfo、引导固件和硬件参数继续保持不变。

当前生成的 `environment-candidate/bootargs.bin`：4194304B，SHA256 **`06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885`**，首 64KiB CRC32 `02bec23d`。字节差异和只改两项的证据在同目录 `manifest.json`；它不是设备读回证据。

```powershell
node .\firmware-pure-linux\tools\build-environment.cjs build --original .\firmware-analysis\factory-backup\factory-bootargs.bin --original-sha256 489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac --out NEW_DIRECTORY
node .\firmware-pure-linux\tools\build-environment.cjs verify --original .\firmware-analysis\factory-backup\factory-bootargs.bin --original-sha256 489debc75ac9c3e525f5ecb336a18521e062b8ff6c10ff6551e3d4da6eabd2ac --candidate READBACK.bin --candidate-sha256 06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885
```

## 父流程在提交前逐项确认

- 保持 full RAM maintenance；新 map 已由 volatile bootargs 验证，根非块设备，MMC 没有挂载，输入上传已结束并冻结。
- 用户已了解清 Android 与恢复范围；独立 ROM 恢复是否实测，必须以父流程实际证据为准。工具存在不构成迁移批准。
- 原前 262MiB 备份及原 kernel/system checkpoint 证据可访问，SHA 已比对；不宣称覆盖未备份的 private/securestore/userdata。
- 数据 flasher 已报告 `DATA_WRITE_COMPLETE`，p8 raw SHA、p3 boot prefix SHA/全零尾和 p1/p4/p5/p6/p7 原保护 SHA、p2 probe SHA 均成功。若失败，停留 RAM、保留 printenv probe，不提交最终环境。
- 新环境 RAM 普通文件恰 4194304B 且 SHA 为上述固定值；目标仅 p2，start8192/size8192 sectors、sysdev179:2、nodehex b3:2，whole MMC15269888 sectors。具体受控写入命令由父流程另行审核执行，本工具不提供自动提交器。
- 写后先完整 p2 读回并确认固定 SHA，再读回到 PC 运行 `verify`，证明 CRC/key 顺序/其他值/tail 一致。SHA 相同已证明完整字节一致；PC解析给出可审阅的结构证据。
- 重新检查 p1/p4/p5/p6/p7 与原分段 SHA 保持；p2 此时应为新 SHA。保留提交和读回日志。
- 提交正确后才安排独立默认启动捕获：BootROM、ATF 原读取、新 kernel 从0x4000读0x5000 sectors、固定 p8 UUID/tag、无 RAM/debug 参数、网络/SSH/systemd。实际默认启动成功前不标注启动通过。

## 只读目标核验器

`tools/check-environment-from-ram.sh` 含独立可审核的 `tr100_check_environment_digest`、`tr100_check_p2` 函数，并提供只读 CLI。默认仅显示帮助；显式 `--check 固定SHA` 才读真实 p2。它验证 RAM 根/无块挂载、物理几何/节点/sysfs alias 后，用 OpenSSL 读取完整 4MiB 摘要；无写入、saveenv、重启或环境 source/eval。

```sh
/usr/lib/tr100/busybox sh /run/tr100/pure-flash/check-environment-from-ram.sh --check 06ea929120af9e164f5ad6f6845ecff0a720cf25515ce051e6b717a5ff498885
```

成功只报告 `READBACK_VERIFIED ... default_boot_tested=false`。任何失败均停止供父流程检查，不自动恢复或重启。整盘组装器现复用相同两 key 字节策略，接受原存储 MAC，拒绝额外 key 修改/换序/tail 变化；不会把原环境值和运行时 MAC 混淆。
