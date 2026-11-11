# Webcam Viewer auto-updater

Keeps the Webcam Viewer app (`com.petekaik.webcamviewer`) on an LG webOS TV
up to date by installing the newest GitHub release with LG's official
`ares-install` CLI.

## Why it runs outside the TV

An app or service running **on the TV cannot install packages**: webOS denies
`Luna appInstallService/dev/install`. So this job runs on any computer or NAS
that can reach the TV over Developer Mode, checks the release feed, and
installs over SSH. Installing over an existing app keeps its saved settings.
Only the running app is replaced, so the job never installs while the app is
in the foreground — it defers instead.

## Requirements

- Node.js 20 or 22 (webOS CLI 3.2.x does not support Node 23+)
- `npm i -g @webos-tools/cli`
- A TV with Developer Mode enabled and the developer CLI paired with it
- `ares-setup-device` and `ares-novacom --device <name> --getkey` run once

## Running directly

```sh
node updater.js                 # loop forever: every 6 h, or retry every 15 min after a deferral
node updater.js --once          # one run, then exit with a status code
node updater.js --dry-run       # fetch, compare, download and verify, but don't install
node updater.js --config /path/to/config.json
```

Logs are one JSON object per line on stdout, e.g.
`{"t":"2026-01-01T00:00:00.000Z","level":"info","msg":"up to date","installed":"0.3.1","feed":"0.3.1"}`.

`--once` exit codes: `0` success or already up to date, `1` refused or failed
install, `2` deferred (TV unreachable, or app currently open).

### cron (every 6 hours)

```cron
0 */6 * * * cd /opt/webcam-updater && node updater.js --once >> updater.log 2>&1
```

### systemd timer

`/etc/systemd/system/webcam-updater.service`:

```ini
[Unit]
Description=Webcam Viewer auto-updater

[Service]
Type=oneshot
WorkingDirectory=/opt/webcam-updater
ExecStart=/usr/bin/node updater.js --once
```

`/etc/systemd/system/webcam-updater.timer`:

```ini
[Unit]
Description=Run the Webcam Viewer auto-updater every 6 hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=6h

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now webcam-updater.timer`.

### launchd (macOS, every 6 hours)

`~/Library/LaunchAgents/com.petekaik.webcam-updater.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.petekaik.webcam-updater</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/webcam-updater/updater.js</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>21600</integer>
  <key>StandardOutPath</key><string>/tmp/webcam-updater.log</string>
  <key>StandardErrorPath</key><string>/tmp/webcam-updater.log</string>
</dict>
</plist>
```

`launchctl load ~/Library/LaunchAgents/com.petekaik.webcam-updater.plist`

## Running in Docker

```sh
docker build -t webcam-updater .
docker volume create webcam-updater
```

Pair with the TV once. The device key is written into the container's `/root`
volume, so it survives container replacement and no host key files are used:

```sh
docker run -it --rm -v webcam-updater:/root webcam-updater sh
# inside the container:
ares-setup-device -a tv -i "username=prisoner" -i "host=<TV IP>" -i "port=9922"
ares-novacom -d tv -k
```

Then run the loop:

```sh
docker run -d --name webcam-updater --restart unless-stopped \
  -v webcam-updater:/root webcam-updater
```

To use a config file, mount it and pass `--config` as the command:

```sh
docker run -d --name webcam-updater --restart unless-stopped \
  -v webcam-updater:/root -v "$PWD/config.json:/config.json:ro" \
  webcam-updater node updater.js --config /config.json
```

## Configuration

All keys are optional; values shown are the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `feed` | `https://raw.githubusercontent.com/petekaik/webos-webcam-viewer/main/webosbrew/apps.json` | Homebrew Channel release feed |
| `appId` | `com.petekaik.webcamviewer` | App to keep updated |
| `device` | `tv` | Device name registered with `ares-setup-device` |
| `intervalHours` | `6` | Wait between normal runs in loop mode |
| `retryMinutes` | `15` | Wait after a deferred run (TV unreachable / app open) |
| `installIfMissing` | `false` | Install the latest release when the app is not installed |
| `aresBin` | `ares-install` | Installer CLI command |
| `launchBin` | `ares-launch` | Launcher CLI command (used to see running apps) |

## Safety rules

- **Feed validation.** A malformed feed, a missing package, or a bad version /
  URL / hash / size is logged and the run stops. Nothing is installed.
- **URL allowlist.** The ipk must match
  `^https://github\.com/[^/]+/[^/]+/releases/download/[^?#]+\.ipk$`.
  Other hosts, plain `http://`, query strings and non-`.ipk` URLs are refused.
- **Download verification.** The ipk is streamed to a temp dir, and both its
  byte size and SHA-256 must match the feed. On mismatch the file is deleted
  and the install is refused. An unverified ipk is never executed.
- **Never while open.** If `ares-launch -d <device> -r` lists the app id, the
  run is deferred. If the running-app check itself fails, the run is also
  deferred rather than risking a foreground install.
- **Newer only.** Versions are compared numerically as `major.minor.patch`
  (any `-suffix` ignored). Equal or older feed versions are a no-op.
- **Temp files.** The downloaded ipk and its temp directory are deleted after
  every attempt, successful or not.

## Limits

- The TV must be powered on, awake, and reachable on the network.
- Developer Mode must be active. Dev Mode sessions expire (LG's developer
  portal lets you renew), after which SSH and `ares-install` stop working
  until the TV is re-authorized.
- The app is replaced by the install; the job avoids the foreground case, so
  an app left open indefinitely will keep the update deferred.
- This job cannot update the TV-side code by itself; it depends on a reachable
  GitHub release feed.

## Tests

```sh
cd updater && node --test
```

Tests use fake `fetch` and `exec` implementations only — no network and no TV.
