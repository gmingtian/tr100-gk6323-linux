# Android内核的联网权限适配

原厂内核仍启用 `CONFIG_ANDROID_PARANOID_NETWORK`。这里通过inet GID3003配置兼容Debian账户，没有删除内核选项，也没有放宽全部系统服务、关闭沙箱或新增CAP_NET_RAW。

父任务的 `../serial-logs/network-permission-runtime-inventory.txt` 已盘点现有INET角色：root运行的SSH/DHCP/wpa不受此组限制；_apt UID42与systemd-timesync UID996已使用主GID3003并分别实测APT/NTP；messagebus仅使用Unix套接字、rsyslog为root，没有现存普通UID>=1000账户。networkd/resolved保持mask。

## 新普通用户

源cache的 `/etc/adduser.conf` 没有active override，默认额外组是users。本层保留完整原配置，追加：

```ini
EXTRA_GROUPS="users inet"
ADD_EXTRA_GROUPS=1
```

因此Debian `adduser NAME` 创建的新普通用户自动加入inet，同时保留users。既有默认权限、每用户主组和其他设置不变。[Debian Bookworm adduser.conf手册](https://manpages.debian.org/bookworm/adduser/adduser.conf.5.en.html)明确这两个选项只影响新建non-system用户。直接调用低层useradd、systemd-sysusers或包内自建用户不会自动获得此配置，不宣称这些路径已全部覆盖。管理员若另有EXTRA_GROUPS自定义列表，应保留原列表再追加inet。

## 明确授权已有本地用户

```sh
tr100-enable-network alice
```

工具要求root，仅读取本机passwd/group确认用户，拒绝root、UID0别名、未知/重复/非法用户名及inet非3003或GID冲突。默认执行 `usermod -a -G inet`，保留其他附加组与原主GID。用户应重新登录，已有进程不会凭空获得新组。

对于已确认会主动清空附加组的daemon，管理员可明确执行：

```sh
tr100-enable-network --primary SERVICEUSER
```

这会执行标准 `usermod -g inet`，保留UID与其他passwd字段，但会改变主组权限语义，usermod也可能调整该用户home内原主组文件的组归属。不是自动判断或对所有system用户批量使用；已有daemon需重启。APT与timesyncd的此类行为已有源码和实测证据，未来服务须先检查实际UID/GID/Groups、unit及daemon降权方式。

只读验证接口：`tr100-enable-network --check-files PASSWD GROUP [--primary] USER`。仅验证给定账户数据库快照并打印计划，不执行usermod；不要求root，不支持修改其他root目录的账户文件。

## 构建与验证

本需求只需在静态canonical镜像中更新 `/etc/adduser.conf`（0644）和 `/usr/local/sbin/tr100-enable-network`（0755/root:root）。原镜像inet组与已修复服务账户保持不变；不需要从在线根复制状态，不需要添加APT安装hook。

离线执行 `node tests/network-access.test.cjs`：验证users默认保留、helper语法、默认/显式primary计划、合法账户及多种恶意/冲突输入拒绝；不会改主机账户或网络。父任务另在可丢弃RAM根通过真实adduser和新用户DNS/HTTPS验证，此类实测结果应单独记录。
