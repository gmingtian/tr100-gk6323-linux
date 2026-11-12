#!/bin/bash
# Mount the repository read-only; only a selected workspace directory is writable.
set -euo pipefail
[[ $# -ge 2 ]] || { echo 'Usage: docker-run.sh BUILD_WORKDIR build.py-subcommand [arguments using /work paths]' >&2; exit 2; }
work=$(realpath -- "$1")
shift
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
[[ "$work" != / && "$work" != "$HOME" && -d "$work" ]]
image=tr100-rootfs-tools:bookworm-arm64
# Only provision needs mount namespace/device-node capabilities.
# The Docker socket and host devices/directories are not mounted into the worker.
docker image inspect "$image" >/dev/null 2>&1 || docker build --platform linux/arm64 -t "$image" -f "$repo/arm64/rootfs/Dockerfile" "$repo/arm64/rootfs"
flags=()
if [[ -n ${TR100_ROOTFS_VOLUME:-} ]]; then
    [[ "$TR100_ROOTFS_VOLUME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || { echo 'Invalid build volume name' >&2; exit 2; }
    flags+=(--mount "type=volume,src=$TR100_ROOTFS_VOLUME,dst=/build")
fi
[[ "$1" != provision ]] || flags+=(--cap-add SYS_ADMIN --cap-add MKNOD --security-opt seccomp=unconfined --security-opt apparmor=unconfined)
exec docker run --rm --platform linux/arm64 "${flags[@]}" \
    --mount "type=bind,src=$repo,dst=/src,readonly" \
    --mount "type=bind,src=$work,dst=/work" \
    "$image" "$@"
