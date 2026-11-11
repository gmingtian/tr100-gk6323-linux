.section .text
.global _start
_start:
    mov x0, #1
    adr x1, message
    mov x2, #message_end-message
    mov x8, #64
    svc #0
    mov x0, #0
    mov x8, #93
    svc #0
message:
    .ascii "TR100_NATIVE_AARCH64_EXEC_OK\n"
message_end:
