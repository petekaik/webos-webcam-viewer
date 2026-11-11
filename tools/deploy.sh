#!/bin/sh
# Package app/ and install + launch it on a TV set up with the webOS CLI (docs/INSTALL.md, Route A).
#   TV=tv sh tools/deploy.sh         TV = the device name you gave ares-setup-device (default: tv)
# The webOS CLI breaks on Node 23+; use Node 20 or 22.
set -e
cd "$(dirname "$0")/.."
TV="${TV:-tv}"

command -v ares-package >/dev/null 2>&1 || {
  echo "webOS CLI not found: npm install -g @webos-tools/cli" >&2
  exit 1
}

# Catch ES6+ syntax and APIs missing in Chromium 53 before packaging: far cheaper than a black screen.
(cd tools/testing && [ -d node_modules/acorn ] || npm install --silent)
node tools/testing/es5-check.js

APP_ID=$(node -p "require('./app/appinfo.json').id")
ares-package app -o build
IPK=$(ls -t build/"${APP_ID}"_*.ipk | head -n 1)
ares-install -d "$TV" "$IPK"
ares-launch -d "$TV" "$APP_ID"
