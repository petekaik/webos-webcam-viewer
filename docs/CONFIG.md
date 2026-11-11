# Configuring cameras and settings

Everything you configure is stored on the TV (in the app's browser storage). There are two ways in.

## By hand

**Settings → Cameras → Add camera.** Each camera has:

| Field | |
|---|---|
| Name | Shown on the tile and in full screen. |
| Stream URL | An HLS playlist, `http://…/index.m3u8`. See [STREAMS.md](STREAMS.md). |
| Preview image URL | Optional. A JPEG that refreshes every 2 s on the grid. Plain `http://`, see below. |

Up to 4 cameras. Typing uses LG's on-screen keyboard (OK on a field opens it; ←/→ move the cursor, ↑/↓
leave the field).

## Import settings: one file, one URL

Typing URLs with a remote is slow. Instead put one JSON file on your own network and load it once:
**Settings → Developer → Import settings**, type its address, choose **Import**.

[`config.example.json`](../config.example.json):

```json
{
  "cameras": [
    { "id": "front", "name": "Front yard", "hls": "http://192.168.0.10/hls/front/index.m3u8", "snapshot": "http://192.168.0.10/snap/front.jpg" },
    { "id": "back",  "name": "Back yard",  "hls": "http://192.168.0.10/hls/back/index.m3u8",  "snapshot": "" }
  ],
  "loggerServer": "",
  "alertsUrl": "",
  "debug": false,
  "confirmExit": true
}
```

Every key is optional, and only the keys present are changed.

| Key | |
|---|---|
| `cameras` | 1–4 cameras. `id`: short unique text. `name`: required. `hls`: required `http(s)` URL. `snapshot`: optional. Replaces the whole camera list. |
| `loggerServer` | `host:port` of a log server for debugging (see [Developer](#settings-reference)); empty turns it off. |
| `alertsUrl` | Base URL of the [alert service](../alerts/README.md), e.g. `http://192.168.0.10:8790`; empty turns it off. |
| `debug` | `true` to send the app's log lines to `loggerServer`. |
| `confirmExit` | Show "Exit Webcam Viewer?" on Back from the grid. |
| `tvAlerts` | `true` to receive motion alerts on the TV itself ([TV-ALERTS.md](TV-ALERTS.md)). |
| `banner` | Show alerts as a banner while the app is open (default `true`). |
| `checkUpdates` | Ask GitHub for the latest release number (default `true`). |

**Hosting the file.** The app fetches it from the TV, and it runs as a local app (`file://`), so the server
must allow cross-origin reads. Any static server with CORS works, for example, on a computer on your network:

```sh
npx http-server -p 8080 --cors .      # serves ./config.local.json at http://<computer-ip>:8080/config.local.json
```

Keep the file private. It lists your camera addresses, so don't publish it, and don't commit it to a public repository.

## Settings reference

| Page | What it does |
|---|---|
| **General** | Confirm exit. |
| **Notifications** | Needs the alert service. On/off, popup or toast, snooze, per-camera, detection types, quiet hours, cooldown, "not while watching", recent alerts. |
| **Cameras** | List with status badges. Edit, move, delete, add (max 4), reset to the public demo. |
| **Developer** | **Debug mode**; **Log server** and **Alert service** addresses (editable, empty = off); **Import settings**; app version and browser engine. |

**Debug mode** sends the app's log lines (screen changes, stream state, errors) over a WebSocket to a log
server you run: `node tools/logger-server.js` prints its address. It is off by default and only connects when
you both switch it on and enter a log server.
