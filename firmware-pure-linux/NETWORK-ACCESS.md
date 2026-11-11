# 网络和登录

纯 Linux root 沿用已验证 canonical root 的网络/SSH/账户配置，数据构图时只替换纯版 bootstrap/UUID/tag，并更新 clock 与 journal ACL；root 密码 hash、authorized_keys、SSH/inet/普通用户辅助配置保持。

默认通过有线网口 DHCP 获取地址。实际地址请查看父流程本次默认启动/运行日志或路由器租约；不要把 RAM 维护时的静态地址当作永久地址。主机名为 `tr100`。

SSH 账户为 `root`，支持公钥和非空密码认证。公钥已在 root 镜像内；密码由父流程通过独立会话提供，本包不存明文密码或私钥。首次启动持久生成 SSH host keys 与 machine-id，是否在重启后保持须以本包实际运行证据为准。

DHCP、SSH、systemd、NTP、Asia/Shanghai、普通用户网络等状态仅在 `runtime-evidence.json` 引用的实际日志中认定。缺失新版证据时，不把旧 800MiB checkpoint 或 RAM 用户态验证标为纯版 eMMC 实测。
