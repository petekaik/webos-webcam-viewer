# Installing Webcam Viewer on an LG webOS TV

Webcam Viewer is not in the LG Content Store, so you install the `.ipk` package yourself. There are
two routes. **Route A (Developer Mode) works on any webOS TV and needs no rooting.** Route B (Homebrew
Channel) only suits TVs that are already rooted.

The package is `com.petekaik.webcamviewer_<version>_all.ipk`, attached to each
[release](../../../releases). The app id is `com.petekaik.webcamviewer`.

## Route A: Developer Mode (any webOS TV)

**On the TV**

1. Install the **Developer Mode** app from the LG Content Store and sign in with a free
   [LG developer account](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
   (the page also explains the app).
2. In the app, switch **Dev Mode Status** on. The TV restarts. Open the app again.
3. Switch **Key Server** on. Note the TV's **IP address** and the **passphrase** shown on screen.
4. The TV and your computer must be on the same network.

**On your computer**

1. Install [Node.js](https://nodejs.org/) **20 or 22** (see [Troubleshooting](#troubleshooting)), then LG's
   webOS CLI:

   ```sh
   npm install -g @webos-tools/cli
   ```

2. Register the TV (use your own IP and any name; here `tv`):

   ```sh
   ares-setup-device -a tv -i "username=prisoner" -i "host=192.168.0.50" -i "port=9922"
   ares-novacom -d tv -k          # fetches the SSH key; asks for the passphrase from the TV
   ares-setup-device -l           # the TV should be listed
   ```

3. Install and start the app:

   ```sh
   ares-install -d tv com.petekaik.webcamviewer_0.3.1_all.ipk
   ares-launch  -d tv com.petekaik.webcamviewer
   ```

It also appears in the TV's app list. Prefer a graphical tool? The community's
[webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) does the same on Windows, macOS and
Linux; see its README.

The Developer Mode session expires after a while (1000 hours on the TV this was developed on). Open the
Developer Mode app to extend it, or installed apps may stop opening.

**Updating:** install the newer `.ipk` the same way. Check your cameras afterwards, because an update may
reset the saved settings; [re-import them](CONFIG.md).

**Uninstalling:** `ares-install -d tv --remove com.petekaik.webcamviewer`

## Route B: Homebrew Channel (rooted TVs only)

The [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) is a community app store for
webOS. **Installing the Channel itself requires a rooted TV.** Rooting depends on your TV's model and
firmware, and it is at your own risk. See the community's guide at
[webosbrew.org/rooting](https://www.webosbrew.org/rooting). You do **not** need any of this for
Route A, and Webcam Viewer itself needs no root.

If your TV already has the Homebrew Channel, add this project's repository:

1. Open the Homebrew Channel and go to **Settings**.
2. Choose **Add repository** and enter:

   ```
   https://raw.githubusercontent.com/petekaik/webos-webcam-viewer/main/webosbrew/apps.json
   ```

3. Go back to the apps list, open **Webcam Viewer** and choose **Install**.

Or from your computer, with the TV set up as in Route A:

```sh
ares-launch -d tv org.webosbrew.hbchannel -p '{"launchMode":"addRepository","url":"https://raw.githubusercontent.com/petekaik/webos-webcam-viewer/main/webosbrew/apps.json"}'
```

The feed is a static file in this repository (`webosbrew/apps.json`), listing the release `.ipk` with its
checksum. It follows the same format other third-party repositories use, **but it has not yet been tried in a
Homebrew Channel by the author.** If it fails for you, please open an issue.

## First run

The app starts with one public demo stream. Then [add your own cameras](CONFIG.md) and make sure your
camera streams are [reachable by the TV](STREAMS.md).

## Troubleshooting

- **`isDate is not a function`, or `ares-install` / `ares-novacom` fail with odd errors:** the webOS CLI
  does not work on Node 23 or newer. Use Node 20 or 22 (for example with `nvm use 20`).
- **The key step fails:** check that **Key Server** is on in the TV's Developer Mode app, and that the
  passphrase is the one currently shown.
- **The app stopped opening:** the Developer Mode session probably expired. Open the Developer Mode app
  and extend it.
- **Black screen or "Offline" on your camera:** that is the stream, not the install. See
  [STREAMS.md](STREAMS.md).
