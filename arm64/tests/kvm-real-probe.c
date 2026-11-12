#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/kvm.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <sched.h>
#include <signal.h>
extern const unsigned char tr100_guest_start[],tr100_guest_end[];
static void die(const char *s){perror(s);exit(1);}
static void timeout(int sig){(void)sig;const char s[]="REAL_KVM_PROBE_TIMEOUT\n";ssize_t written=write(2,s,sizeof(s)-1);(void)written;_exit(124);}
static void setreg(int fd, uint64_t index,uint64_t value){
 struct kvm_one_reg r={.id=KVM_REG_ARM64|KVM_REG_SIZE_U64|KVM_REG_ARM_CORE|index,.addr=(uintptr_t)&value};
 if(ioctl(fd,KVM_SET_ONE_REG,&r)<0)die("KVM_SET_ONE_REG");
}
#define REG_INDEX(field) (offsetof(struct kvm_regs,field)/sizeof(uint32_t))
int main(void){
 if(sizeof(void*)!=8){fputs("Native AArch64 executable required\n",stderr);return 2;}
 signal(SIGALRM,timeout);alarm(20);
 int k=open("/dev/kvm",O_RDWR|O_CLOEXEC);if(k<0)die("open /dev/kvm");
 int api=ioctl(k,KVM_GET_API_VERSION,0);if(api!=12){fprintf(stderr,"Unexpected KVM API %d\n",api);return 3;}
 int runsize=ioctl(k,KVM_GET_VCPU_MMAP_SIZE,0);if(runsize<(int)sizeof(struct kvm_run))die("KVM_GET_VCPU_MMAP_SIZE");
 for(int cpu=0;cpu<4;cpu++){
  cpu_set_t affinity;CPU_ZERO(&affinity);CPU_SET(cpu,&affinity);if(sched_setaffinity(0,sizeof(affinity),&affinity))die("sched_setaffinity");
  int ipa=ioctl(k,KVM_CHECK_EXTENSION,KVM_CAP_ARM_VM_IPA_SIZE);
  unsigned long vmtype=(ipa>=32&&ipa<40)?(unsigned long)ipa:0;
  int vm=ioctl(k,KVM_CREATE_VM,vmtype);if(vm<0)die("KVM_CREATE_VM");
  size_t size=65536;void *mem=mmap(NULL,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(mem==MAP_FAILED)die("guest mmap");
  memcpy(mem,tr100_guest_start,tr100_guest_end-tr100_guest_start);
  __builtin___clear_cache(mem,(char*)mem+(tr100_guest_end-tr100_guest_start));
  struct kvm_userspace_memory_region region={.slot=0,.guest_phys_addr=0x40000000,.memory_size=size,.userspace_addr=(uintptr_t)mem};
  if(ioctl(vm,KVM_SET_USER_MEMORY_REGION,&region)<0)die("KVM_SET_USER_MEMORY_REGION");
  struct kvm_vcpu_init init={0};if(ioctl(vm,KVM_ARM_PREFERRED_TARGET,&init)<0)die("KVM_ARM_PREFERRED_TARGET");
  int v=ioctl(vm,KVM_CREATE_VCPU,0);if(v<0)die("KVM_CREATE_VCPU");
  if(ioctl(v,KVM_ARM_VCPU_INIT,&init)<0)die("KVM_ARM_VCPU_INIT");
  struct kvm_run *run=mmap(NULL,runsize,PROT_READ|PROT_WRITE,MAP_SHARED,v,0);if(run==MAP_FAILED)die("kvm_run mmap");
  setreg(v,REG_INDEX(regs.pc),0x40000000);setreg(v,REG_INDEX(regs.pstate),0x3c5);setreg(v,REG_INDEX(regs.regs[0]),0x10000000);
  int result;do{result=ioctl(v,KVM_RUN,0);}while(result<0&&errno==EINTR);
  if(result<0)die("KVM_RUN");
  uint32_t data=0;memcpy(&data,run->mmio.data,sizeof(data));
  if(run->exit_reason!=KVM_EXIT_MMIO||run->mmio.phys_addr!=0x10000000||!run->mmio.is_write||run->mmio.len!=4||data!=0x4b56){
   fprintf(stderr,"Unexpected guest exit reason=%u addr=%llx write=%u len=%u data=%x\n",run->exit_reason,(unsigned long long)run->mmio.phys_addr,run->mmio.is_write,run->mmio.len,data);return 4;
  }
  printf("REAL_KVM_GUEST_EXECUTED host_cpu=%d API=%d MMIO=0x%x\n",cpu,api,data);fflush(stdout);
  munmap(run,runsize);close(v);munmap(mem,size);close(vm);
 }
 close(k);alarm(0);puts("REAL_KVM_ALL_FOUR_CPUS_PASSED no_emulation_fallback");return 0;
}
