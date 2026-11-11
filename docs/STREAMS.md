# Getting your cameras to the TV

The app plays **HLS** (`.m3u8`) over plain `http://`. Most cameras don't offer that directly, and the TV
is stricter than a desktop browser. This is what worked, and what didn't, on an LG OLED65C8 (webOS 4.4.3,
Chromium 53) with UniFi Protect cameras behind [MediaMTX](https://github.com/bluenviron/mediamtx).

## What the TV needs

| | |
|---|---|
| Playlist | HLS over `http://`. Self-signed `https://` certificates were refused in our earlier tests on this TV. |
| Video | H.264. 1080p at about 1 Mbit/s played fine; higher bitrates are untested. |
| Audio | AAC, muxed into the same segments. |
| Segments | **MPEG-TS** is recommended (MediaMTX `hlsVariant: mpegts`). The low-latency fMP4 variant also played, but hls.js 0.14 (the player in this app) started it 20–40 s behind live. |
| CORS | The app runs from the TV's file system, so browser requests carry `Origin: null`. The server must answer them with `Access-Control-Allow-Origin: *`. |
| Preview images | Optional JPEG over plain `http://`. |

## The usual fix: a small reverse proxy

In our tests (with `curl`) MediaMTX sent no CORS headers for `Origin: null`, and the cameras' still pictures are only
available over HTTPS with their own certificates, which the TV rejects. One nginx in front solves both:
it adds the CORS header to the streams, and re-serves the still pictures as plain HTTP.

```nginx
proxy_cache_path /tmp/snapcache levels=1 keys_zone=snap:1m max_size=10m inactive=1m;

server {
    listen 80;

    # HLS from MediaMTX (port 8888), with the CORS header the TV's file:// app needs.
    # MediaMTX answers with a redirect to an absolute path, so put the /hls/ prefix back on it.
    location /hls/ {
        proxy_pass http://MEDIAMTX_IP:8888/;
        proxy_redirect ~^/(.*)$ /hls/$1;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_hide_header Access-Control-Allow-Origin;
        add_header Access-Control-Allow-Origin * always;
    }

    # Camera stills: the camera's HTTPS snapshot (self-signed) as plain HTTP, cached for 2 s
    # so any number of viewers cost the camera at most one snapshot every 2 s.
    location = /snap/front.jpg {
        proxy_pass https://CAMERA_IP/snap.jpeg;    # your camera's snapshot URL
        proxy_ssl_verify off;
        proxy_connect_timeout 2s;
        proxy_read_timeout 3s;
        proxy_cache snap;
        proxy_cache_valid 200 2s;
        proxy_cache_lock on;
        proxy_cache_use_stale error timeout updating;
        add_header Cache-Control "no-cache" always;
        add_header Access-Control-Allow-Origin * always;
    }
}
```

Then the camera in the app is `http://PROXY_IP/hls/front/index.m3u8` with preview `http://PROXY_IP/snap/front.jpg`.
(The `/snap.jpeg` path is what UniFi cameras use; other cameras differ. Only the stream URL is required;
without a preview URL the tile says "No preview" and live view still works.)

## MediaMTX settings that matter

```yaml
hlsVariant: mpegts        # plain MPEG-TS segments
hlsAlwaysRemux: yes       # keep the muxer warm, for a faster first frame
hlsSegmentDuration: 1s    # segments still follow the camera's keyframes (5 s on our cameras)
```

## Delay behind live

Expect about **10–15 s**. The player (hls.js 0.14) starts two segments back from the live edge. Starting
only one segment back lowered the delay by roughly 3 s, but playback then stalled repeatedly on the
OLED65C8. The floor is the camera's keyframe interval: with 5 s between keyframes a segment cannot be shorter.

## Sound

The streams carry AAC audio and the app plays with sound. If a camera is silent, check that its microphone
is enabled in the camera system. Audio and video are in sync in the stream itself (measured with `ffprobe` on
our segments: audio starts 0.02–0.15 s after video), so any lag you hear is added by the TV.

## Not possible on webOS 4

- WebRTC with modern players (Chromium 53 lacks the API they need).
- More than one live video at a time (LG documents a single video decoder for web apps on webOS 4).
- Drawing over live TV, or running in the background. Motion alerts are therefore a popup with an
  **Open live view** button, see [`../alerts/`](../alerts/README.md).
