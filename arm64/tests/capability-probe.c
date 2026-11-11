#include <fcntl.h>
#include <linux/if.h>
#include <linux/if_tun.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void)
{
    struct ifreq request = {0};
    int one = 1;
    int tun, ipv4, ipv6;

    if (sizeof(void *) != 8)
        return 1;
    tun = open("/dev/net/tun", O_RDWR | O_CLOEXEC);
    if (tun < 0) { perror("open TUN"); return 2; }
    strcpy(request.ifr_name, "tr100probe%d");
    request.ifr_flags = IFF_TUN | IFF_NO_PI;
    if (ioctl(tun, TUNSETIFF, &request) < 0) {
        perror("TUNSETIFF"); close(tun); return 3;
    }
    printf("TUN_CREATE_OK interface=%s\n", request.ifr_name);
    close(tun);
    ipv4 = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (ipv4 < 0 || setsockopt(ipv4, SOL_IP, IP_TRANSPARENT, &one, sizeof(one)) < 0) {
        perror("IP_TRANSPARENT"); return 4;
    }
    close(ipv4);
    ipv6 = socket(AF_INET6, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (ipv6 < 0 || setsockopt(ipv6, SOL_IPV6, IPV6_TRANSPARENT, &one, sizeof(one)) < 0) {
        perror("IPV6_TRANSPARENT"); return 5;
    }
    close(ipv6);
    puts("NATIVE_AARCH64_TUN_TRANSPARENT_SOCKETS_OK pointer_bits=64");
    return 0;
}
