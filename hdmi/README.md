# TR100 HDMI 文字控制台

此目录为本机纯 Linux 系统增加 HDMI 本地登录，不安装桌面。本机已安装正式服务，并通过一次受控软件重启确认服务自动启动、RGB565 模式正确，SSH 与串口正常。用户已确认文字可见、USB 键盘可以 root 登录并输入命令；没有进行物理断电启动验证。原已发布基础刷机镜像不含本目录的后续安装结果。

支持已核验的 `3.18.24_gk6323v100c` 和 `5.10.165_gk6323-tr100-docker` 两个内核，且仍固定为 `tr100-pure-linux-20261111`、根挂载设备号 `259:0` 的 ext4（本方案 p8）。其他内核、RAM 维护系统和旧根分区会被拒绝。本机 fbterm 在 ARGB32 中写入 `00RRGGBB`，alpha 为零会黑屏；这里保持 fb0 的 FD 9 打开，设置并读回核对 RGB565：物理 1280×720、虚拟 1280×2160、16 bpp、`5/11,6/5,5/0,0/0`。不改变内核、DTB、SDK 硬件参数或 eMMC 引导环境。

## 文件与检查

- `bin/tr100-hdmi-console`：Bash wrapper；无参数启动，`--check` 检查身份、程序和设备节点，**不会打开 framebuffer，也不验证当前画面模式**；`--plan` 只输出固定方案，不读取设备或系统身份。
- `systemd/tr100-hdmi-console.service`：multi-user 服务，仅与 `getty@tty1.service` 冲突；失败后 5 秒重启，60 秒最多启动 3 次。
- `tests/hdmi-console.test.cjs`：电脑端离线测试。Windows 需要 Git Bash 和 Node，运行 `node --test hdmi/tests/hdmi-console.test.cjs`。测试只执行 guard、解析及 mock 初始化，不打开真实 framebuffer。

`--check` 成功后，启动仍可能因硬件、VT 或 framebuffer 模式读回失败而停止；查看 journal，不要绕过检查。正常启动执行固定的 `openvt -c 1 -f -s -w`、fbterm 和 `/bin/login` 循环。每次退出登录后会重新显示提示；没有自动登录、不保存密码，也不因无人输入 60 秒就退出整个服务。

## 在已启动的纯 Linux 中手工安装

先保留可用的 SSH 和 ttyAMA0 串口连接。以下命令由操作者在目标机主动执行；不在 RAM 维护系统安装。将本目录上传到目标机后，从源码根目录运行。本次依赖下载约 2.5 MB、新增磁盘占用约 5.5 MB，以实际仓库输出为准：

```sh
sudo apt-get update
sudo apt-get install fbset fbterm fonts-dejavu-core
sudo install -o root -g root -m 0755 hdmi/bin/tr100-hdmi-console /usr/local/sbin/tr100-hdmi-console
sudo install -o root -g root -m 0644 hdmi/systemd/tr100-hdmi-console.service /etc/systemd/system/tr100-hdmi-console.service
sudo /usr/local/sbin/tr100-hdmi-console --plan
sudo /usr/local/sbin/tr100-hdmi-console --check
```

两个检查都成功后，再接管 tty1。若本机仍有本次临时 `tr100-hdmi-rgb565-v2.service`，先停止它；该命令只针对已知临时服务，不是安装依赖：

```sh
sudo systemctl stop tr100-hdmi-rgb565-v2.service
sudo systemctl mask getty@tty1.service
sudo systemctl daemon-reload
sudo systemctl enable --now tr100-hdmi-console.service
sudo systemctl status --no-pager tr100-hdmi-console.service
sudo journalctl -u tr100-hdmi-console.service -b --no-pager
```

只 mask tty1 的 getty，**不要 mask 串口 getty 或修改 ttyAMA0**。若临时服务不存在，第一条 stop 的报错只说明无需停止它。新的服务会设置 RGB565，fbterm 应显示本地 `login:`；用户名和密码由 `/bin/login` 正常校验，本文不记录凭据。

先检查 HDMI 可读文字、USB 键盘输入、普通用户登录/退出/再次登录，再检查 SSH 和串口仍可用。完成这些检查后，操作者可通过正常 `systemctl reboot` 验证自动启动。安装源码和启用服务本身不构成键盘或重启验收通过的证据。不要同时运行其他 fbterm、手工 fbset 或 tty1 getty。

## 停用和卸载

从 SSH 或串口执行，先停止服务再恢复 tty1：

```sh
sudo systemctl disable --now tr100-hdmi-console.service
sudo rm -- /etc/systemd/system/tr100-hdmi-console.service /usr/local/sbin/tr100-hdmi-console
sudo systemctl unmask getty@tty1.service
sudo systemctl daemon-reload
sudo systemctl start getty@tty1.service
```

这恢复 tty1 getty 的管理方式；原厂 framebuffer 模式下的可见性仍取决于驱动，不承诺卸载后 HDMI 显示 Linux 原生 VT。不要自动重启。安装所需软件包可保留，不在卸载中连带删除其他包。

## 原生 Docker 5.10 内核的显示模块

5.10 内核基础镜像没有集成厂商 framebuffer。需要匹配内核的 `gk_media`、`gk_mmz`、`gk_common`、`gk_pdm`、`gk_pq`、`gk_hdmi`、`gk_vou`、`gk_tde`、`gfbg` 九个模块。此次模块从 OpenHarmony Goke SDK 源码编译；内存映射分支改用导出的 `vm_mmap`，并由该 API 自行取得 mmap 锁，解决外部模块无法链接未导出 `do_mmap` 的问题。

`bin/tr100-display-modules` 按依赖顺序加载驱动并检查 fb0 设备号。模块化 Linux 缺少厂商 MCE 启动画面的初始化步骤，单独 start 会使发射器输出开启、PHY 电源却关闭；脚本通过驱动已有的 `/proc/msp/hdmi0` 接口先执行 `clrspace 0` 配置 RGB 视频通路，再执行 `cmd 1` 启动输出，并检查实际 PHY 电源、输出和 RGB 状态。当前使用 HDMI 接口的 RGB/DVI 视频模式，不启用音频或 HDCP。

配套 `systemd/tr100-display-modules.service` 仅在上述 5.10 内核运行，HDMI 服务通过 drop-in 的 Wants/After 依赖它。原 3.18 内核会跳过该模块服务，继续使用原来的内建显示驱动。模块、设备节点、RGB565 模式和 HDMI 登录服务已在 5.10 真机验证，用户已确认能看到登录界面或文字。用户随后授权永久安装；新内核已写入 eMMC p3 并读回校验，必需的 cgroup 启动参数已保存。一次无人干预的正常重启后，模块服务、PHY 电源和输出、RGB565 登录服务、Docker 均已自动恢复，容器外网和 DNS 测试通过。用户已确认最终重启后文字和 USB 键盘均正常；尚未做物理断电验证。

安装与验证须保留 SSH 和串口。不要仅放开版本检查而不安装驱动。不要将 3.18/4.9 的 ko 强行装入 5.10。新内核、模块及启动参数的固化是独立步骤，在完成 RAM 启动验收前不要改写引导分区。

已在上述 5.10 内核运行、九个匹配模块已放入 `/lib/modules/5.10.165_gk6323-tr100-docker/extra/tr100-display/`，并按前文安装控制台后，从仓库根目录安装自动加载与顺序配置：

```sh
sudo install -o root -g root -m 0755 hdmi/bin/tr100-display-modules /usr/local/sbin/tr100-display-modules
sudo install -o root -g root -m 0644 hdmi/systemd/tr100-display-modules.service /etc/systemd/system/tr100-display-modules.service
sudo install -d /etc/systemd/system/tr100-hdmi-console.service.d
sudo install -o root -g root -m 0644 hdmi/systemd/tr100-hdmi-console.service.d/native-5.10.conf /etc/systemd/system/tr100-hdmi-console.service.d/native-5.10.conf
sudo depmod -a
sudo systemctl daemon-reload
sudo systemctl enable tr100-display-modules.service
sudo systemctl restart tr100-display-modules.service tr100-hdmi-console.service
```

## 后台线程空闲等待与 load

厂商日志线程 `g_udisk_task`、HDMI 轮询线程 `HDMI_kThread`、显示事件线程 `DispProcess` 和 framebuffer 后台线程 `pthread_wbc_mem` 原先长期以 D 状态等待，空闲时也会贡献约 4 的 load。`patches/idle-background-waits.patch` 对上述 5.10 SDK 使用 `schedule_timeout_idle` 和 `wait_event_idle_timeout`；毫秒等待保留内核 `msleep` 的取整、额外一 jiffy 和提前唤醒后继续等待的行为，事件条件和超时不变。

补丁针对本次匹配的 SDK，须先编译 common，再以更新后的 common `Module.symvers` 编译显示模块。只需更新 `gk_common.ko`、`gk_hdmi.ko`、`gk_vou.ko`、`gfbg.ko`，备份旧文件、运行 depmod 并正常重启；不需要重新刷写内核或启动参数。实际已完成更新和自动重启，四个线程均进入 I 状态，load 从约 4 降至 0.09。HDMI PHY、RGB565 控制台和 Docker 自动启动，容器外网/DNS 验证通过。

目标机空闲时运行 `sudo sh hdmi/tests/check-driver-idle.sh`，检查四个线程是否处于不计入 load 的空闲等待。此检查读取实际进程状态，不修改 load 统计，也不验证物理画面或键盘输入。
