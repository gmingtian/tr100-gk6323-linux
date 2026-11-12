# TR100 同硬件配置通用烧写包（预览）

供已经验证的数码视讯 TR100 / GK6323V100C、8GB eMMC、4MiB 原厂 loader 布局使用。
**型号相同不等于硬件相同。助手遇到不同 loader、ATF、布局或无效 MAC 会拒绝继续。**
项目源码：[gmingtian/tr100-gk6323-linux](https://github.com/gmingtian/tr100-gk6323-linux)。

当前包已完成离线测试，尚未用第二台盒子完成 HiTool 导入、烧写和首次启动验证；不能据此认定所有 TR100 批次可刷。

## 准备

- Windows 电脑安装原厂 HiTool、盒子所需 USB 驱动、Python 3.11+（含 Tkinter）。Linux 也可运行助手，但 HiTool 平台支持取决于原厂版本。
- 在电脑执行 `python -m pip install -r requirements.txt`；Windows 可用 `py -3 -m pip install -r requirements.txt`。
- 解压到空间充足的 NTFS/ext4 盘，不能用 FAT32：rootfs.img 的逻辑大小为 7,774,142,464 字节，超过 4GiB。
- 先保存目标盒子的完整原厂备份。助手的 JSON **只保存环境文本、MAC 和分区 CRC，不是完整固件备份**，请私下保管。
- 使用 3.3V TTL，115200、8N1，TX/RX 交叉、GND 相连，不接 TTL 供电线。烧写使用原厂工具要求的连接方式；TTL 用于检查和首次设置。

## 刷写步骤

1. 运行 `start-windows.cmd` / `bash start-linux.sh`，或 `python assistant.py`。
2. 通过助手的“首次设置串口终端”打开 TTL，在开机倒计时时手动发送 Ctrl+C，停在原厂 `fastboot#`，然后关闭终端窗口以释放端口。助手不会自动重启或打断设备。
3. 选择包目录、TTL 串口、一个新的私有 JSON 报告路径，点击“检查并备份”。检查成功后关闭所有占用串口的程序。
4. 在原厂 HiTool 中选 eMMC，导入 `TR100-Universal.xml`，核对**只有 kernel 和 rootfs 被勾选**，各自选择包内 kernel.img 和 rootfs.img。不要勾选 bootargs、不要全盘擦除、不要初始化分区表、不要重写 loader/ATF。使用支持保留未选区域的下载模式。
5. **确认 HiTool 成功写完全部数据**后关闭/断开 HiTool。若工具无法导入 XML、显示 rootfs 大小截断、或报大文件错误，请停止；不要改用全盘擦除。此预览包尚未验证不同 HiTool 版本对超过4GiB文件的处理。
6. 重新在 TTL 停住同一台盒子的原厂 `fastboot#`；选择第3步的同一报告，点击“烧写完成后配置启动”。助手重查原机保护区、内核 CRC 和根分区 UUID，然后只修改 bootargs、bootcmd、verify，校验后才 saveenv。工具完成后不会自动重启。
7. 打开助手串口终端，手动输入 `reset` 并发送，或重新上电。见 `TR100_FIRSTBOOT_PASSWORD_SETUP` 后，按 passwd 的提示输入两次自选 root 密码。输入框默认隐藏，助手不记录终端或密码。没有通用默认密码。
8. 见 `TR100_FIRSTBOOT_COMPLETE` 后自动启动 DHCP、SSH、HDMI 登录和板载 Wi-Fi 驱动。通过路由器 DHCP 列表找 IP，用自己设置的 root 密码登录。SSH 主机密钥和 machine-id 由目标盒子首次生成。

## 保留和替换的内容

| 区域 | 行为 |
|---|---|
| fastboot p1、deviceinfo p4、ATF p5、baseparam p6、pqparam p7 | XML 不勾选；助手检查前后 CRC 一致 |
| bootargs p2 | 不烧写模板；助手通过原厂 setenv/saveenv 只更新三个启动变量，其余变量保留 |
| kernel p3、rootfs p8 | 写入公共镜像，旧系统和数据被替换 |
| 有线 MAC | 首次启动从目标机 p4 前17字节读取、校验，启动联网前应用 |
| Wi-Fi 校准/硬件身份 | 不复制当前盒子身份；保留目标机原厂参数区；驱动使用芯片自身信息。不同无线模块需另行适配 |
| 密码、SSH 主机密钥、machine-id | 不跨机器复制。新机自行设置/生成 |

通用内核的设备树使用占位 MAC `02:00:00:00:00:01`；初次启动的网络被阻塞，读取原机 MAC 后才启动 DHCP，不使用占位 MAC 联网。用户分区中的 Android 应用/配网等旧数据不会保留。
包内不包含原厂引导器、ATF 或每台机器的完整备份。当前布局保持8分区，不重新分区；其他容量或布局需要新硬件配置支持。

## 系统功能

沿用发布版 ARM64 Debian Bookworm、5.10.165 内核、真实 EL2/KVM、TUN/TPROXY、HDMI 文本控制台及低 load 修复、温度、板载 Wi-Fi；常见 USB 网卡、手机共享/蜂窝联网、声卡、UVC 摄像头、存储与光驱支持。具体设备仍取决于芯片和固件。Docker 默认未安装，CPU 保持原频率。

## 校验与重建

`SHA256SUMS` 和 install-manifest.json 记录每个文件的完整大小/哈希。助手在打开串口前验证文件，检查阶段可能需要数分钟读取7GiB镜像。文件哈希不等于发布者签名，请从项目自己的 Release 下载。

源码与构建方法见项目 `arm64/universal/BUILD.md`；系统/内核来源及许可证见项目 `arm64/SOURCES.md` 和主 README。HiTool 本身不随包分发，XML 方言与实际导入仍需对应原厂版本验证。
