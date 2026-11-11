#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
int main(int argc,char **argv) {
 if(argc!=3)return 2;
 int family=atoi(argv[2])==6?AF_INET6:AF_INET;
 int server=!strcmp(argv[1],"server"),s=socket(family,SOCK_DGRAM,0),one=1;
 struct timeval tv={8,0}; char buf[128]={0}; struct sockaddr_storage addr={0},peer={0}; socklen_t len;
 if(s<0)return 3;
 if(setsockopt(s,SOL_SOCKET,SO_RCVTIMEO,&tv,sizeof(tv)))return 4;
 if(server && setsockopt(s,family==AF_INET?SOL_IP:SOL_IPV6,family==AF_INET?19:75,&one,sizeof(one))){perror("transparent");return 5;}
 if(family==AF_INET){struct sockaddr_in *a=(void*)&addr;a->sin_family=AF_INET;a->sin_port=htons(server?15080:18080);inet_pton(AF_INET,server?"0.0.0.0":"198.18.0.99",&a->sin_addr);len=sizeof(*a);}
 else {struct sockaddr_in6 *a=(void*)&addr;a->sin6_family=AF_INET6;a->sin6_port=htons(server?15080:18080);inet_pton(AF_INET6,server?"::":"2001:db8:99::99",&a->sin6_addr);len=sizeof(*a);}
 const char *msg="TR100_TPROXY_REAL_TRAFFIC_OK";
 if(server){if(bind(s,(void*)&addr,len)){perror("bind");return 6;} puts("READY");fflush(stdout);len=sizeof(peer);int n=recvfrom(s,buf,sizeof(buf),0,(void*)&peer,&len);if(n!=(int)strlen(msg)||memcmp(buf,msg,n)){perror("server receive");return 7;}if(sendto(s,msg,strlen(msg),0,(void*)&peer,len)!=(int)strlen(msg))return 8;}
 else {if(sendto(s,msg,strlen(msg),0,(void*)&addr,len)!=(int)strlen(msg)){perror("send");return 9;}len=sizeof(peer);int n=recvfrom(s,buf,sizeof(buf),0,(void*)&peer,&len);if(n!=(int)strlen(msg)||memcmp(buf,msg,n)){perror("client receive");return 10;}printf("%s ipv%d\n",msg,family==AF_INET?4:6);}
 close(s);return 0;
}
