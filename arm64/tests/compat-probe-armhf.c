#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
int main(void) {
    int32_t now32[2] = {0}, zero32[2] = {0};
    struct timespec now;
    if (sizeof(void *) != 4) return 1;
    puts("ARMHF_DYNAMIC_COMPAT_OK pointer_bits=32");
    /* AArch32 raw syscalls: do not let libc/vDSO/time64 hide missing legacy APIs. */
    if (syscall(263, CLOCK_MONOTONIC, now32) != 0) {
        perror("ARMHF legacy clock_gettime32"); return 2;
    }
    if (syscall(265, CLOCK_MONOTONIC, 0, zero32, 0) != 0) {
        perror("ARMHF legacy clock_nanosleep32"); return 3;
    }
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        perror("ARMHF libc clock_gettime"); return 4;
    }
    puts("ARMHF_LEGACY_TIME32_AND_LIBC_CLOCK_OK");
    return 0;
}
