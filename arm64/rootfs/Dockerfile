# Docker multiarch emulation or native ARM64; pin the official Debian index.
FROM --platform=linux/arm64 debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 debootstrap debian-archive-keyring ca-certificates e2fsprogs \
    util-linux tar gzip openssh-client openssl curl && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENTRYPOINT ["python3", "/src/arm64/rootfs/build.py"]
