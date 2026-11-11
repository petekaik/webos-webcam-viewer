# Motion alerts on the TV

A small LAN service that turns "motion detected" events into an alert on your LG TV: a popup over whatever
is on screen with an **Open live view** button that opens Webcam Viewer on that camera. Triggers can come from
home automation (Homey, Home Assistant, Node-RED, ...) or from a camera system's webhooks (for example UniFi
Protect's Alarm Manager). It is optional: the app works without it.

## How it works

```
home automation / camera system
        |  POST /motion?camera=front&type=person&token=<token>
        v
alerts service (:8790)
  |-- constant-time token check
  |-- do-not-disturb rules (master, camera, type, snooze, quiet hours, cooldown)
  |-- foreground-app check (suppress while the viewer app is open)
  `-- SSAP over WebSocket ws://<tv>:3000
        |
        v
LG TV popup, drawn over live TV
  "Front: Person detected"   [Open live view]  [Dismiss]
  Open live view -> appId com.petekaik.webcamviewer, params { camera: "front", source: "alert" }
        |
        v
Webcam Viewer opens that camera full screen
```

The TV is contacted for each alert; there is no persistent connection and no
queue. If the TV is off or unreachable the alert is logged and dropped.

## Running it

Node 22 or newer. There are no npm dependencies, so no `npm install` step. (`ffmpeg` is only needed
for the optional toast picture, see [Known limits](#known-limits).)

With Docker:

```sh
docker build -t webcam-alerts ./alerts
docker run -d --name webcam-alerts --restart unless-stopped \
  -p 8790:8790 \
  -v /srv/webcam-alerts:/data \
  webcam-alerts
```

The container writes `config.json`, `settings.json` and `client-key` to the
mounted volume. On first run it creates `config.json` with a random webhook
token and `settings.json` with the defaults below.

Read the token (the service also prints it at startup):

```sh
docker logs webcam-alerts | grep token
# or
cat /srv/webcam-alerts/config.json
```

Without Docker:

```sh
cd alerts
ALERTS_DATA_DIR=./data node server.js
```

`PORT` (default `8790`), `HOST` (default `0.0.0.0`) and `ALERTS_DATA_DIR`
(default `/data`) may be overridden with environment variables.

### `config.json`

Created on first run, with placeholder addresses. Edit it, then restart the service:

```json
{
  "tv": { "host": "192.168.0.50", "port": 3000 },
  "appId": "com.petekaik.webcamviewer",
  "token": "<random, generated on first run>",
  "cameras": {
    "front": { "name": "Front", "snapshot": "http://192.168.0.10/snap/front.jpg", "rtsp": "rtsp://192.168.0.10:8554/front" },
    "back":  { "name": "Back" }
  },
  "toastIcon": false,
  "iconSize": 80
}
```

| Key | Meaning |
| --- | --- |
| `tv.host`, `tv.port` | LG TV address and SSAP port (3000). Give the TV a fixed IP. |
| `appId` | App opened by the alert and checked for "already viewing". |
| `token` | Secret in the webhook URL. Keep it secret; anyone with it can trigger alerts. |
| `cameras` | Map of camera id to display name. The id is the `camera=` query value, and must match the camera ids you use in the app. `snapshot` and `rtsp` are only used for the optional toast picture. |
| `toastIcon` | `false` (default): text-only alerts. See [Known limits](#known-limits). |
| `iconSize` | Square PNG size in pixels for the toast picture, when enabled. |

Restart the service after editing `config.json`.

## First-time TV pairing

The first connection has no `client-key`, so webOS shows a pairing prompt on
the TV. Accept it with the remote; the returned key is saved to
`/data/client-key` and later alerts register silently.

Trigger a test toast:

```sh
curl -X POST 'http://<service-ip>:8790/test?camera=front&token=<token>'
```

Accept the prompt within 75 seconds. While waiting for the first approval the
service allows 75 seconds; normal alerts use a 3-second connect timeout. If the
prompt does not appear, check that the TV is on, on the same LAN, and reachable
on port 3000. The test endpoint is the easiest repeatable check.

## Triggering from home automation

Any system that knows "motion detected" can trigger an alert with one HTTP request. The service applies
the do-not-disturb rules and shows the alert on the TV.

```
POST http://<service-ip>:8790/motion?camera=<camera-id>&type=<person|vehicle|animal|motion>&token=<token>
```

`type` is optional (default `motion`). No body is needed. The token is in `config.json` (also printed at startup).

**Homey:** one Flow per camera:
- **WHEN** the camera's "Motion detected" (or person detected) card fires
- **THEN** an HTTP request card: method **POST**, the URL above with that camera's id

Homey Pro's built-in web-request card works, or the "HTTP request flow cards" app on older Homeys.

**Home Assistant:**

```yaml
rest_command:
  tv_motion_alert:
    url: "http://<service-ip>:8790/motion?camera={{ camera }}&type={{ type }}&token=!secret webcam_alerts_token"
    method: post
# action in an automation:
#   - action: rest_command.tv_motion_alert
#     data: { camera: front, type: person }
```

**Alert style** (`style` in settings; also in the app under Settings → Notifications):

- **`popup`** (default): a popup over whatever is on screen, with **Open live view** and **Dismiss** buttons.
- **`toast`**: a small corner notification; select it to open the camera.

Both open Webcam Viewer on that camera. In the app, point it at the service under
**Settings → Developer → Alert service**.

## Setting up each Protect alarm (alternative to home automation)

In UniFi Protect, for each camera:

1. Open **Alarms** (Alarm Manager) and create an alarm.
2. Choose the camera and the detection that should trigger it (person,
   vehicle, animal, motion).
3. Add an action of type **Webhook**.
4. Set the URL to:

   ```
   http://<alerts-host>:8790/motion?camera=<camera-id>&token=<token>
   ```

   `<camera-id>` must be a key in `config.cameras`, for example `front`.
5. Save and enable the alarm.

The service takes the camera from the URL. The JSON body is optional; when
Protect sends `alarm.triggers[0].key` the key becomes the label (person,
vehicle, animal or motion). Any other key is labelled Motion.

Protect's own **Test** button sends a different payload from a real alarm, so
use `/test` (above) or a real trigger to verify the toast.

## Do-not-disturb

Settings live in `/data/settings.json`, are loaded at startup and can be
changed over HTTP without a restart. `PUT /settings` replaces the whole
document, so read it first, edit it, then send it back.

Defaults:

```json
{
  "enabled": true,
  "cameras": { "front": true, "back": true },
  "quietHours": { "enabled": false, "start": "23:00", "end": "07:00" },
  "cooldownSeconds": 120,
  "snoozeUntil": 0,
  "suppressWhileViewing": true,
  "types": { "person": true, "vehicle": true, "animal": false, "motion": true },
  "timezone": "UTC"
}
```

`timezone` is set from the host's timezone on first run. The Docker image runs in UTC; set your zone with
`-e TZ=Europe/London` (before the first run), or change the setting afterwards.

| Setting | Effect |
| --- | --- |
| `enabled` | Master switch. `false` suppresses every alert. |
| `cameras` | Per-camera switch. A camera is enabled unless set to `false`. |
| `types` | Per-detection switch for `person`, `vehicle`, `animal`, `motion`. |
| `snoozeUntil` | Epoch milliseconds; alerts are suppressed while `now < snoozeUntil`. Use `POST /snooze` rather than editing it by hand. |
| `quietHours` | `start` is inclusive, `end` exclusive. Windows crossing midnight (for example 23:00 to 07:00) work. A window with equal start and end means never. |
| `timezone` | IANA timezone used to evaluate quiet hours. |
| `cooldownSeconds` | Minimum seconds between toasts for the same camera. Measured from the last toast actually sent. `0` disables. |
| `suppressWhileViewing` | Skip the alert when the TV's foreground app is `appId`. You are already watching. |

Rules are checked in this order, and the first match wins:

1. master switch off
2. camera disabled
3. detection type disabled
4. snoozed
5. quiet hours
6. per-camera cooldown
7. already viewing (needs the TV, so it is checked by the service after the
   local rules)

Snooze for two hours:

```sh
curl -X POST http://<service-ip>:8790/snooze \
  -H 'Content-Type: application/json' -d '{"minutes":120}'
```

Clear it:

```sh
curl -X POST http://<service-ip>:8790/snooze \
  -H 'Content-Type: application/json' -d '{"minutes":0}'
```

## API

Base URL `http://<service-ip>:8790`. All responses are JSON. CORS is `*`, which
also covers the `null` origin used by a webOS app loaded from a file. Every
endpoint except `/settings`, `/snooze` and `/status` requires the webhook token.

| Method and path | Result |
| --- | --- |
| `POST\|GET /motion?camera=<id>&token=<t>` | `202` with `{ ok, reason, camera, type, sent, message? }`. `401` for a bad or missing token, `400` for an unknown camera. |
| `GET /settings` | The current settings object. |
| `PUT /settings` | Full replacement, validated. `200 { ok, settings }` or `400 { ok:false, error, errors }`. Unknown keys, wrong types, unknown timezones and cameras not present in `config.json` are rejected. |
| `POST /snooze` | Body `{ "minutes": <number> }`. `0` clears. Returns `{ ok, snoozeUntil }`. |
| `GET /status` | `{ ok, events }`, the last 20 events, newest first. Each event has `at`, `camera`, `type`, `reason`, `sent` and `ms`. In memory only; reset by a restart. |
| `POST /test?camera=<id>&token=<t>` | Sends `"<Camera>: Test notification"` and skips all do-not-disturb rules. `200` when sent, `502` when the TV is unreachable or the toast fails. |
| `OPTIONS <path>` | CORS preflight, `204`. |

`reason` in a `/motion` response is one of:

| Reason | Meaning |
| --- | --- |
| `ok` | Rules passed and the toast was sent. |
| `disabled` | Master switch off. |
| `camera-disabled` | That camera is off in settings. |
| `type-disabled` | That detection type is off in settings. |
| `snoozed` | Snooze is active. |
| `quiet-hours` | Inside the quiet window. |
| `cooldown` | Too soon after the last toast for this camera. |
| `viewing` | The webcam app is in the foreground. |
| `tv-unreachable` | Could not connect or register with the TV. |
| `toast-failed` | The TV connection worked but the toast request failed. |

Examples:

```sh
curl -X POST 'http://<service-ip>:8790/motion?camera=front&token=<token>'
curl 'http://<service-ip>:8790/status'
curl 'http://<service-ip>:8790/settings'
```

## Tests

```sh
cd alerts && node --test
```

The suite runs without a TV. It includes a mock SSAP WebSocket server, unit
tests for every do-not-disturb rule (including a midnight-crossing quiet
window and cooldown expiry), end-to-end HTTP tests (good and bad tokens,
cooldown, foreground suppression, unreachable TV), and an optional ffmpeg test
that is skipped when `ffmpeg` is not installed.

## Known limits

- **A popup, not live video.** webOS 4.4 does not let a third-party app draw over live TV or run in the
  background, so a real picture-in-picture window is not possible. The popup with **Open live view** is the
  closest equivalent.
- **No picture in the alert on webOS 4.4.** Tested on an OLED65C8 (webOS 4.4.3, firmware 05.50.70): toasts that
  carry an image (`iconData`) are silently dropped: the TV sends no reply and nothing appears, at 80 px and
  40 px, with or without a click action. Text-only alerts work, so `toastIcon` is `false` by default. Newer
  webOS versions may behave differently: set `"toastIcon": true` in `config.json` to try. The picture then comes
  from the camera's `snapshot` URL, falling back to one frame grabbed with `ffmpeg` from `rtsp`.
- **The TV must be on and reachable.** Alerts are dropped when it is off,
  waking, or off the network. Nothing is queued for later.
- **The TV connection is short-lived.** Every alert connects, registers, sends
  and disconnects, with a 3-second connect timeout.
- **First pairing needs a human.** Until the prompt is accepted and the
  `client-key` is saved, alerts cannot be delivered.
- **Protect's test button is not representative.** It sends a different
  payload from real alarms. Use the `/test` endpoint.
- **Camera ids come from the URL.** A typo returns `400 unknown-camera`; it
  does not guess from the Protect payload.
- **Settings, snooze and status are unauthenticated.** They are meant for the
  LAN and for the webcam app. Only `/motion` and `/test` are protected by the
  token. Firewall the port if the network is not trusted.
- **Alert text is one line and limited to 60 characters.** Longer messages
  are trimmed with an ellipsis.
