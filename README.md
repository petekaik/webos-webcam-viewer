# Webcam Viewer for LG webOS TV

Watch your IP / security cameras live on an LG webOS TV, with nothing but the remote.

> Unofficial. Not affiliated with or endorsed by LG Electronics. Early release (0.3.x).

- **Live video with sound** from HLS streams, 1–4 cameras. In full screen, **←/→** switch cameras.
- **Grid with live status**: still previews and a Live / Loading / No preview badge per camera.
- **Built for the remote**: D-pad and Magic Remote, LG's on-screen keyboard for settings, themed scrollbars.
- **Settings menu**: Cameras, Notifications, General, Developer. Optional "Confirm exit" dialog.
- **Motion alerts (optional)**: a popup over live TV with an **Open live view** button, triggered by
  your home automation or camera system. See [`alerts/`](alerts/README.md).
- **Private by design**: your cameras and settings live only in the TV's browser storage. The app ships
  with one public demo stream, no account, no analytics, no cloud. It talks only to the hosts you enter.
- **Plain ES5, no build step**: runs on webOS 4's Chromium 53, where modern frameworks fail to start.

Tested on an LG OLED65C8 (webOS 4.4.3). It should run on newer webOS TVs too, but that is untested.

## Install

Short version: enable **Developer Mode** on the TV, then install the `.ipk` from the
[latest release](../../releases/latest) with LG's `ares-install`. Step by step, plus the Homebrew
Channel route for rooted TVs: **[docs/INSTALL.md](docs/INSTALL.md)**.

## First run

1. Open **Webcam Viewer**. It shows a public demo stream, to prove the TV can play video.
2. Add your cameras: **Settings → Cameras → Add camera**, or load a prepared file in one go with
   **Settings → Developer → Import settings** ([how](docs/CONFIG.md)).
3. Your camera must offer an HLS stream the TV can reach. Most need a small proxy first:
   see [docs/STREAMS.md](docs/STREAMS.md).

## Remote control

| Key | Camera grid | Full screen |
|---|---|---|
| ← → ↑ ↓ | move | ← → previous / next camera |
| OK | open camera, or Settings (gear) | retry when reconnecting |
| Back | exit (asks first, unless switched off) | back to the grid |

## Known issues

- **Audio can lag behind the picture** on some TVs. On the LG OLED65C8 the streams themselves were in sync
  (checked with `ffprobe`), so the delay comes from the TV's playback. Try the TV's AV-sync setting.
- **About 10–15 s behind real time.** The player starts two 5-second segments back from the live edge,
  because starting closer made playback stall on the OLED65C8. See [docs/STREAMS.md](docs/STREAMS.md).
- **Motion alerts cannot carry a picture** on webOS 4.4 firmware 05.50.70: toasts with an image were silently
  dropped. Alerts are text plus an "Open live view" button.
- **After updating the app, check your cameras.** Updating over an installed copy may reset the saved
  settings. Keep your import file handy; re-importing takes seconds.

## Privacy

Everything you configure stays on the TV. Nothing is sent anywhere except the requests you would expect:
to your stream URLs, your preview-image URLs, your alert service, and (only if you switch **Debug mode**
on and enter a log server) log lines to that server. There are no analytics or update checks.

## Development

```
node tools/testing/es5-check.js           # fails on anything Chromium 53 can't parse or lacks
cd tools/testing && npm install && npx playwright test
cd alerts && node --test
```

- `app/` is the whole app: `index.html`, `css/`, `js/app.js`, vendored hls.js 0.14.17. No transpiler.
- Everything must be ES5, with no CSS variables, flex `gap` or grid (`es5-check.js` enforces the syntax).
- `tools/chromium53/` runs the app in a real Chromium 53 in Docker, the same engine version as the TV.
- `tools/deploy.sh` packages and installs it with the webOS CLI.

## Licence

MIT, see [LICENSE](LICENSE). Bundles [hls.js](https://github.com/video-dev/hls.js) 0.14.17
(Apache-2.0, see `app/js/vendor/`). "LG" and "webOS" are trademarks of their owners.
