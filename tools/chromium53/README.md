# Chromium 53 in Docker

The TV's browser engine is Chromium 53, and a modern browser hides bugs that only show up there. This
runs the app in a real Chromium 53.0.2785.143 (Ubuntu 16.04 build with H.264), the same engine version.

    tools/chromium53/build.sh     # once: downloads the Chromium packages, builds the image
    tools/chromium53/demo.sh      # then open http://localhost:6080/v14/vnc.html?autoconnect=1&resize=scale

Click in the window and use the arrow keys, Enter (OK) and Escape (Back; the remote's Back key is 461,
which no keyboard has). It is bound to localhost only because the VNC has no password. Stop it with
`docker rm -f c53demo`. On Apple Silicon it runs under amd64 emulation: slow, but it works.

It does not cover the TV's hardware decoder, LG's Luna services, or its audio path.
