#!/bin/bash
# Build the chromium53-h264 image: Ubuntu 16.04 Chromium 53.0.2785.143 + H.264 codecs (closest match to the TV engine).
set -e; cd "$(dirname "$0")"
V=53.0.2785.143-0ubuntu0.16.04.1.1254
for p in chromium-browser chromium-codecs-ffmpeg-extra; do
  [ -f $p.deb ] || curl -sL -o $p.deb "https://launchpad.net/ubuntu/+archive/primary/+files/${p}_${V}_amd64.deb"
done
docker build --platform linux/amd64 -t chromium53-h264 .
