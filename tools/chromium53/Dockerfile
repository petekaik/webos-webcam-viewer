FROM --platform=linux/amd64 ubuntu:16.04
COPY chromium-browser.deb chromium-codecs-ffmpeg-extra.deb /tmp/
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    /tmp/chromium-codecs-ffmpeg-extra.deb /tmp/chromium-browser.deb \
    xvfb socat fonts-dejavu-core fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/* /tmp/*.deb
