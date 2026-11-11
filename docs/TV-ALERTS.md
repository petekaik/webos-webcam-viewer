# Motion alerts received by the TV itself

Webcam Viewer can receive motion alerts directly, with no extra server. A small service bundled with the
app (`service/`) listens on the TV, applies your do-not-disturb rules, and shows the alert:

- **While the app is open:** a **banner** over whatever you are watching. **OK** opens that camera,
  **Back** dismisses it. (A pointer click on the banner also opens the camera.)
- **While the app is closed:** a **toast** on the TV. Select it and Webcam Viewer opens on that camera.

```
home automation / camera system        TV (this app's service, port 8791)
  POST /motion?camera=front&type=person&token=...  ->  token check, do-not-disturb rules
                                                          |-- app open:   banner in the app
                                                          `-- app closed: toast -> opens the camera
```

Anything that can send an HTTP request can trigger it: Homey, Home Assistant, Node-RED, a camera system's
webhooks, `curl`.

## Set it up

1. Install the app with its service (the `.ipk` from the releases contains both, see [INSTALL.md](INSTALL.md)).
2. In the app: **Settings → Notifications → Alert source**, press OK so it reads **This TV**.
3. The page now shows where to send alerts, for example:

   ```
   POST http://192.168.0.13:8791/motion?camera=front&type=person
   token=1a2b3c4d5e6f7a8b    (camera ids: front, back)
   ```

   The address and token are specific to your TV. Give the TV a fixed IP in your router, so the URL stays valid.
4. Press **Send test**: you should see a banner at once (or a toast if you leave the app first).
5. Point your automation at that URL, one request per camera. `camera` is the camera's **id** from
   Settings → Cameras, and `type` is optional (`person`, `vehicle`, `animal` or `motion`, the default).

Homey: a Flow per camera, WHEN the camera detects motion, THEN an HTTP request, method POST, to the URL above.
Home Assistant:

```yaml
rest_command:
  tv_motion_alert:
    url: "http://<tv-ip>:8791/motion?camera={{ camera }}&type={{ type }}&token=!secret tv_alert_token"
    method: post
```

The reply says what happened: `{"ok":true,"reason":"ok","sent":true,"via":"banner"}`, or why not:
`unauthorized` (401), `unknown-camera` (400), `disabled`, `camera-disabled`, `type-disabled`, `snoozed`,
`quiet-hours`, `cooldown`, `toast-failed`.

## Do-not-disturb

Settings → Notifications has the same rules as the [network alert service](../alerts/README.md): master
switch, per-camera switches, detection types, snooze, quiet hours (in the TV's local time), cooldown per camera
(several webhooks within a moment, which camera systems often send, produce one alert), and a list of recent
alerts. **In-app banner: off** makes alerts toasts even while you watch.

## What it can't do

- **No popup with buttons.** webOS 4.4 denies the system popup to bundled services, so the alert is a toast
  that opens the camera when selected. The [network alert service](../alerts/README.md) can show the popup.
- **No picture in the alert.** Toasts that carry an image were silently dropped on the TV this was tested on.
- **The TV must be on.** Nothing is queued while it is off.
- **It starts with the app.** The service is started by Webcam Viewer, so after a TV restart open the app once
  (it can be closed straight away; the service keeps running).
- **It's an unauthenticated port on your LAN, protected by the token.** Don't forward it to the internet.
  Anyone on your network who knows the token can trigger alerts.

## Notes for developers

The service is plain ES5 for the TV's Node 0.12 (`service/`, no dependencies). It stays alive with an
ActivityManager activity (without one, webOS stops a service 5 seconds after its last request), stores its state in
`/media/internal/webcam-viewer/alerts.json`, and the app talks to it over Luna (`configure`, `settings`,
`putSettings`, `snooze`, `status`, `events`, `test`). The logic is in `service/lib/` and unit-tested off the TV:
`cd service && node --test`.
