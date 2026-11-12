.section .rodata
.balign 4
.global tr100_guest_start
.global tr100_guest_end
tr100_guest_start:
    mov w1, #0x4b56
    str w1, [x0]
1:  b 1b
tr100_guest_end:
.section .note.GNU-stack,"",@progbits
