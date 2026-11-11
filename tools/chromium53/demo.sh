#!/bin/bash
# Interactive Chromium 53 demo of the app in the browser: http://localhost:6080/v14/vnc.html?autoconnect=1&resize=scale
# Bound to localhost only (the VNC has no password). Stop with: docker rm -f c53demo
set -e
D=$(cd "$(dirname "$0")" && pwd); W=${TMPDIR:-/tmp}/chromium53-demo; mkdir -p $W
docker image inspect chromium53-demo >/dev/null 2>&1 || docker build -q --platform linux/amd64 -f $D/Dockerfile.demo -t chromium53-demo $D
if [ ! -f $W/novnc/v14/vnc.html ]; then
  rm -rf $W/novnc && mkdir -p $W/novnc/v14
  curl -sL https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz | tar -xz -C $W/novnc/v14 --strip-components=1
  # Ubuntu 16.04's websockify needs the 'binary' subprotocol, which noVNC 1.4 no longer sends.
  sed -i '' 's/new WebSocket(uri, protocols)/new WebSocket(uri, (protocols \&\& protocols.length) ? protocols : ["binary"])/' $W/novnc/v14/core/websock.js
fi
rm -rf $W/app && cp -R "$D/../../app" $W/app
sed -i '' "s/var LOGGER_HOST = '[^']*';/var LOGGER_HOST = 'host.docker.internal';/" $W/app/js/app.js
docker rm -f c53demo >/dev/null 2>&1 || true
docker run -d --name c53demo --platform linux/amd64 -p 127.0.0.1:6080:6080 -v $W/app:/app:ro -v $W/novnc:/novnc:ro chromium53-demo sh -c '
rm -f /tmp/.X99-lock; Xvfb :99 -screen 0 1920x1080x24 >/dev/null 2>&1 & export DISPLAY=:99; sleep 3
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet >/tmp/vnc.log 2>&1 &
websockify --web /novnc 6080 127.0.0.1:5900 >/tmp/ws.log 2>&1 &
while true; do chromium-browser --no-sandbox --no-first-run --kiosk --window-size=1920,1080 --window-position=0,0 --user-data-dir=/tmp/p --disable-gpu --allow-file-access-from-files --disable-infobars file:///app/index.html >/dev/null 2>&1; sleep 1; done' >/dev/null
for i in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' localhost:6080/v14/vnc.html)" = 200 ] && break; sleep 3; done
echo "Open: http://localhost:6080/v14/vnc.html?autoconnect=1&resize=scale&reconnect=1"
