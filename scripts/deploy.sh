#!/usr/bin/env bash
# Deploy without pulling files out from under the running process.
#
# `npm run build` used to write ./build in place while `node build` was still
# running from it: the new manifest named chunks the old process had never
# seen, and every lazy-loaded route 500'd until the restart. Instead each
# deploy builds into builds/<id> - a directory nothing is running from - then
# repoints the `build` symlink in one rename, so the old process's modules stay
# on disk until systemd replaces it.
set -euo pipefail
cd "$(dirname "$0")/.."

id="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
out="builds/$id"

BUILD_OUT="$out" npm run build

# First deploy under this scheme: `build` is still a real directory. Move it
# aside and leave a symlink behind so the running process - which resolved
# build/ to real paths at boot - keeps finding its chunks until the restart.
if [ -d build ] && [ ! -L build ]; then
	mv build "$out-old"
	ln -s "$out-old" build
fi

# A symlink swap is atomic only as a rename: `ln -sfn` unlinks first and leaves
# a window where `build` names nothing at all.
ln -sfn "$out" .build-next
mv -T .build-next build

# Keep the five newest releases plus whatever `build` points at. A release can
# only outlive that when deploys ran without a restart; the running process's
# own directory is the symlink target, which is never pruned.
current="$(readlink build || true)"
for dir in $(ls -1dt builds/*/ 2>/dev/null | tail -n +6); do
	[ "${dir%/}" = "$current" ] || rm -rf "$dir"
done

echo "deployed $out -> build"
if [ -f /etc/systemd/system/openbotlounge.service ]; then
	systemctl restart openbotlounge
	systemctl is-active --quiet openbotlounge && echo "openbotlounge.service is active"
else
	echo "restart the service to run the new build (e.g. systemctl restart openbotlounge)"
fi
