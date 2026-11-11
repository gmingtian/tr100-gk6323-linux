#!/bin/sh
set -eu
probe=/root/tproxy-flow-probe-aarch64
r=tr100tpr
c=tr100tpc
cleanup() {
 for ns in "$r" "$c"; do
   ip netns pids "$ns" 2>/dev/null | xargs -r kill 2>/dev/null || :
   ip netns del "$ns" 2>/dev/null || :
 done
}
trap cleanup EXIT INT TERM
cleanup
ip netns add "$r"; ip netns add "$c"
ip link add tpr0 type veth peer name tpc0
ip link set tpr0 netns "$r"; ip link set tpc0 netns "$c"
for ns in "$r" "$c"; do ip -n "$ns" link set lo up; done
ip -n "$r" link set tpr0 up; ip -n "$c" link set tpc0 up
ip -n "$r" addr add 192.0.2.1/24 dev tpr0
ip -n "$c" addr add 192.0.2.2/24 dev tpc0
ip -n "$r" -6 addr add fd00:100::1/64 dev tpr0 nodad
ip -n "$c" -6 addr add fd00:100::2/64 dev tpc0 nodad
ip -n "$c" route add default via 192.0.2.1
ip -n "$c" -6 route add default via fd00:100::1
ip netns exec "$r" sysctl -qw net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.default.rp_filter=0 net.ipv4.conf.tpr0.rp_filter=0
for v in 4 6; do
 ip -n "$r" -"$v" rule add fwmark 1 lookup 100
 if [ "$v" = 4 ]; then prefix=0.0.0.0/0; else prefix=::/0; fi
 ip -n "$r" -"$v" route add local "$prefix" dev lo table 100
done
run_flow() {
 v=$1
 ip netns exec "$r" "$probe" server "$v" > /tmp/tr100-tproxy-server.log 2>&1 &
 srv=$!
 n=0
 until grep -q READY /tmp/tr100-tproxy-server.log; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep .1; done
 ip netns exec "$c" "$probe" client "$v"
 wait "$srv"
}
for v in 4 6; do
 if [ "$v" = 4 ]; then tool=iptables-legacy; else tool=ip6tables-legacy; fi
 ip netns exec "$r" "$tool" -t mangle -A PREROUTING -p udp --dport 18080 -j TPROXY --on-port 15080 --tproxy-mark 1/1
 ip netns exec "$r" "$tool" -t mangle -A PREROUTING -m socket --transparent -j MARK --set-mark 1
 run_flow "$v"
 ip netns exec "$r" "$tool" -t mangle -nvL PREROUTING
 ip netns exec "$r" "$tool" -t mangle -F
 echo "LEGACY_TPROXY_IPV${v}_PASSED"
done
ip netns exec "$r" nft -f - <<'NFT'
table inet tr100test {
 chain prerouting {
  type filter hook prerouting priority mangle; policy accept;
  meta l4proto udp udp dport 18080 counter tproxy to :15080 meta mark set 1 accept
  socket transparent 1 meta mark set 1
 }
}
NFT
run_flow 4
run_flow 6
ip netns exec "$r" nft list table inet tr100test
echo NFT_INET_TPROXY_IPV4_IPV6_PASSED
