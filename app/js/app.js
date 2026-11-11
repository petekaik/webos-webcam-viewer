/* Webcam Viewer — plain ES5 for webOS 4.4 / Chromium 53.
   No const/let/arrow/class/async/template literals anywhere. No build step.

   Remote: native focusable <button> tiles, :focus CSS, document keydown
   (LG keyCodes: 37/38/39/40 arrows, 13 OK, 461 Back). */

(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Public defaults only. A user's cameras and addresses live only in this
     TV's localStorage: entered in Settings, or loaded once with Settings ·
     Developer · Import settings (a JSON file on their own network).
     ------------------------------------------------------------------ */

  /* Set true to exercise the app against tools/testing/mock-camera-server.js
     on a laptop instead of the real cameras. */
  var DEV_MOCK = false;
  var DEV_MOCK_HLS_BASE = 'http://127.0.0.1:8888';
  var DEV_MOCK_SNAPSHOT = 'https://127.0.0.1:8889/snap.jpeg';

  /* ------------------------------------------------------------------ */

  var APP_ID = 'com.petekaik.webcamviewer';
  var APP_VERSION = '0.4.0';

  /* The service bundled with this app (service/): receives motion alerts on the TV itself. */
  var TV_SERVICE_ID = APP_ID + '.service';

  /* Release feed (Homebrew Channel format) used for the "update available" check. */
  var UPDATE_FEED_URL = 'https://raw.githubusercontent.com/petekaik/webos-webcam-viewer/main/webosbrew/apps.json';
  var UPDATE_CHECK_INTERVAL_MS = 12 * 3600 * 1000;

  /* First-run camera list: one public demo stream (H.264 MPEG-TS, CORS open), so a fresh
     install shows something playable. Replaced by the user's own list once they edit or import. */
  var CAMERAS = [
    { id: 'demo', name: 'Demo · Big Buck Bunny', hls: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', snapshot: '' }
  ];

  /* Camera list persistence (Settings screen). Camera objects are
     { id, name, hls, snapshot }; snapshot may be ''. DEV_MOCK rewrites the
     runtime URLs only — the stored list always keeps the real ones. */
  var STORAGE_KEY = 'webcamviewer.cameras.v1';
  var MAX_CAMERAS = 4;

  var SNAPSHOT_INTERVAL_MS = 2000; /* webcam-web caches stills for 2 s */
  var SNAPSHOT_TIMEOUT_MS = 4000;
  var CONNECTION_TIMEOUT_MS = 8000;
  var LOG_QUEUE_MAX = 200;
  var DIRS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

  /* Last-resort HLS source if app/js/vendor/hls.js is missing. Pinned to
     the same pre-ES6-class release. The TV should normally be offline. */
  var HLS_CDN_FALLBACK = 'https://cdn.jsdelivr.net/npm/hls.js@0.14.17/dist/hls.min.js';

  function ensureHlsAvailable() {
    var script;
    if (window.Hls) {
      return;
    }
    try {
      script = document.createElement('script');
      script.async = true;
      script.src = HLS_CDN_FALLBACK;
      script.onerror = function () {
        console.error('[hls] CDN fallback failed; vendor js/vendor/hls.js for offline use');
      };
      document.head.appendChild(script);
    } catch (e) {
      console.error('[hls] could not load fallback: ' + (e.message || e));
    }
  }

  /* Local-only prefs. confirmExit gates the exit dialog (General); debug gates the
     phone-home logger, loggerServer is its "host:port" (tools/logger-server.js) and
     alertsUrl the motion-alert service (docs/ALERTS.md) (Developer). Empty = not set. */
  var PREFS_KEY = 'webcamviewer.prefs.v1';
  var prefs = { confirmExit: true, debug: false, loggerServer: '', alertsUrl: '',
    tvAlerts: false, banner: true, checkUpdates: true, lastUpdateCheck: 0, seenUpdate: '' };

  /* "host:port" -> {host, port}, or null when empty or malformed. */
  function parseLoggerServer(value) {
    var m = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(String(value || '').replace(/^\s+|\s+$/g, ''));
    var port = m ? parseInt(m[2], 10) : 0;
    return m && port > 0 && port < 65536 ? { host: m[1], port: port } : null;
  }

  function validAlertsUrl(value) {
    return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(value);
  }

  /* Alert service base URL without a trailing slash, or '' when not configured. */
  function alertsBase() {
    return validAlertsUrl(prefs.alertsUrl) ? prefs.alertsUrl.replace(/\/$/, '') : '';
  }

  /* Alerts can come from this TV's own service (tvAlerts) or from a network alert service. */
  function alertsConfigured() {
    return prefs.tvAlerts || !!alertsBase();
  }

  function loadPrefs() {
    var raw = null;
    var parsed = null;
    try {
      raw = window.localStorage ? window.localStorage.getItem(PREFS_KEY) : null;
    } catch (e) {
      raw = null;
    }
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
    }
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.confirmExit === 'boolean') {
        prefs.confirmExit = parsed.confirmExit;
      }
      if (typeof parsed.debug === 'boolean') {
        prefs.debug = parsed.debug;
      }
      if (typeof parsed.loggerServer === 'string') {
        prefs.loggerServer = parsed.loggerServer;
      }
      if (typeof parsed.alertsUrl === 'string') {
        prefs.alertsUrl = parsed.alertsUrl;
      }
      if (typeof parsed.tvAlerts === 'boolean') {
        prefs.tvAlerts = parsed.tvAlerts;
      }
      if (typeof parsed.banner === 'boolean') {
        prefs.banner = parsed.banner;
      }
      if (typeof parsed.checkUpdates === 'boolean') {
        prefs.checkUpdates = parsed.checkUpdates;
      }
      if (typeof parsed.lastUpdateCheck === 'number') {
        prefs.lastUpdateCheck = parsed.lastUpdateCheck;
      }
      if (typeof parsed.seenUpdate === 'string') {
        prefs.seenUpdate = parsed.seenUpdate;
      }
    }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      console.warn('[settings] could not persist prefs: ' + (e.message || e));
    }
  }

  /* ================================================================
     Logging — console bridge + phone-home WebSocket
     ================================================================ */

  var logSocket = null;
  var logQueue = [];

  /* Debug mode gates all phone-home logging; laptop tests read this hook
     because the localhost skip below hides the real socket behaviour. */
  function loggerWanted() {
    return prefs.debug !== false;
  }

  window.__webcamDebug = { loggerWanted: loggerWanted };

  function formatLogValue(value) {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (value instanceof Error) {
      return value.name + ': ' + value.message;
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return '[object]';
      }
    }
    return String(value);
  }

  function formatLogArgs(args) {
    var parts = [];
    var i;
    for (i = 0; i < args.length; i++) {
      parts.push(formatLogValue(args[i]));
    }
    return parts.join(' ');
  }

  /* One small JSON message per event. Never throws: the logger must not
     be able to take the app down. */
  function sendLog(level, message) {
    var text;
    var payload;
    if (!loggerWanted()) {
      return;
    }
    try {
      text = String(message == null ? '' : message);
      if (text.length > 800) {
        text = text.substring(0, 800);
      }
      payload = JSON.stringify({ t: Date.now(), level: level, msg: text });
      if (logSocket && logSocket.readyState === 1) {
        logSocket.send(payload);
      } else if (logQueue.length < LOG_QUEUE_MAX) {
        logQueue.push(payload);
      }
    } catch (e) {
      /* logging is best-effort by design */
    }
  }

  /* Served from localhost: the laptop test suite's mock server, not a TV. */
  function isLocalDev() {
    return /^(127\.|localhost$)/.test(window.location.hostname);
  }

  function connectLogger() {
    var socket;
    var target = parseLoggerServer(prefs.loggerServer);
    /* Debug off or no log server: never open the socket. Don't flood the real TV log with test runs. */
    if (!loggerWanted() || !target || isLocalDev()) {
      return;
    }
    try {
      socket = new WebSocket('ws://' + target.host + ':' + target.port);
    } catch (e) {
      return;
    }
    logSocket = socket;

    socket.onopen = function () {
      var i;
      for (i = 0; i < logQueue.length; i++) {
        try {
          socket.send(logQueue[i]);
        } catch (e) {
          break;
        }
      }
      logQueue = [];
    };

    /* Unreachable logger is normal in production; stay quiet. */
    socket.onerror = function () {};
    socket.onclose = function () {
      if (logSocket === socket) {
        logSocket = null;
      }
    };
  }

  function disconnectLogger() {
    logQueue = [];
    if (logSocket) {
      try {
        logSocket.close();
      } catch (e) {
        /* already gone */
      }
      logSocket = null;
    }
  }

  /* Debug-mode toggle: connect immediately, or close what is open. */
  function applyDebugSetting() {
    if (loggerWanted()) {
      connectLogger();
    } else {
      disconnectLogger();
    }
  }

  function installLogger() {
    var nativeConsole = window.console;
    var levels = ['log', 'warn', 'error'];
    var i;

    if (nativeConsole) {
      for (i = 0; i < levels.length; i++) {
        (function (level) {
          var original = nativeConsole[level];
          try {
            nativeConsole[level] = function () {
              sendLog(level, formatLogArgs(arguments));
              if (typeof original === 'function') {
                try {
                  original.apply(nativeConsole, arguments);
                } catch (e) {
                  /* console is gone or weird; ignore */
                }
              }
            };
          } catch (e) {
            /* frozen console: logging to the socket still works via sendLog */
          }
        })(levels[i]);
      }
    }

    window.onerror = function (message, source, line, column) {
      sendLog('error', 'window.onerror: ' + message + ' (' + source + ':' + line + ':' + column + ')');
      return false;
    };
  }

  /* ================================================================
     Small ES5 event emitter (shared by handler + HLS adapter)
     ================================================================ */

  function Emitter() {
    this._listeners = {};
  }

  Emitter.prototype.on = function (event, callback) {
    if (typeof callback !== 'function') {
      return this;
    }
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
    return this;
  };

  Emitter.prototype.off = function (event, callback) {
    var list = this._listeners[event];
    var i;
    if (!list) {
      return this;
    }
    for (i = 0; i < list.length; i++) {
      if (list[i] === callback) {
        list.splice(i, 1);
        break;
      }
    }
    return this;
  };

  Emitter.prototype.removeAllListeners = function () {
    this._listeners = {};
    return this;
  };

  Emitter.prototype.emit = function (event) {
    var list = this._listeners[event];
    var args = Array.prototype.slice.call(arguments, 1);
    var i;
    if (!list || !list.length) {
      return false;
    }
    for (i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, args);
      } catch (e) {
        if (window.console) {
          window.console.error('[emitter] ' + event + ' handler failed: ' + e.message);
        }
      }
    }
    return true;
  };

  function inherit(child, parent) {
    child.prototype = Object.create(parent.prototype);
    child.prototype.constructor = child;
  }

  /* ================================================================
     Errors — same taxonomy as reference/stream-handling/errors.js
     ================================================================ */

  var RETRYABLE = {
    NetworkError: true,
    StreamEndedError: true,
    AuthError: false,
    MediaDecodeError: false,
    QuotaExceededError: false
  };

  var ERROR_CODES = {
    NetworkError: 'NETWORK',
    StreamEndedError: 'STREAM_ENDED',
    AuthError: 'AUTH',
    MediaDecodeError: 'MEDIA_DECODE',
    QuotaExceededError: 'QUOTA_EXCEEDED'
  };

  function makeStreamError(type, message) {
    var error = new Error(message || 'Unknown stream error');
    error.name = type;
    error.code = ERROR_CODES[type] || 'UNKNOWN';
    error.retryable = RETRYABLE[type] === true;
    return error;
  }

  function streamErrorFromInfo(info) {
    var type = info && info.type ? info.type : 'NetworkError';
    var message = info && info.message ? info.message : 'Unknown stream error';
    return makeStreamError(type, message);
  }

  /* Exponential backoff with jitter — ported from backoff.js */
  function nextRetryDelay(attempt, baseMs, maxMs) {
    var exp = baseMs * Math.pow(2, attempt);
    var jitter = exp * 0.3 * Math.random();
    return Math.round(Math.min(exp + jitter, maxMs));
  }

  /* ================================================================
     HLS error classification — ported from HLSAdapter.js
     ================================================================ */

  var MEDIA_ERR_ABORTED = 1;
  var MEDIA_ERR_NETWORK = 2;
  var MEDIA_ERR_DECODE = 3;
  var MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

  function classifyHlsError(err) {
    var code;
    if (!err) {
      return { type: 'NetworkError', message: 'Unknown HLS error' };
    }

    if (err.type === 'networkError') {
      code = err.response && err.response.code;
      if (code === 401 || code === 403) {
        return { type: 'AuthError', message: 'HLS authentication failed (HTTP ' + code + ')' };
      }
      if (err.details === 'levelLoadError' || err.details === 'fragLoadError') {
        return { type: 'NetworkError', message: 'HLS network error: ' + err.details };
      }
      return { type: 'NetworkError', message: err.message || 'HLS network error' };
    }

    if (err.type === 'mediaError') {
      return { type: 'MediaDecodeError', message: 'HLS decode error: ' + (err.details || err.message || 'unknown') };
    }

    if (err.target && err.target.error) {
      switch (err.target.error.code) {
        case MEDIA_ERR_ABORTED:
          return { type: 'StreamEndedError', message: 'HLS playback aborted' };
        case MEDIA_ERR_NETWORK:
          return { type: 'NetworkError', message: 'HLS network failure' };
        case MEDIA_ERR_DECODE:
          return { type: 'MediaDecodeError', message: 'HLS decode failure' };
        case MEDIA_ERR_SRC_NOT_SUPPORTED:
          return { type: 'MediaDecodeError', message: 'HLS format not supported' };
        default:
          return { type: 'NetworkError', message: 'Unknown HLS media error' };
      }
    }

    return { type: 'NetworkError', message: err.message || 'Unknown HLS error' };
  }

  /* ================================================================
     HLSAdapter — ported from reference/stream-handling/HLSAdapter.js
     Native <video> first, hls.js (vendored UMD) otherwise.
     ================================================================ */

  var ACTIVITY_TIMEOUT_MS = 10000;

  function supportsNativeHls() {
    var video = document.createElement('video');
    var canPlay = video.canPlayType('application/vnd.apple.mpegurl');
    return canPlay === 'probably' || canPlay === 'maybe';
  }

  function HLSAdapter(config) {
    Emitter.call(this);

    this._url = config && config.url ? config.url : '';
    this._connectionTimeoutMs = config && config.connectionTimeoutMs ? config.connectionTimeoutMs : CONNECTION_TIMEOUT_MS;
    this._parentElement = null;
    this._videoElement = null;
    this._mode = null;
    this._hls = null;
    this._lastPlaybackTime = 0;
    this._frameCount = 0;
    this._startedAt = null;
    this._active = false;
    this._connectTimer = null;
    this._activityTimer = null;
    this._recoveryAttempts = 0;
    this._destroyed = false;

    var self = this;
    this._handlers = {
      timeupdate: function () { self._onTimeUpdate(); },
      loadeddata: function () { self._markFrameReceived(); },
      playing: function () { self._markFrameReceived(); },
      waiting: function () {},
      error: function (event) { self._onVideoError(event); }
    };
  }

  inherit(HLSAdapter, Emitter);

  HLSAdapter.prototype.attach = function (element) {
    if (this._destroyed) {
      throw new Error('Cannot attach a destroyed HLSAdapter');
    }
    if (!element || !element.appendChild) {
      throw new Error('attach() requires a valid DOM element');
    }

    this._parentElement = element;

    if (!this._videoElement) {
      var video = document.createElement('video');
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      video.setAttribute('playsinline', '');
      video.setAttribute('autoplay', '');
      video.muted = false; /* camera audio on; playWithSound() falls back to muted if blocked */

      video.addEventListener('timeupdate', this._handlers.timeupdate);
      video.addEventListener('loadeddata', this._handlers.loadeddata);
      video.addEventListener('playing', this._handlers.playing);
      video.addEventListener('waiting', this._handlers.waiting);
      video.addEventListener('error', this._handlers.error);

      this._videoElement = video;
    }

    if (!this._videoElement.parentNode) {
      element.appendChild(this._videoElement);
    }

    this._startStream();
  };

  HLSAdapter.prototype.detach = function () {
    this._stopStream();
    if (this._videoElement && this._videoElement.parentNode) {
      this._videoElement.parentNode.removeChild(this._videoElement);
    }
    this._parentElement = null;
  };

  HLSAdapter.prototype.getUrl = function () {
    return this._url;
  };

  HLSAdapter.prototype.isActive = function () {
    return this._active;
  };

  HLSAdapter.prototype.destroy = function () {
    var video = this._videoElement;
    this.detach();

    if (video) {
      video.removeEventListener('timeupdate', this._handlers.timeupdate);
      video.removeEventListener('loadeddata', this._handlers.loadeddata);
      video.removeEventListener('playing', this._handlers.playing);
      video.removeEventListener('waiting', this._handlers.waiting);
      video.removeEventListener('error', this._handlers.error);
      this._videoElement = null;
    }

    this._destroyHlsInstance();
    this._destroyed = true;
    this.removeAllListeners();
  };

  HLSAdapter.prototype._startStream = function () {
    var self = this;

    this._active = false;
    this._frameCount = 0;
    this._lastPlaybackTime = 0;
    this._startedAt = Date.now();
    this._recoveryAttempts = 0;

    /* hls.js first: it's the measured, tunable path (docs/STREAMING.md). webOS 4's
       native HLS is v5-only and its canPlayType answer is unverified. */
    if (window.Hls && typeof window.Hls.isSupported === 'function' && window.Hls.isSupported()) {
      this._mode = 'hlsjs';
      this._startHlsJs();
    } else if (supportsNativeHls()) {
      this._mode = 'native';
      this._startNative();
    } else {
      this._mode = 'hlsjs';
      this._startHlsJs(); /* reports "not supported" through the normal error path */
    }

    this._clearConnectTimer();
    this._connectTimer = setTimeout(function () {
      self._connectTimer = null;
      if (!self._active && !self._destroyed) {
        self._emitError({
          type: 'NetworkError',
          message: 'HLS connection timed out'
        });
      }
    }, this._connectionTimeoutMs);
  };

  HLSAdapter.prototype._stopStream = function () {
    this._active = false;

    if (this._videoElement) {
      try {
        this._videoElement.pause();
        this._videoElement.removeAttribute('src');
        this._videoElement.load();
      } catch (e) {
        /* element may already be detached */
      }
    }

    this._destroyHlsInstance();
    this._mode = null;
    this._clearConnectTimer();
    this._clearActivityTimer();
  };

  /* Play with sound. If the engine refuses autoplay with audio (NotAllowedError), retry muted
     so video never fails to start, and log it. A plain deferred play() is ignored as before:
     loadeddata still fires without it. */
  function playWithSound(video) {
    var promise;
    video.muted = false;
    promise = video.play();
    if (promise && typeof promise['catch'] === 'function') {
      promise['catch'](function (err) {
        if (err && err.name === 'NotAllowedError') {
          console.warn('[hls] autoplay with sound blocked; playing muted');
          video.muted = true;
          var retry = video.play();
          if (retry && typeof retry['catch'] === 'function') {
            retry['catch'](function () {});
          }
        }
      });
    }
  }

  HLSAdapter.prototype._startNative = function () {
    if (!this._videoElement) {
      return;
    }
    this._videoElement.src = this._url;
    playWithSound(this._videoElement);
  };

  HLSAdapter.prototype._startHlsJs = function () {
    var Hls = window.Hls;
    var supported = false;
    var self = this;

    if (!Hls || typeof Hls.isSupported !== 'function') {
      this._emitError({
        type: 'MediaDecodeError',
        message: 'HLS player missing (js/vendor/hls.js not loaded)'
      });
      return;
    }

    try {
      supported = Hls.isSupported();
    } catch (e) {
      supported = false;
    }

    if (!supported) {
      this._emitError({
        type: 'MediaDecodeError',
        message: 'Stream format not supported on this TV'
      });
      return;
    }

    try {
      this._hls = new Hls({
        /* Start one 5 s segment from the live edge (default 3 = ~15 s behind) and jump
           forward if it falls 3 behind. Measured on Chromium 53: 7-11 s behind real
           time, ~0.5-1 s camera switches. On the real TV (11 Nov 2026) 1/3 gave repeated
           bufferStalledError on Back (~3 s of buffer vs 5 s segments), so 2/4: steadier,
           ~5 s more delay. */
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        /* Blob workers are not reliable on Chromium 53 / file:// and the
           CSP has no worker-src; play on the main thread instead. */
        enableWorker: false
      });
    } catch (e) {
      this._hls = null;
      this._emitError({
        type: 'MediaDecodeError',
        message: 'Could not start HLS player: ' + (e.message || e)
      });
      return;
    }

    if (Hls.Events && Hls.Events.MEDIA_ATTACHED) {
      this._hls.on(Hls.Events.MEDIA_ATTACHED, function () {
        if (!self._hls) {
          return;
        }
        try {
          self._hls.loadSource(self._url);
        } catch (e) {
          self._emitError({ type: 'NetworkError', message: 'Could not load HLS manifest' });
        }
      });
    }

    /* Delay behind live, from the playlist's PROGRAM-DATE-TIME (MediaMTX's clock vs the
       TV's, both NTP-synced). At most every 30 s, through the phone-home logger. */
    if (Hls.Events && Hls.Events.FRAG_CHANGED) {
      this._hls.on(Hls.Events.FRAG_CHANGED, function (event, data) {
        var frag = data && data.frag;
        var video = self._videoElement;
        var now = Date.now();
        if (!frag || !frag.programDateTime || !video || now - (self._lastLagLogAt || 0) < 30000) {
          return;
        }
        self._lastLagLogAt = now;
        self.emit('activity', {
          type: 'latency',
          message: (Math.round((now - frag.programDateTime - (video.currentTime - frag.start) * 1000) / 100) / 10) +
            ' s behind live'
        });
      });
    }

    if (Hls.Events && Hls.Events.MANIFEST_PARSED) {
      this._hls.on(Hls.Events.MANIFEST_PARSED, function () {
        var video = self._videoElement;
        if (!video) {
          return;
        }
        playWithSound(video);
      });
    }

    if (Hls.Events && Hls.Events.ERROR) {
      this._hls.on(Hls.Events.ERROR, function (event, data) {
        self._handleHlsError(data);
      });
    }

    this._hls.attachMedia(this._videoElement);
  };

  HLSAdapter.prototype._handleHlsError = function (data) {
    var classified;
    if (this._destroyed || !data) {
      return;
    }

    classified = classifyHlsError(data);

    if (!data.fatal) {
      this.emit('activity', {
        type: 'hlsjs-nonfatal',
        message: classified.message,
        details: data.details
      });
      return;
    }

    /* Network failures go back to the handler so its exponential backoff
       applies; hls.js's own 2s reload loop would hammer the camera. */
    if (data.type === 'networkError') {
      this._destroyHlsInstance();
      this._emitError({ type: 'NetworkError', message: classified.message });
      return;
    }

    if (data.type === 'mediaError' && this._hls && this._recoveryAttempts < 2) {
      this._recoveryAttempts++;
      try {
        this._hls.recoverMediaError();
      } catch (e) {
        this._destroyHlsInstance();
        this._emitError({ type: 'MediaDecodeError', message: classified.message });
      }
      return;
    }

    this._destroyHlsInstance();
    this._emitError({ type: classified.type, message: classified.message, fatal: true });
  };

  HLSAdapter.prototype._destroyHlsInstance = function () {
    if (this._hls) {
      try {
        this._hls.destroy();
      } catch (e) {
        /* already torn down */
      }
      this._hls = null;
    }
  };

  HLSAdapter.prototype._onTimeUpdate = function () {
    var currentTime;
    if (this._destroyed || !this._videoElement) {
      return;
    }
    currentTime = this._videoElement.currentTime;
    if (currentTime !== this._lastPlaybackTime) {
      this._lastPlaybackTime = currentTime;
      this._markFrameReceived();
    }
  };

  HLSAdapter.prototype._onVideoError = function (event) {
    if (this._destroyed) {
      return;
    }
    /* hls.js reports its own errors; only classify native playback here. */
    if (this._mode === 'native') {
      this._emitError(classifyHlsError(event));
    }
  };

  HLSAdapter.prototype._markFrameReceived = function () {
    var now;
    if (this._destroyed) {
      return;
    }

    now = Date.now();
    if (!this._active) {
      this._active = true;
      this._clearConnectTimer();
    }

    this._frameCount++;
    this.emit('frame', {
      frameCount: this._frameCount,
      timestamp: now,
      url: this._url,
      mode: this._mode
    });

    this._resetActivityTimer();
  };

  HLSAdapter.prototype._resetActivityTimer = function () {
    var self = this;
    this._clearActivityTimer();
    this._activityTimer = setTimeout(function () {
      self._activityTimer = null;
      if (self._destroyed) {
        return;
      }
      self._active = false;
      self._emitError({
        type: 'StreamEndedError',
        message: 'No HLS frames received — stream may have stalled'
      });
    }, ACTIVITY_TIMEOUT_MS);
  };

  HLSAdapter.prototype._clearConnectTimer = function () {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  };

  HLSAdapter.prototype._clearActivityTimer = function () {
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
      this._activityTimer = null;
    }
  };

  HLSAdapter.prototype._emitError = function (info) {
    if (this._destroyed) {
      return;
    }
    this._active = false;
    this._clearActivityTimer();
    this._clearConnectTimer();
    this.emit('error', info);
  };

  /* ================================================================
     StreamHandle — per-camera state (ported from StreamHandle.js)
     ================================================================ */

  function StreamHandle(cameraId, cameraConfig) {
    this.cameraId = cameraId;
    this.cameraConfig = cameraConfig || {};
    this.status = 'idle';
    this.activeUrl = cameraConfig && cameraConfig.hls ? cameraConfig.hls : null;
    this.retryCount = 0;
    this.lastError = null;
    this.lastFrameAt = null;
    this.streamingStartedAt = null;
    this.backoffDelay = 0;
    this.adapter = null;
    this._backoffTimer = null;
  }

  StreamHandle.prototype.setStatus = function (next) {
    this.status = next;
    if (next === 'streaming') {
      this.streamingStartedAt = Date.now();
      this.lastFrameAt = Date.now();
    } else if (next === 'idle' || next === 'dead') {
      this.streamingStartedAt = null;
    }
  };

  StreamHandle.prototype.clearTimers = function () {
    if (this._backoffTimer != null) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
  };

  StreamHandle.prototype.reset = function () {
    this.clearTimers();
    this.retryCount = 0;
    this.lastError = null;
    this.lastFrameAt = null;
    this.streamingStartedAt = null;
    this.backoffDelay = 0;
    this.adapter = null;
    this.status = 'idle';
  };

  StreamHandle.prototype.toJSON = function () {
    return {
      cameraId: this.cameraId,
      status: this.status,
      retryCount: this.retryCount,
      backoffDelay: this.backoffDelay,
      lastError: this.lastError ? { name: this.lastError.name, code: this.lastError.code, message: this.lastError.message } : null
    };
  };

  /* ================================================================
     StreamHandler — reconnect/backoff state machine (ported from
     StreamHandler.js, minus the multi-stream concurrency queue: this
     app only ever plays one camera at a time).
     ================================================================ */

  function StreamHandler(config) {
    Emitter.call(this);

    this._config = {
      reconnectEnabled: true,
      reconnectMaxRetries: 10,
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 30000
    };

    if (config) {
      for (var key in config) {
        if (Object.prototype.hasOwnProperty.call(config, key)) {
          this._config[key] = config[key];
        }
      }
    }

    this._handles = {};
  }

  inherit(StreamHandler, Emitter);

  StreamHandler.prototype.getHandle = function (cameraId) {
    if (!Object.prototype.hasOwnProperty.call(this._handles, cameraId)) {
      return null;
    }
    return this._handles[cameraId];
  };

  StreamHandler.prototype.connect = function (cameraId, cameraConfig) {
    var handle = this.getHandle(cameraId);

    if (!handle) {
      handle = new StreamHandle(cameraId, cameraConfig);
      this._handles[cameraId] = handle;
    } else {
      handle.cameraConfig = cameraConfig || handle.cameraConfig;
      handle.activeUrl = cameraConfig && cameraConfig.hls ? cameraConfig.hls : handle.activeUrl;
    }

    if (handle.status === 'connecting' || handle.status === 'streaming') {
      return handle;
    }

    handle.clearTimers();
    handle.retryCount = 0;
    handle.lastError = null;
    handle.backoffDelay = 0;
    this._startConnection(handle);
    return handle;
  };

  StreamHandler.prototype._startConnection = function (handle) {
    this._destroyAdapter(handle);
    handle.setStatus('connecting');
    handle.backoffDelay = 0;
    this.emit('statusChange', handle);
    this.emit('streamConnect', handle);
  };

  StreamHandler.prototype.handleFrameEvent = function (cameraId) {
    var handle = this.getHandle(cameraId);
    if (!handle) {
      return;
    }

    if (handle.status !== 'streaming') {
      handle.setStatus('streaming');
      handle.retryCount = 0;
      handle.lastError = null;
      this.emit('streamReady', handle);
      this.emit('statusChange', handle);
    } else {
      handle.lastFrameAt = Date.now();
    }
  };

  StreamHandler.prototype.handleError = function (cameraId, error) {
    var handle = this.getHandle(cameraId);
    var streamError;

    if (!handle || handle.status === 'dead') {
      return;
    }

    streamError = error instanceof Error ? error : makeStreamError('NetworkError', String(error));
    if (typeof streamError.retryable !== 'boolean') {
      streamError.retryable = true;
    }

    handle.lastError = streamError;
    handle.retryCount++;
    this.emit('error', handle, streamError);

    this._destroyAdapter(handle);

    if (!streamError.retryable ||
        !this._config.reconnectEnabled ||
        handle.retryCount >= this._config.reconnectMaxRetries) {
      this._transitionToDead(handle);
      return;
    }

    this._enterBackoff(handle);
  };

  StreamHandler.prototype._enterBackoff = function (handle) {
    var self = this;
    var delay = nextRetryDelay(
      handle.retryCount - 1,
      this._config.reconnectBaseDelayMs,
      this._config.reconnectMaxDelayMs
    );

    handle.clearTimers();
    handle.setStatus('backoff');
    handle.backoffDelay = delay;
    this.emit('statusChange', handle);

    handle._backoffTimer = setTimeout(function () {
      handle._backoffTimer = null;
      if (handle.status === 'backoff') {
        self._startConnection(handle);
      }
    }, delay);
  };

  StreamHandler.prototype._transitionToDead = function (handle) {
    handle.clearTimers();
    this._destroyAdapter(handle);
    handle.setStatus('dead');
    this.emit('statusChange', handle);
  };

  StreamHandler.prototype.retry = function (cameraId) {
    var handle = this.getHandle(cameraId);
    if (!handle) {
      return;
    }
    handle.clearTimers();
    handle.retryCount = 0;
    handle.lastError = null;
    handle.backoffDelay = 0;
    this._startConnection(handle);
  };

  StreamHandler.prototype.disconnect = function (cameraId) {
    var handle = this.getHandle(cameraId);
    if (!handle) {
      return;
    }
    handle.clearTimers();
    this._destroyAdapter(handle);
    handle.reset();
    delete this._handles[cameraId];
  };

  StreamHandler.prototype._destroyAdapter = function (handle) {
    if (!handle.adapter) {
      return;
    }
    try {
      if (typeof handle.adapter.destroy === 'function') {
        handle.adapter.destroy();
      } else if (typeof handle.adapter.detach === 'function') {
        handle.adapter.detach();
      }
    } catch (e) {
      console.error('[stream] adapter destroy failed: ' + (e.message || e));
    }
    handle.adapter = null;
  };

  /* ================================================================
     App state + UI
     ================================================================ */

  var cameras = [];
  var state = {
    view: 'grid',
    focusedId: '',
    activeCamera: null,
    handler: null,
    tiles: {},
    backoffEndsAt: 0,
    editingId: null,
    confirmDeleteId: null,
    confirmReset: false,
    exitConfirm: false,
    refocusKey: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function clearNode(element) {
    while (element && element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  /* ------------------------------------------------------------------
     Camera list: persisted config (cameraConfigs) + runtime view of it
     (cameras, URLs possibly rewritten by DEV_MOCK)
     ------------------------------------------------------------------ */

  var cameraConfigs = [];

  /* localStorage can be absent, blocked or full; every access is wrapped. */
  function loadCameraConfigs() {
    var raw = null;
    var parsed = null;
    var i;
    var ok;
    try {
      raw = window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : null;
    } catch (e) {
      raw = null;
    }
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
      if (parsed && parsed.length) {
        ok = true;
        for (i = 0; i < parsed.length; i++) {
          if (!validCameraConfig(parsed[i])) {
            ok = false;
            break;
          }
        }
        if (ok) {
          cameraConfigs = parsed;
          return;
        }
      }
      console.warn('[settings] stored camera list invalid, using defaults');
    }
    cameraConfigs = defaultCameraConfigs();
  }

  function validCameraConfig(config) {
    return !!config && typeof config === 'object' &&
      typeof config.id === 'string' && config.id.length > 0 &&
      typeof config.name === 'string' && config.name.length > 0 &&
      typeof config.hls === 'string' && /^https?:\/\//i.test(config.hls) &&
      (config.snapshot === undefined || config.snapshot === null || typeof config.snapshot === 'string');
  }

  function defaultCameraConfigs() {
    var list = [];
    var i;
    for (i = 0; i < CAMERAS.length; i++) {
      list.push({
        id: CAMERAS[i].id,
        name: CAMERAS[i].name,
        hls: CAMERAS[i].hls,
        snapshot: CAMERAS[i].snapshot || ''
      });
    }
    return list;
  }

  function saveCameraConfigs() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cameraConfigs));
    } catch (e) {
      console.warn('[settings] could not persist camera list: ' + (e.message || e));
    }
    /* This TV's alert service needs the camera ids and names for webhooks and alert text. */
    if (prefs.tvAlerts && window.PalmServiceBridge) {
      tvConfigure(null);
    }
  }

  function cameraConfigById(cameraId) {
    var i;
    for (i = 0; i < cameraConfigs.length; i++) {
      if (cameraConfigs[i].id === cameraId) {
        return cameraConfigs[i];
      }
    }
    return null;
  }

  /* New ids are slugs of the camera name, made unique with -2, -3, ...
     Edits keep the id, so stream handles and focus survive a rename. */
  function slugifyName(name) {
    var slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'camera';
  }

  function uniqueCameraId(name) {
    var base = slugifyName(name);
    var id = base;
    var n = 2;
    while (cameraConfigById(id)) {
      id = base + '-' + n;
      n++;
    }
    return id;
  }

  /* Any change to the list: persist, rebuild the runtime list and the grid,
     re-render the Cameras page if it is up. */
  function applyCameras(refocusKey) {
    saveCameraConfigs();
    buildCameras();
    rebuildGrid();
    if (state.view === 'cameras') {
      state.refocusKey = refocusKey || null;
      renderCameras();
    }
  }

  function buildCameras() {
    var i;
    var camera;
    cameras = [];
    for (i = 0; i < cameraConfigs.length; i++) {
      camera = cameraConfigs[i];
      cameras.push({
        id: camera.id,
        name: camera.name,
        hls: DEV_MOCK ? DEV_MOCK_HLS_BASE + '/' + camera.id + '/index.m3u8' : camera.hls,
        snapshot: DEV_MOCK ? DEV_MOCK_SNAPSHOT : camera.snapshot
      });
    }
  }

  function cameraById(cameraId) {
    var i;
    for (i = 0; i < cameras.length; i++) {
      if (cameras[i].id === cameraId) {
        return cameras[i];
      }
    }
    return null;
  }

  function snapshotUrl(camera) {
    var separator = camera.snapshot.indexOf('?') === -1 ? '?' : '&';
    return camera.snapshot + separator + '_t=' + Date.now();
  }

  /* ------------------------------------------------------------------
     Time + tile state rendering (DOM only)
     ------------------------------------------------------------------ */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatClock(date) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function formatStamp(ts) {
    var date = new Date(ts);
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' +
      pad2(date.getSeconds());
  }

  function updateClock() {
    var el = $('clock');
    var text;
    if (!el) {
      return;
    }
    text = formatClock(new Date());
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }

  function playerRetryText() {
    var remain = Math.max(1, Math.ceil((state.backoffEndsAt - Date.now()) / 1000));
    return 'Retrying in ' + remain + ' s — press OK to retry now';
  }

  /* One place that paints a tile's pill / centre state / meta from
     tile.state: 'loading' | 'live' | 'nopreview'. */
  function updateTileVisuals(tile) {
    var dimmed = tile.img && tile.state !== 'live';
    tile.media.className = 'tile-media' + (dimmed ? ' is-dimmed' : '');

    if (tile.state === 'live') {
      tile.stateview.className = 'tile-stateview is-hidden';
      tile.pill.className = 'status status--live';
      tile.pillLabel.textContent = 'Live';
      tile.meta.textContent = 'Updated ' + formatStamp(tile.lastOkAt);
    } else if (tile.state === 'nopreview') {
      /* Snapshot failed. That says nothing about the live stream (which the
         player checks itself), so stay neutral: no red, no "Offline". */
      tile.stateview.className = 'tile-stateview';
      tile.spinner.className = 'spinner is-hidden';
      tile.stateTitle.textContent = 'Live view';
      tile.stateDetail.textContent = 'Press OK to watch';
      tile.pill.className = 'status';
      tile.pillLabel.textContent = 'No preview';
      tile.meta.textContent = tile.lastOkAt
        ? 'Preview from ' + formatStamp(tile.lastOkAt)
        : 'Preview unavailable';
    } else {
      /* loading: first snapshot probe in flight */
      tile.stateview.className = 'tile-stateview';
      tile.spinner.className = 'spinner';
      tile.stateTitle.textContent = 'Connecting…';
      tile.stateDetail.textContent = '';
      tile.pill.className = 'status';
      tile.pillLabel.textContent = 'Loading…';
      tile.meta.textContent = 'No frame yet';
    }
  }

  /* Settings · Cameras rows carry the same status badge as the camera's grid tile
     (Live / Loading… / No preview), synced by syncCameraBadges() on the 1 s tick. */
  function cameraBadge(cameraId) {
    var badge = document.createElement('span');
    var dot = document.createElement('span');
    var label = document.createElement('span');
    badge.className = 'status status--inline settings-row-status';
    badge.setAttribute('data-status-for', cameraId);
    dot.className = 'status-dot';
    label.className = 'status-label';
    badge.appendChild(dot);
    badge.appendChild(label);
    syncCameraBadge(badge);
    return badge;
  }

  function syncCameraBadge(badge) {
    var tile = state.tiles[badge.getAttribute('data-status-for')];
    var cls = 'status status--inline settings-row-status' +
      (tile && tile.pill.className.indexOf('status--live') !== -1 ? ' status--live' : '');
    var text = tile ? tile.pillLabel.textContent : 'Loading…';
    if (badge.className !== cls) {
      badge.className = cls;
    }
    if (badge.lastChild.textContent !== text) {
      badge.lastChild.textContent = text;
    }
  }

  function syncCameraBadges() {
    var badges = document.querySelectorAll('[data-status-for]');
    var i;
    for (i = 0; i < badges.length; i++) {
      syncCameraBadge(badges[i]);
    }
  }

  /* Snapshot thumbnails are best-effort. The real URLs are HTTPS with
     self-signed certs, which this TV may refuse outright; failures feed
     the tile's state language, they never crash the grid. */
  function abortProbe(tile) {
    if (tile.timer) {
      clearTimeout(tile.timer);
      tile.timer = null;
    }
    if (tile.probe) {
      tile.probe.onload = null;
      tile.probe.onerror = null;
      try {
        tile.probe.src = '';
      } catch (e) {
        /* ignore */
      }
      tile.probe = null;
    }
  }

  function snapshotFailed(tile) {
    tile.failCount++;
    /* Keep polling quietly forever; a good frame flips the tile back to
       live. One failure keeps the "Connecting…" spinner, two say so. */
    tile.state = tile.failCount >= 2 ? 'nopreview' : 'loading';
    updateTileVisuals(tile);
  }

  function snapshotLoaded(tile) {
    tile.failCount = 0;
    tile.lastOkAt = Date.now();
    tile.state = 'live';
    updateTileVisuals(tile);
  }

  function refreshSnapshot(camera) {
    var tile = state.tiles[camera.id];
    var probe;
    var finished = false;

    if (!tile) {
      return;
    }

    abortProbe(tile);
    tile.nextAttemptAt = Date.now() + SNAPSHOT_INTERVAL_MS;

    /* No preview URL configured (e.g. the demo stream): say so once, don't poll ''. */
    if (!camera.snapshot) {
      if (tile.state !== 'nopreview') {
        tile.state = 'nopreview';
        updateTileVisuals(tile);
      }
      return;
    }

    probe = new Image();
    tile.probe = probe;

    tile.timer = setTimeout(function () {
      if (finished) {
        return;
      }
      finished = true;
      tile.timer = null;
      if (tile.probe === probe) {
        tile.probe = null;
      }
      probe.onload = null;
      probe.onerror = null;
      try {
        probe.src = '';
      } catch (e) {
        /* ignore */
      }
      snapshotFailed(tile);
    }, SNAPSHOT_TIMEOUT_MS);

    probe.onload = function () {
      if (finished) {
        return;
      }
      finished = true;
      if (tile.timer) {
        clearTimeout(tile.timer);
        tile.timer = null;
      }
      if (tile.probe === probe) {
        tile.probe = null;
      }

      if (!probe.naturalWidth) {
        snapshotFailed(tile);
        return;
      }

      probe.className = 'tile-img';
      probe.setAttribute('alt', '');
      if (tile.img && tile.img.parentNode) {
        tile.img.parentNode.removeChild(tile.img);
      }
      /* The frame must paint under the scrim/footer overlays, not over them. */
      tile.media.insertBefore(probe, tile.scrim);
      tile.img = probe;
      snapshotLoaded(tile);
    };

    probe.onerror = function () {
      if (finished) {
        return;
      }
      finished = true;
      if (tile.timer) {
        clearTimeout(tile.timer);
        tile.timer = null;
      }
      if (tile.probe === probe) {
        tile.probe = null;
      }
      snapshotFailed(tile);
    };

    probe.src = snapshotUrl(camera);
  }

  function refreshAllSnapshots() {
    var i;
    for (i = 0; i < cameras.length; i++) {
      refreshSnapshot(cameras[i]);
    }
  }

  function createTile(camera) {
    var button = document.createElement('button');
    var media = document.createElement('span');
    var surface = document.createElement('span');
    var scrim = document.createElement('span');
    var stateview = document.createElement('span');
    var spinnerEl = document.createElement('span');
    var stateTitle = document.createElement('span');
    var stateDetail = document.createElement('span');
    var pill = document.createElement('span');
    var pillDot = document.createElement('span');
    var pillLabel = document.createElement('span');
    var footer = document.createElement('span');
    var name = document.createElement('span');
    var meta = document.createElement('span');

    button.className = 'tile';
    button.setAttribute('type', 'button');
    button.setAttribute('data-camera-id', camera.id);
    button.setAttribute('aria-label', camera.name);

    media.className = 'tile-media';

    surface.className = 'tile-surface';
    scrim.className = 'tile-scrim';

    stateview.className = 'tile-stateview';
    spinnerEl.className = 'spinner';
    stateTitle.className = 'tile-stateview-title';
    stateDetail.className = 'tile-stateview-detail';
    stateview.appendChild(spinnerEl);
    stateview.appendChild(stateTitle);
    stateview.appendChild(stateDetail);

    pill.className = 'status';
    pillDot.className = 'status-dot';
    pillLabel.className = 'status-label';
    pill.appendChild(pillDot);
    pill.appendChild(pillLabel);

    footer.className = 'tile-footer';
    name.className = 'tile-name';
    name.textContent = camera.name;
    meta.className = 'tile-meta';
    footer.appendChild(name);
    footer.appendChild(meta);

    /* Paint order: hatched surface, frame (<img> inserted before scrim on
       load), scrim, centre state, pill, footer. */
    media.appendChild(surface);
    media.appendChild(scrim);
    media.appendChild(stateview);
    media.appendChild(pill);
    media.appendChild(footer);

    button.appendChild(media);

    button.addEventListener('focus', function () {
      state.focusedId = camera.id;
    });

    button.addEventListener('click', function () {
      openPlayer(camera);
    });

    /* Magic Remote pointer: hovering should not steal D-pad focus. */
    button.addEventListener('mouseenter', function () {
      if (document.activeElement !== button) {
        button.focus();
      }
    });

    state.tiles[camera.id] = {
      button: button,
      media: media,
      scrim: scrim,
      stateview: stateview,
      spinner: spinnerEl,
      stateTitle: stateTitle,
      stateDetail: stateDetail,
      pill: pill,
      pillLabel: pillLabel,
      meta: meta,
      img: null,
      probe: null,
      timer: null,
      state: 'loading',
      failCount: 0,
      lastOkAt: 0,
      nextAttemptAt: 0
    };

    updateTileVisuals(state.tiles[camera.id]);

    return button;
  }

  /* Rebuild the grid from the current camera list: abort in-flight snapshot
     probes, drop stream handles of removed cameras, then lay out 1-2 cameras
     as the single row and 3-4 as a 2x2 of smaller tiles. */
  function rebuildGrid() {
    var grid = $('grid');
    var quad = cameras.length >= 3;
    var id;
    var stale = [];
    var i;
    var row = null;

    for (id in state.tiles) {
      if (Object.prototype.hasOwnProperty.call(state.tiles, id)) {
        abortProbe(state.tiles[id]);
      }
    }

    if (state.handler) {
      for (id in state.handler._handles) {
        if (Object.prototype.hasOwnProperty.call(state.handler._handles, id) && !cameraById(id)) {
          stale.push(id);
        }
      }
      for (i = 0; i < stale.length; i++) {
        console.log('[stream] drop handle for removed camera ' + stale[i]);
        state.handler.disconnect(stale[i]);
      }
    }

    clearNode(grid);
    state.tiles = {};
    grid.className = quad ? 'grid grid--quad' : 'grid';

    for (i = 0; i < cameras.length; i++) {
      if (quad && i % 2 === 0) {
        row = document.createElement('div');
        row.className = 'grid-row';
        grid.appendChild(row);
      }
      (row || grid).appendChild(createTile(cameras[i]));
    }

    $('count').textContent = cameras.length + (cameras.length === 1 ? ' camera' : ' cameras');
  }

  function findTile(cameraId) {
    var tiles = document.querySelectorAll('.tile');
    var i;
    for (i = 0; i < tiles.length; i++) {
      if (tiles[i].getAttribute('data-camera-id') === cameraId) {
        return tiles[i];
      }
    }
    return null;
  }

  function focusTile(cameraId) {
    var tile = findTile(cameraId) || (cameras.length ? findTile(cameras[0].id) : null);
    if (tile) {
      tile.focus();
    }
  }

  /* Spatial focus navigation, mirroring Lumen's moveFocus(). Moves focus
     from wherever it currently sits to the best candidate matching the
     given selector; with nothing meaningful focused, focuses the first. */
  function centerOf(element) {
    var rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function moveFocusSpatial(selector, direction) {
    var elements = document.querySelectorAll(selector);
    var current = document.activeElement;
    var rect;
    var i;
    var element;
    var from;
    var to;
    var dx;
    var dy;
    var primary;
    var secondary;
    var valid;
    var score;
    var best = null;
    var bestScore = Infinity;

    if (!elements.length) {
      return;
    }

    rect = current && current.getBoundingClientRect ? current.getBoundingClientRect() : null;
    if (!current || current === document.body || current === document.documentElement ||
        !rect || (!rect.width && !rect.height)) {
      if (elements[0].focus) {
        elements[0].focus();
      }
      return;
    }

    from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

    for (i = 0; i < elements.length; i++) {
      element = elements[i];
      if (element === current) {
        continue;
      }
      to = centerOf(element);
      dx = to.x - from.x;
      dy = to.y - from.y;

      if (direction === 'left') {
        valid = dx < -8;
        primary = -dx;
        secondary = Math.abs(dy);
      } else if (direction === 'right') {
        valid = dx > 8;
        primary = dx;
        secondary = Math.abs(dy);
      } else if (direction === 'up') {
        valid = dy < -8;
        primary = -dy;
        secondary = Math.abs(dx);
      } else {
        valid = dy > 8;
        primary = dy;
        secondary = Math.abs(dx);
      }

      if (!valid) {
        continue;
      }

      score = primary + secondary * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = element;
      }
    }

    if (best) {
      best.focus();
    }
  }

  /* Grid: arrows move between tiles; Up also reaches the settings gear at
     the top right, and Down from the gear returns to the tiles. */
  function gridMoveFocus(direction) {
    var current = document.activeElement;
    var onGear = current && current.id === 'settings-btn';

    if (onGear) {
      if (direction === 'down') {
        moveFocusSpatial('.tile', 'down');
      }
      return;
    }

    if (direction === 'up') {
      moveFocusSpatial('.tile, .settings-btn', 'up');
    } else {
      moveFocusSpatial('.tile', direction);
    }
  }

  /* ================================================================
     Player wiring
     ================================================================ */

  /* Chrome (name, pill, hints) fades after a few steady seconds of live
     video; any key brings it back. It never hides during a problem state —
     the retry affordance must stay visible. */
  var CHROME_HIDE_MS = 4000;
  var chromeTimer = null;

  function showPlayerChrome() {
    var chrome = $('player-chrome');
    var handle;
    if (!chrome) {
      return;
    }
    chrome.className = 'player-chrome';
    if (chromeTimer) {
      clearTimeout(chromeTimer);
      chromeTimer = null;
    }
    if (state.view !== 'player' || !state.activeCamera) {
      return;
    }
    handle = state.handler.getHandle(state.activeCamera.id);
    if (handle && handle.status === 'streaming') {
      chromeTimer = setTimeout(function () {
        chromeTimer = null;
        chrome.className = 'player-chrome is-dimmed';
      }, CHROME_HIDE_MS);
    }
  }

  function hideChromeTimer() {
    if (chromeTimer) {
      clearTimeout(chromeTimer);
      chromeTimer = null;
    }
  }

  function renderHandle(handle) {
    var screen;
    var pill;
    var label;
    var centre;
    var spinner;
    var title;
    var detail;
    var message;

    if (!state.activeCamera || !handle || handle.cameraId !== state.activeCamera.id) {
      return;
    }

    screen = $('player-screen');
    pill = $('player-pill');
    label = $('player-status');
    centre = $('player-centre');
    spinner = $('player-spinner');
    title = $('player-centre-title');
    detail = $('player-centre-detail');
    screen.setAttribute('data-state', handle.status);

    if (handle.status === 'streaming') {
      pill.className = 'status status--inline status--live';
      label.textContent = 'Live';
      centre.className = 'player-centre is-hidden';
      state.backoffEndsAt = 0;
    } else if (handle.status === 'backoff') {
      pill.className = 'status status--inline status--reconnecting';
      label.textContent = 'Reconnecting…';
      centre.className = 'player-centre';
      spinner.className = 'spinner player-spinner';
      title.textContent = 'Reconnecting…';
      state.backoffEndsAt = Date.now() + (handle.backoffDelay || 0);
      detail.textContent = playerRetryText();
    } else if (handle.status === 'dead') {
      pill.className = 'status status--inline status--offline';
      label.textContent = 'Offline';
      centre.className = 'player-centre';
      spinner.className = 'spinner player-spinner is-hidden';
      title.textContent = 'Offline';
      message = handle.lastError && handle.lastError.message
        ? handle.lastError.message
        : 'Camera unreachable';
      detail.textContent = message + ' — press OK to retry';
      state.backoffEndsAt = 0;
    } else if (handle.status === 'connecting') {
      pill.className = 'status status--inline';
      label.textContent = 'Connecting…';
      centre.className = 'player-centre';
      spinner.className = 'spinner player-spinner';
      title.textContent = 'Connecting…';
      detail.textContent = '';
      state.backoffEndsAt = 0;
    } else {
      pill.className = 'status status--inline';
      label.textContent = 'Idle';
      centre.className = 'player-centre is-hidden';
      state.backoffEndsAt = 0;
    }

    showPlayerChrome();
  }

  function onStreamConnect(handle) {
    var host;
    var adapter;

    if (!state.activeCamera || state.activeCamera.id !== handle.cameraId) {
      return;
    }

    host = $('video-host');
    clearNode(host);

    adapter = new HLSAdapter({
      url: handle.activeUrl,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS
    });
    handle.adapter = adapter;

    adapter.on('frame', function () {
      state.handler.handleFrameEvent(handle.cameraId);
    });

    adapter.on('error', function (info) {
      state.handler.handleError(handle.cameraId, streamErrorFromInfo(info));
    });

    adapter.on('activity', function (info) {
      console.log('[hls] ' + handle.cameraId + ' ' +
        (info.type || 'activity') + ': ' + (info.message || ''));
    });

    try {
      adapter.attach(host);
    } catch (e) {
      state.handler.handleError(handle.cameraId,
        makeStreamError('MediaDecodeError', e.message || 'Could not start player'));
    }
  }

  function openPlayer(camera) {
    var screen;

    if (!camera || state.view === 'player') {
      return;
    }

    console.log('[ui] open ' + camera.id);

    state.view = 'player';
    state.activeCamera = camera;
    state.openedAt = Date.now(); /* for the "live after N ms" log line */

    $('grid-screen').classList.add('is-hidden');
    screen = $('player-screen');
    screen.classList.remove('is-hidden');
    screen.setAttribute('data-state', 'connecting');
    $('player-name').textContent = camera.name;
    $('player-status').textContent = 'Connecting…';
    clearNode($('video-host'));
    screen.focus();

    hideChromeTimer();
    $('player-chrome').className = 'player-chrome';

    state.handler.connect(camera.id, camera);
  }

  function closePlayer() {
    if (!state.activeCamera) {
      return;
    }

    console.log('[ui] close ' + state.activeCamera.id);

    hideChromeTimer();
    state.backoffEndsAt = 0;
    state.handler.disconnect(state.activeCamera.id);
    state.activeCamera = null;
    state.view = 'grid';

    clearNode($('video-host'));
    $('player-screen').classList.add('is-hidden');
    $('grid-screen').classList.remove('is-hidden');
    focusTile(state.focusedId);
  }

  /* Left/right in the player: previous/next camera, wrapping. Swaps the
     stream in place (no flash back to the grid); Back then lands on the
     tile of the camera being watched. */
  function switchCamera(step) {
    var i;
    var next;
    if (!state.activeCamera || cameras.length < 2) {
      return;
    }
    i = cameras.indexOf(state.activeCamera);
    next = cameras[(i + step + cameras.length) % cameras.length];
    swapToCamera(next);
  }

  function swapToCamera(next) {
    console.log('[ui] switch ' + state.activeCamera.id + ' -> ' + next.id);

    hideChromeTimer();
    state.backoffEndsAt = 0;
    state.handler.disconnect(state.activeCamera.id);
    state.activeCamera = null;
    state.view = 'grid';
    state.focusedId = next.id;
    openPlayer(next);
  }

  /* Launch parameters, e.g. {camera: 'front', source: 'alert'} from a motion-alert
     toast. Sources: ?camera= in the URL (the packaged shell passes its params that way
     to the NAS-hosted app), PalmSystem.launchParams, and the webOSRelaunch event when
     the app was already running. Ignored while Settings is open. */
  function readLaunchCamera(params) {
    var parsed = params;
    if (typeof parsed === 'string') {
      try {
        parsed = parsed ? JSON.parse(parsed) : null;
      } catch (e) {
        parsed = null;
      }
    }
    return parsed && typeof parsed.camera === 'string' ? parsed.camera : null;
  }

  function initialLaunchCamera() {
    var match = /[?&]camera=([^&#]+)/.exec(window.location.search || '');
    if (match) {
      return decodeURIComponent(match[1]);
    }
    try {
      return window.PalmSystem ? readLaunchCamera(window.PalmSystem.launchParams) : null;
    } catch (e) {
      return null;
    }
  }

  function openCameraFromLaunch(cameraId) {
    var camera = cameraId ? cameraById(cameraId) : null;
    if (!camera) {
      return;
    }
    console.log('[app] launch -> ' + camera.id);
    state.focusedId = camera.id;
    if (state.view === 'player') {
      if (state.activeCamera !== camera) {
        swapToCamera(camera);
      }
    } else if (state.view === 'grid') {
      openPlayer(camera);
    }
  }

  function retryIfDead() {
    var handle;
    if (!state.activeCamera) {
      return;
    }
    handle = state.handler.getHandle(state.activeCamera.id);
    if (handle && (handle.status === 'dead' || handle.status === 'backoff')) {
      console.log('[ui] manual retry ' + state.activeCamera.id);
      state.handler.retry(state.activeCamera.id);
    }
  }

  /* Exit: try every route in turn. On the TV (12 Nov 2026), PalmSystem.platformBack() alone
     did not leave the NAS-hosted page, so log what exists and what Luna answers. */
  function exitApp() {
    var bridge;
    console.log('[app] exit: PalmSystem=' + !!window.PalmSystem +
      ' platformBack=' + !!(window.PalmSystem && window.PalmSystem.platformBack) +
      ' PalmServiceBridge=' + !!window.PalmServiceBridge);
    try {
      if (window.PalmSystem && typeof window.PalmSystem.platformBack === 'function') {
        window.PalmSystem.platformBack();
      }
    } catch (e) {
      console.warn('[app] platformBack failed: ' + (e && e.message));
    }
    try {
      if (window.PalmServiceBridge) {
        bridge = new window.PalmServiceBridge();
        bridge.onservicecallback = function (response) {
          console.log('[app] luna close -> ' + response);
        };
        bridge.call('luna://com.webos.applicationManager/close',
          JSON.stringify({ id: APP_ID }));
      }
    } catch (e) {
      console.warn('[app] luna close failed: ' + (e && e.message));
    }
    setTimeout(function () {
      try {
        window.close();
      } catch (e) {
        /* the platform will close us anyway */
      }
    }, 500);
  }

  /* Confirm-exit modal (Settings · General). Centred panel over the dimmed
     grid; Cancel is focused by default and hands focus back to the tile. */
  function openExitDialog() {
    state.exitConfirm = true;
    $('exit-dialog').classList.remove('is-hidden');
    $('exit-cancel').focus();
  }

  function closeExitDialog() {
    state.exitConfirm = false;
    $('exit-dialog').classList.add('is-hidden');
    focusTile(state.focusedId);
  }

  /* One 1s heartbeat: wall clock + "Retrying in N s" countdowns. DOM
     writes only happen when the rendered text actually changes. */
  function tick() {
    var text;
    var detailEl;

    updateClock();

    if (state.view === 'cameras') {
      syncCameraBadges();
    }

    if (state.view === 'player' && state.backoffEndsAt) {
      detailEl = $('player-centre-detail');
      text = playerRetryText();
      if (detailEl.textContent !== text) {
        detailEl.textContent = text;
      }
    }
  }

  /* Overlay behaviour only: any key press while the player is up wakes
     the chrome for a few seconds. Navigation itself stays in onKeyDown. */
  function onAnyKeyForChrome() {
    if (state.view === 'player') {
      showPlayerChrome();
    }
  }

  /* ================================================================
     Settings — a TV-style menu (view 'settings') with four sub-pages:
     General, Notifications, Cameras, Developer. Each menu item is a
     large row with a one-line live summary; OK opens the page, Back
     returns to the menu focused on that item (to the grid from the
     menu). Sub-pages share the row/toggle/stepper helpers below and
     one .settings-scroll area between the title and the hint bar.
     ================================================================ */

  /* view -> screen id, for the settings pages that share the same
     keys and show/hide plumbing (the form is in the map so Back from a
     sub-page hides it too; its own key handling returns earlier). */
  var SETTINGS_VIEWS = {
    settings: 'settings-screen',
    general: 'general-screen',
    notifications: 'notifications-screen',
    cameras: 'cameras-screen',
    developer: 'developer-screen',
    form: 'form-screen'
  };

  /* Show one settings screen, hide the rest; null hides all of them.
     The grid and the player are toggled by their own open/close. */
  function showScreen(screenId) {
    var view;
    for (view in SETTINGS_VIEWS) {
      if (Object.prototype.hasOwnProperty.call(SETTINGS_VIEWS, view)) {
        $(SETTINGS_VIEWS[view]).classList.toggle('is-hidden', SETTINGS_VIEWS[view] !== screenId);
      }
    }
  }

  /* Focusable settings items; disabled buttons (Move up on row 1, etc.)
     are skipped so arrows never land on a dead key. */
  var SETTINGS_FOCUS = '.settings-focus:not([disabled])';

  function makeSettingsButton(label, opts) {
    var button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.className = 'btn settings-focus' +
      (opts.danger ? ' btn--danger' : '') + (opts.primary ? ' btn--primary' : '');
    button.textContent = label;
    if (opts.action) {
      button.setAttribute('data-action', opts.action);
    }
    if (opts.cameraKey) {
      button.setAttribute('data-camera-key', opts.cameraKey);
    }
    if (opts.focusKey) {
      button.setAttribute('data-focus-key', opts.focusKey);
    }
    if (opts.disabled) {
      button.disabled = true;
    }
    button.addEventListener('click', opts.onPress);
    /* Magic Remote pointer: hovering should not steal D-pad focus handling,
       but it should show the pointer's target. */
    button.addEventListener('mouseenter', function () {
      if (!button.disabled && document.activeElement !== button) {
        button.focus();
      }
    });
    return button;
  }

  function findFocusKey(screenId, key) {
    var buttons = $(screenId).querySelectorAll('[data-focus-key]');
    var i;
    for (i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-focus-key') === key && !buttons[i].disabled) {
        return buttons[i];
      }
    }
    return null;
  }

  function buildSettingsRow(cfg, index) {
    var row = document.createElement('div');
    var text = document.createElement('div');
    var name = document.createElement('span');
    var url = document.createElement('span');
    var confirmText;

    row.className = 'settings-row';
    row.setAttribute('data-camera-key', cfg.id);
    text.className = 'settings-row-text';
    name.className = 'settings-row-name';
    name.textContent = cfg.name;
    url.className = 'settings-row-url';
    url.textContent = cfg.hls;
    text.appendChild(name);
    text.appendChild(url);
    row.appendChild(text);
    row.appendChild(cameraBadge(cfg.id));

    if (state.confirmDeleteId === cfg.id) {
      confirmText = document.createElement('span');
      confirmText.className = 'settings-confirm-text';
      confirmText.textContent = 'Delete ' + cfg.name + '?';
      row.appendChild(confirmText);
      row.appendChild(makeSettingsButton('OK to confirm', {
        action: 'confirm-delete',
        cameraKey: cfg.id,
        focusKey: 'confirm-delete:' + cfg.id,
        danger: true,
        onPress: function () { deleteCamera(cfg.id); }
      }));
      return row;
    }

    row.appendChild(makeSettingsButton('Edit', {
      action: 'edit',
      cameraKey: cfg.id,
      focusKey: 'edit:' + cfg.id,
      onPress: function () { openForm(cfg.id); }
    }));
    row.appendChild(makeSettingsButton('Move up', {
      action: 'up',
      cameraKey: cfg.id,
      focusKey: 'up:' + cfg.id,
      disabled: index === 0,
      onPress: function () { moveCamera(cfg.id, -1); }
    }));
    row.appendChild(makeSettingsButton('Move down', {
      action: 'down',
      cameraKey: cfg.id,
      focusKey: 'down:' + cfg.id,
      disabled: index === cameraConfigs.length - 1,
      onPress: function () { moveCamera(cfg.id, 1); }
    }));
    if (cameraConfigs.length > 1) {
      row.appendChild(makeSettingsButton('Delete', {
        action: 'delete',
        cameraKey: cfg.id,
        focusKey: 'delete:' + cfg.id,
        danger: true,
        onPress: function () {
          state.confirmDeleteId = cfg.id;
          state.confirmReset = false;
          state.refocusKey = 'confirm-delete:' + cfg.id;
          renderCameras();
        }
      }));
    }
    return row;
  }

  /* ------------------------------------------------------------------
     Settings menu — four rows, each with a live one-line summary.
     ------------------------------------------------------------------ */

  /* "On · Popup · Quiet hours off", or the failure state. Rides the same
     GET the Notifications page uses (loadAlerts, called when the menu
     opens); renderMenu re-runs when that GET answers. */
  function notificationSummary() {
    var s = alerts.settings;
    var qh = s && s.quietHours;
    if (!alertsConfigured()) {
      return 'Not set up';
    }
    if (alerts.loadError) {
      return prefs.tvAlerts ? 'TV alert service unavailable' : 'Alert service unavailable';
    }
    if (!s) {
      return '…';
    }
    return (s.enabled === true ? 'On' : 'Off') + ' · ' +
      (prefs.tvAlerts ? 'This TV' : (s.style === 'toast' ? 'Toast' : 'Popup')) + ' · ' +
      (qh && qh.enabled === true ? 'Quiet hours on' : 'Quiet hours off');
  }

  /* A full-width menu row: title + muted summary + ">" chevron. */
  function makeMenuItem(view, title, summary) {
    var button = document.createElement('button');
    var text = document.createElement('span');
    var name = document.createElement('span');
    var line = document.createElement('span');
    var chevron = document.createElement('span');

    button.setAttribute('type', 'button');
    button.className = 'menu-item settings-focus';
    button.setAttribute('data-action', 'menu-' + view);
    button.setAttribute('data-focus-key', 'menu:' + view);

    text.className = 'menu-item-text';
    name.className = 'menu-item-title';
    name.textContent = title;
    line.className = 'menu-item-summary';
    line.textContent = summary;
    text.appendChild(name);
    text.appendChild(line);
    chevron.className = 'menu-item-chevron';
    chevron.textContent = '>';

    button.appendChild(text);
    button.appendChild(chevron);
    button.addEventListener('click', function () {
      openSettingsPage(view);
    });
    /* Magic Remote pointer: hovering shows the pointer's target. */
    button.addEventListener('mouseenter', function () {
      if (document.activeElement !== button) {
        button.focus();
      }
    });
    return button;
  }

  function renderMenu(refocusKey) {
    var menu = $('settings-menu');
    var active = document.activeElement;
    var key = refocusKey;
    var toFocus = null;

    if (state.view !== 'settings' || !menu) {
      return;
    }
    if (!key && state.refocusKey) {
      key = state.refocusKey;
      state.refocusKey = null;
    }
    if (!key && active && menu.contains(active) && active.getAttribute) {
      key = active.getAttribute('data-focus-key');
    }
    clearNode(menu);

    menu.appendChild(makeMenuItem('general', 'General',
      'Confirm exit: ' + (prefs.confirmExit === true ? 'On' : 'Off')));
    menu.appendChild(makeMenuItem('notifications', 'Notifications', notificationSummary()));
    menu.appendChild(makeMenuItem('cameras', 'Cameras',
      cameraConfigs.length + (cameraConfigs.length === 1 ? ' camera' : ' cameras')));
    menu.appendChild(makeMenuItem('developer', 'Developer',
      'Debug mode: ' + (prefs.debug === true ? 'On' : 'Off')));

    if (key) {
      toFocus = findFocusKey('settings-screen', key);
    }
    if (!toFocus) {
      toFocus = $('settings-screen').querySelector(SETTINGS_FOCUS);
    }
    if (toFocus) {
      toFocus.focus();
    }
  }

  /* OK on a menu item: swap to the sub-page, focus its first control. */
  function openSettingsPage(view) {
    console.log('[ui] open settings · ' + view);
    state.view = view;
    state.confirmDeleteId = null;
    state.confirmReset = false;
    showScreen(SETTINGS_VIEWS[view]);
    if (view === 'general') {
      renderGeneral(null);
    } else if (view === 'notifications') {
      loadAlerts();
    } else if (view === 'cameras') {
      renderCameras();
    } else if (view === 'developer') {
      renderDeveloper(null);
    }
  }

  /* Sub-page Back: the menu again, focused on this page's item. */
  function menuBack(focusKey) {
    state.confirmDeleteId = null;
    state.confirmReset = false;
    state.view = 'settings';
    showScreen('settings-screen');
    state.refocusKey = focusKey;
    renderMenu(null);
  }

  function openSettings() {
    console.log('[ui] open settings');
    state.view = 'settings';
    state.confirmDeleteId = null;
    state.confirmReset = false;
    $('grid-screen').classList.add('is-hidden');
    showScreen('settings-screen');
    renderMenu(null);
    loadAlerts(); /* the menu's Notifications summary rides this GET */
  }

  function closeSettings() {
    state.confirmDeleteId = null;
    state.confirmReset = false;
    state.view = 'grid';
    showScreen(null);
    $('grid-screen').classList.remove('is-hidden');
    focusTile(state.focusedId);
  }

  /* ------------------------------------------------------------------
     Settings · General — Confirm exit (local pref). More general
     options land here later.
     ------------------------------------------------------------------ */

  function renderGeneral(refocusKey) {
    var list = $('general-list');
    var active = document.activeElement;
    var key = refocusKey;
    var toFocus = null;
    var row;

    if (!list) {
      return;
    }
    if (!key && active && list.contains(active) && active.getAttribute) {
      key = active.getAttribute('data-focus-key');
    }
    clearNode(list);

    row = alertsRow('Confirm exit', 'Ask before leaving the app');
    row.appendChild(alertsToggleButton(prefs.confirmExit === true, {
      action: 'general-confirm-exit',
      focusKey: 'general:confirm-exit',
      onPress: function () {
        prefs.confirmExit = !prefs.confirmExit;
        savePrefs();
        renderGeneral('general:confirm-exit');
      }
    }));
    list.appendChild(row);

    row = alertsRow('Check for updates', 'Asks GitHub for the latest release; sends nothing about you');
    row.appendChild(alertsToggleButton(prefs.checkUpdates !== false, {
      action: 'general-check-updates',
      focusKey: 'general:check-updates',
      onPress: function () {
        prefs.checkUpdates = !prefs.checkUpdates;
        savePrefs();
        renderGeneral('general:check-updates');
      }
    }));
    list.appendChild(row);

    row = alertsRow('Version ' + APP_VERSION, updateStatusText());
    row.appendChild(makeSettingsButton('Check now', {
      action: 'general-update-check',
      focusKey: 'general:update-check',
      onPress: function () { checkForUpdate(true); }
    }));
    list.appendChild(row);

    if (state.view !== 'general') {
      return;
    }
    if (key) {
      toFocus = findFocusKey('general-screen', key);
    }
    if (!toFocus) {
      toFocus = $('general-screen').querySelector(SETTINGS_FOCUS);
    }
    if (toFocus) {
      toFocus.focus();
    }
  }

  /* ------------------------------------------------------------------
     Settings · Developer — the Debug mode toggle plus read-only info
     rows for bug reports from the couch.
     ------------------------------------------------------------------ */

  function browserSummary() {
    var match = /Chrome\/[0-9.]+/.exec(window.navigator.userAgent || '');
    return match ? match[0] : 'Unknown';
  }

  /* A settings row with a text field and one button. On the TV, OK on the field opens the
     system keyboard; ←/→ move the text cursor and only ↑/↓ leave it (see onKeyDown). */
  function devFieldRow(label, sub, key, value, placeholder, buttonLabel, onPress) {
    var row = alertsRow(label, sub);
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'dev-' + key;
    input.className = 'form-input settings-focus dev-input';
    input.setAttribute('data-focus-key', 'developer:' + key + '-input');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.placeholder = placeholder;
    input.value = value || '';
    row.appendChild(input);
    row.appendChild(makeSettingsButton(buttonLabel, {
      action: 'developer-' + key,
      focusKey: 'developer:' + key,
      onPress: function () { onPress(input.value.replace(/^\s+|\s+$/g, ''), key); }
    }));
    return row;
  }

  function devStatus(text, isError) {
    var el = $('developer-save-status');
    if (el) {
      el.className = 'alerts-save-status' + (isError ? ' is-error' : '');
      el.textContent = text;
    }
  }

  function saveLoggerServer(value, key) {
    if (value && !parseLoggerServer(value)) {
      devStatus('Not saved: log server must be host:port, e.g. 192.168.0.10:8765', true);
      return;
    }
    prefs.loggerServer = value;
    savePrefs();
    disconnectLogger();
    applyDebugSetting();
    devStatus(value ? 'Saved' + (prefs.debug ? '' : ' (turn Debug mode on to use it)') : 'Saved: log server off', false);
    renderDeveloper('developer:' + key);
  }

  function saveAlertsUrl(value, key) {
    if (value && !validAlertsUrl(value)) {
      devStatus('Not saved: alert service must look like http://192.168.0.10:8790', true);
      return;
    }
    prefs.alertsUrl = value;
    savePrefs();
    alerts.settings = null;
    alerts.loadError = false;
    devStatus(value ? 'Saved' : 'Saved: motion alerts off', false);
    renderDeveloper('developer:' + key);
  }

  /* One-time import of a user's own setup from a JSON file they host on their network:
     { "cameras": [{id, name, hls, snapshot}], "loggerServer": "host:port",
       "alertsUrl": "http://…", "debug": true, "confirmExit": true } — every key optional.
     Everything lands in this TV's localStorage; nothing is sent anywhere. */
  function importSettings(url, key) {
    var xhr;
    var done = false;
    if (!/^https?:\/\//i.test(url)) {
      devStatus('Not imported: enter the http:// address of the settings file', true);
      return;
    }
    devStatus('Importing…', false);
    function fail(reason) {
      if (done) {
        return;
      }
      done = true;
      devStatus('Not imported: ' + reason, true);
    }
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 5000;
      xhr.onload = function () {
        var data;
        var applied = [];
        var i;
        if (done) {
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail('HTTP ' + xhr.status);
          return;
        }
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          fail('not a JSON file');
          return;
        }
        if (!data || typeof data !== 'object') {
          fail('not a settings file');
          return;
        }
        if (data.cameras !== undefined) {
          if (!data.cameras || !data.cameras.length || data.cameras.length > MAX_CAMERAS) {
            fail('cameras must be a list of 1–' + MAX_CAMERAS);
            return;
          }
          for (i = 0; i < data.cameras.length; i++) {
            if (!validCameraConfig(data.cameras[i])) {
              fail('camera ' + (i + 1) + ' needs id, name and an http(s) stream URL');
              return;
            }
          }
        }
        if (data.loggerServer !== undefined && data.loggerServer !== '' && !parseLoggerServer(data.loggerServer)) {
          fail('loggerServer must be host:port');
          return;
        }
        if (data.alertsUrl !== undefined && data.alertsUrl !== '' && !validAlertsUrl(String(data.alertsUrl))) {
          fail('alertsUrl must be an http(s) address');
          return;
        }
        done = true;
        if (data.cameras) {
          cameraConfigs = [];
          for (i = 0; i < data.cameras.length; i++) {
            cameraConfigs.push({ id: data.cameras[i].id, name: data.cameras[i].name,
              hls: data.cameras[i].hls, snapshot: data.cameras[i].snapshot || '' });
          }
          saveCameraConfigs();
          buildCameras();
          rebuildGrid();
          applied.push(cameraConfigs.length + (cameraConfigs.length === 1 ? ' camera' : ' cameras'));
        }
        if (typeof data.loggerServer === 'string') {
          prefs.loggerServer = data.loggerServer;
          applied.push('log server');
        }
        if (typeof data.alertsUrl === 'string') {
          prefs.alertsUrl = data.alertsUrl;
          alerts.settings = null;
          alerts.loadError = false;
          applied.push('alert service');
        }
        if (typeof data.debug === 'boolean') {
          prefs.debug = data.debug;
        }
        if (typeof data.confirmExit === 'boolean') {
          prefs.confirmExit = data.confirmExit;
        }
        if (typeof data.tvAlerts === 'boolean') {
          prefs.tvAlerts = data.tvAlerts;
          applied.push(data.tvAlerts ? 'alerts on this TV' : 'network alerts');
        }
        if (typeof data.banner === 'boolean') {
          prefs.banner = data.banner;
        }
        if (typeof data.checkUpdates === 'boolean') {
          prefs.checkUpdates = data.checkUpdates;
        }
        savePrefs();
        tvStopEvents();
        stopAlertPolling();
        tvStart();
        startAlertPolling();
        disconnectLogger();
        applyDebugSetting();
        console.log('[settings] imported ' + (applied.join(', ') || 'preferences') + ' from ' + url);
        devStatus('Imported ' + (applied.join(', ') || 'preferences'), false);
        renderDeveloper('developer:' + key);
      };
      xhr.onerror = function () { fail('could not reach ' + url.replace(/^https?:\/\//i, '').split('/')[0]); };
      xhr.ontimeout = function () { fail('timed out'); };
      xhr.send(null);
    } catch (e) {
      fail(e.message || 'request failed');
    }
  }

  function renderDeveloper(refocusKey) {
    var list = $('developer-list');
    var active = document.activeElement;
    var key = refocusKey;
    var toFocus = null;
    var row;

    if (!list) {
      return;
    }
    if (!key && active && list.contains(active) && active.getAttribute) {
      key = active.getAttribute('data-focus-key');
    }
    clearNode(list);

    row = alertsRow('Debug mode', 'Phone home with dev logs');
    row.appendChild(alertsToggleButton(prefs.debug === true, {
      action: 'developer-debug',
      focusKey: 'developer:debug',
      onPress: function () {
        prefs.debug = !prefs.debug;
        savePrefs();
        applyDebugSetting();
        renderDeveloper('developer:debug');
      }
    }));
    list.appendChild(row);

    list.appendChild(devFieldRow('Log server', 'host:port of tools/logger-server.js · empty = off',
      'logger', prefs.loggerServer, '192.168.0.10:8765', 'Save', saveLoggerServer));
    list.appendChild(devFieldRow('Alert service', 'Motion-alert service address · empty = off',
      'alerts', prefs.alertsUrl, 'http://192.168.0.10:8790', 'Save', saveAlertsUrl));
    list.appendChild(devFieldRow('Import settings', 'Cameras and addresses from a JSON file on your network',
      'import', '', 'http://192.168.0.10/config.local.json', 'Import', importSettings));

    list.appendChild(alertsRow('App version', APP_VERSION));
    list.appendChild(alertsRow('Browser', browserSummary()));

    if (state.view !== 'developer') {
      return;
    }
    if (key) {
      toFocus = findFocusKey('developer-screen', key);
    }
    if (!toFocus) {
      toFocus = $('developer-screen').querySelector(SETTINGS_FOCUS);
    }
    if (toFocus) {
      toFocus.focus();
    }
  }

  /* ------------------------------------------------------------------
     Settings · Cameras — the camera list plus Add / Reset.
     ------------------------------------------------------------------ */

  function renderCameras() {
    var list = $('settings-list');
    var actions = $('settings-actions');
    var i;
    var resetText;
    var toFocus = null;

    clearNode(list);
    clearNode(actions);

    for (i = 0; i < cameraConfigs.length; i++) {
      list.appendChild(buildSettingsRow(cameraConfigs[i], i));
    }

    if (state.confirmReset) {
      resetText = document.createElement('span');
      resetText.className = 'settings-confirm-text';
      resetText.textContent = 'Reset to defaults?';
      actions.appendChild(resetText);
      actions.appendChild(makeSettingsButton('OK to confirm', {
        action: 'confirm-reset',
        focusKey: 'confirm-reset',
        danger: true,
        onPress: function () {
          state.confirmReset = false;
          state.confirmDeleteId = null;
          cameraConfigs = defaultCameraConfigs();
          applyCameras(null);
        }
      }));
    } else {
      if (cameraConfigs.length < MAX_CAMERAS) {
        actions.appendChild(makeSettingsButton('Add camera', {
          action: 'add',
          focusKey: 'add',
          primary: true,
          onPress: function () { openForm(null); }
        }));
      }
      actions.appendChild(makeSettingsButton('Reset to defaults', {
        action: 'reset',
        focusKey: 'reset',
        onPress: function () {
          state.confirmReset = true;
          state.confirmDeleteId = null;
          state.refocusKey = 'confirm-reset';
          renderCameras();
        }
      }));
    }

    if (state.refocusKey) {
      toFocus = findFocusKey('cameras-screen', state.refocusKey);
      state.refocusKey = null;
    }
    if (!toFocus) {
      toFocus = $('cameras-screen').querySelector(SETTINGS_FOCUS);
    }
    if (toFocus) {
      toFocus.focus();
    }
  }

  /* Back disarms a pending confirmation first; only then leaves Cameras. */
  function camerasBack() {
    var key;
    if (state.confirmDeleteId || state.confirmReset) {
      key = state.confirmDeleteId ? 'delete:' + state.confirmDeleteId : 'reset';
      state.confirmDeleteId = null;
      state.confirmReset = false;
      state.refocusKey = key;
      renderCameras();
      return;
    }
    menuBack('menu:cameras');
  }

  function moveCamera(cameraId, delta) {
    var i;
    var j;
    var tmp;
    for (i = 0; i < cameraConfigs.length; i++) {
      if (cameraConfigs[i].id === cameraId) {
        break;
      }
    }
    j = i + delta;
    if (i >= cameraConfigs.length || j < 0 || j >= cameraConfigs.length) {
      return;
    }
    tmp = cameraConfigs[i];
    cameraConfigs[i] = cameraConfigs[j];
    cameraConfigs[j] = tmp;
    applyCameras((delta < 0 ? 'up:' : 'down:') + cameraId);
  }

  /* Never deletes the last camera. */
  function deleteCamera(cameraId) {
    var i;
    var fallback;
    if (cameraConfigs.length <= 1) {
      return;
    }
    for (i = 0; i < cameraConfigs.length; i++) {
      if (cameraConfigs[i].id === cameraId) {
        break;
      }
    }
    if (i >= cameraConfigs.length) {
      return;
    }
    console.log('[settings] delete camera ' + cameraId);
    cameraConfigs.splice(i, 1);
    state.confirmDeleteId = null;
    fallback = i < cameraConfigs.length
      ? cameraConfigs[i].id
      : cameraConfigs[cameraConfigs.length - 1].id;
    applyCameras(fallback ? 'edit:' + fallback : null);
  }

  /* ================================================================
     Camera add/edit form
     ================================================================ */

  function setFieldError(inputId, errorId, message) {
    $(inputId).className = 'form-input form-focus' + (message ? ' has-error' : '');
    $(errorId).textContent = message || '';
  }

  function clearFormErrors() {
    setFieldError('form-name', 'form-name-error', '');
    setFieldError('form-url', 'form-url-error', '');
    setFieldError('form-snapshot', 'form-snapshot-error', '');
  }

  /* The form sits over Settings · Cameras and returns there on
     Save / Cancel / Back. */
  function openForm(cameraId) {
    var cfg = cameraId ? cameraConfigById(cameraId) : null;
    state.editingId = cfg ? cfg.id : null;
    state.confirmDeleteId = null;
    state.confirmReset = false;
    $('form-title').textContent = cfg ? 'Edit camera' : 'Add camera';
    $('form-name').value = cfg ? cfg.name : '';
    $('form-url').value = cfg ? cfg.hls : '';
    $('form-snapshot').value = cfg ? (cfg.snapshot || '') : '';
    clearFormErrors();
    state.view = 'form';
    showScreen('form-screen');
    $('form-name').focus();
  }

  function closeForm(refocusKey) {
    state.editingId = null;
    clearFormErrors();
    state.view = 'cameras';
    showScreen('cameras-screen');
    state.refocusKey = refocusKey || null;
    renderCameras();
  }

  function submitForm() {
    var name = $('form-name').value.replace(/^\s+|\s+$/g, '');
    var url = $('form-url').value.replace(/^\s+|\s+$/g, '');
    var snapshot = $('form-snapshot').value.replace(/^\s+|\s+$/g, '');
    var badId = null;
    var cfg;

    clearFormErrors();

    if (!name) {
      setFieldError('form-name', 'form-name-error', 'Name is required');
      badId = badId || 'form-name';
    }
    if (!url) {
      setFieldError('form-url', 'form-url-error', 'Stream URL is required');
      badId = badId || 'form-url';
    } else if (!/^https?:\/\//i.test(url)) {
      setFieldError('form-url', 'form-url-error', 'Stream URL must start with http:// or https://');
      badId = badId || 'form-url';
    }
    if (snapshot && !/^https?:\/\//i.test(snapshot)) {
      setFieldError('form-snapshot', 'form-snapshot-error', 'Preview URL must start with http:// or https://');
      badId = badId || 'form-snapshot';
    }

    if (badId) {
      $(badId).focus();
      return;
    }

    if (state.editingId) {
      cfg = cameraConfigById(state.editingId);
      if (!cfg) {
        closeForm();
        return;
      }
      /* The id stays stable across renames. */
      cfg.name = name;
      cfg.hls = url;
      cfg.snapshot = snapshot;
    } else {
      if (cameraConfigs.length >= MAX_CAMERAS) {
        closeForm();
        return;
      }
      cfg = { id: uniqueCameraId(name), name: name, hls: url, snapshot: snapshot };
      cameraConfigs.push(cfg);
    }

    console.log('[settings] saved camera ' + cfg.id);
    saveCameraConfigs();
    buildCameras();
    rebuildGrid();
    closeForm('edit:' + cfg.id);
  }

  /* ================================================================
     Settings · Notifications — the motion-alert service's do-not-disturb
     settings (docs/ALERTS.md). Buttons only (no text inputs): every press
     PUTs the whole settings object back, snooze goes through POST /snooze.
     A failed write reverts the UI to the last saved copy.
     ================================================================ */

  var ALERTS_XHR_TIMEOUT_MS = 4000;
  var ALERT_QUIET_STEP_MIN = 30;
  var ALERT_MAX_EVENTS = 5;
  var ALERT_SNOOZE_CHOICES = [
    { label: '30 min', minutes: 30 },
    { label: '1 h', minutes: 60 },
    { label: '3 h', minutes: 180 },
    { label: 'Until morning', minutes: -1 } /* next 07:00 local */
  ];
  var ALERT_TYPES = [
    { key: 'person', label: 'Person' },
    { key: 'vehicle', label: 'Vehicle' },
    { key: 'animal', label: 'Animal' },
    { key: 'motion', label: 'Any motion' }
  ];
  var ALERT_COOLDOWNS = [30, 60, 120, 300, 600, 1800];
  var ALERT_REASON_TEXT = {
    'disabled': 'alerts off',
    'camera-disabled': 'camera off',
    'type-disabled': 'type off',
    'snoozed': 'snoozed',
    'quiet-hours': 'quiet hours',
    'cooldown': 'cooldown',
    'viewing': 'already watching',
    'tv-unreachable': 'TV unreachable',
    'toast-failed': 'toast failed'
  };

  /* settings = live copy shown on screen; saved = last good server state. */
  var alerts = {
    loading: false,
    loadError: false,
    settings: null,
    saved: null,
    events: null,
    eventsError: false,
    pendingFocus: null /* set by loadAlerts(): focus to use at the first full render ('' = default control) */
  };
  var alertsSaveTimer = null;

  function cloneAlertsSettings(settings) {
    return JSON.parse(JSON.stringify(settings));
  }

  /* ------------------------------------------------------------------
     This TV's own alert service (service/), reached over Luna. The page's alertsRequest() routes
     here when prefs.tvAlerts is on, so the Notifications page works the same for both sources.
     ------------------------------------------------------------------ */

  var tv = { info: null, events: null };
  var ALERT_TYPE_LABEL = { person: 'Person', vehicle: 'Vehicle', animal: 'Animal', motion: 'Motion' };

  /* One Luna request to our service; cb(errorText | null, payload). */
  function tvCall(method, params, cb) {
    var bridge;
    var done = false;
    var timer;
    function finish(error, payload) {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      cb(error, payload);
    }
    if (!window.PalmServiceBridge) {
      setTimeout(function () { finish('this needs a webOS TV', null); }, 0);
      return;
    }
    timer = setTimeout(function () { finish('service timeout', null); }, 8000);
    try {
      bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function (raw) {
        var payload = null;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          finish('bad reply', null);
          return;
        }
        if (payload && payload.returnValue === false) {
          finish(payload.errorText || 'failed', payload);
        } else {
          finish(null, payload);
        }
      };
      bridge.call('luna://' + TV_SERVICE_ID + '/' + method, JSON.stringify(params || {}));
    } catch (e) {
      finish(e && e.message ? e.message : 'Luna call failed', null);
    }
  }

  /* Tell the service our cameras (names for the alert text, ids for the webhook) and make sure it listens. */
  function tvConfigure(cb) {
    var cams = [];
    var i;
    for (i = 0; i < cameraConfigs.length; i++) {
      cams.push({ id: cameraConfigs[i].id, name: cameraConfigs[i].name });
    }
    tvCall('configure', { cameras: cams }, function (error, payload) {
      if (!error && payload) {
        tv.info = { ip: payload.ip, port: payload.port, token: payload.token, listening: payload.listening };
      } else {
        tv.info = { error: error || 'failed' };
        console.warn('[alerts] TV service: ' + tv.info.error);
      }
      if (cb) {
        cb(error);
      }
    });
  }

  /* While the app is on screen it subscribes, and the service then sends alerts here as a banner
     instead of a toast. Hidden or closed: the subscription ends and alerts become toasts again. */
  function tvStartEvents() {
    var bridge;
    if (tv.events || !prefs.tvAlerts || !prefs.banner || !window.PalmServiceBridge || document.hidden) {
      return;
    }
    try {
      bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function (raw) {
        var payload = null;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          return;
        }
        if (payload && payload.event) {
          showAlertBanner(payload.event);
        }
      };
      bridge.call('luna://' + TV_SERVICE_ID + '/events', JSON.stringify({ subscribe: true }));
      tv.events = bridge;
    } catch (e) {
      tv.events = null;
    }
  }

  function tvStopEvents() {
    if (tv.events) {
      try {
        tv.events.cancel();
      } catch (e) {
        /* already gone */
      }
      tv.events = null;
    }
  }

  function tvStart() {
    if (!prefs.tvAlerts) {
      return;
    }
    tvConfigure(function (error) {
      if (!error) {
        tvStartEvents();
      }
    });
  }

  /* The Notifications page's four calls, answered by the service instead of an HTTP alert service. */
  function tvAlertsRequest(method, path, body, callback) {
    if (path === '/settings' && method === 'GET') {
      tvCall('settings', {}, function (error, payload) {
        callback(error, payload && payload.settings ? payload.settings : null);
      });
    } else if (path === '/settings' && method === 'PUT') {
      tvCall('putSettings', { settings: body }, callback);
    } else if (path === '/snooze' && method === 'POST') {
      tvCall('snooze', { minutes: body.minutes }, callback);
    } else if (path === '/status' && method === 'GET') {
      tvCall('status', {}, callback);
    } else {
      setTimeout(function () { callback('unsupported', null); }, 0);
    }
  }

  /* ------------------------------------------------------------------
     In-app banner: a motion alert (or an update notice) over whatever is on screen.
     OK opens the camera, Back dismisses; a pointer click works as OK.
     ------------------------------------------------------------------ */

  var BANNER_MS = 10000;
  var bannerTimer = null;

  function hideBanner() {
    clearTimeout(bannerTimer);
    bannerTimer = null;
    state.banner = null;
    $('banner').className = 'banner is-hidden';
  }

  function showBanner(title, detail, hint, cameraId) {
    $('banner-title').textContent = title;
    $('banner-detail').textContent = detail || '';
    $('banner-hint').textContent = hint;
    $('banner').className = 'banner';
    state.banner = { camera: cameraId || null };
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, BANNER_MS);
  }

  function showAlertBanner(event) {
    var name = event.name || event.camera;
    var label = event.type === 'test' ? 'Test alert' : (ALERT_TYPE_LABEL[event.type] || 'Motion') + ' detected';
    console.log('[alerts] banner: ' + name + ' ' + label);
    showBanner(name + ': ' + label, formatClock(new Date()), 'OK  Watch      BACK  Dismiss', event.camera);
  }

  /* OK or click on the banner: open that camera (leaving Settings first). */
  function activateBanner() {
    var cameraId = state.banner ? state.banner.camera : null;
    hideBanner();
    if (!cameraId || state.view === 'form') {
      return;
    }
    if (SETTINGS_VIEWS[state.view]) {
      closeSettings();
    }
    openCameraFromLaunch(cameraId);
  }

  /* Network alert service: it holds an alert back while this app is open ("already watching"),
     so while the app is on screen poll its recent events and turn those into banners. */
  var alertPoll = { timer: null, lastAt: null };

  function stopAlertPolling() {
    clearInterval(alertPoll.timer);
    alertPoll.timer = null;
  }

  function startAlertPolling() {
    function poll() {
      if (document.hidden) {
        return;
      }
      alertsRequest('GET', '/status', null, function (error, data) {
        var events;
        var newest;
        var cfg;
        var i;
        if (error || !data || !data.events) {
          return;
        }
        events = data.events;
        newest = events.length ? events[0].at : '';
        if (alertPoll.lastAt === null) {
          alertPoll.lastAt = newest;
          return;
        }
        for (i = events.length - 1; i >= 0; i--) { /* oldest first */
          if (events[i].at > alertPoll.lastAt && events[i].reason === 'viewing') {
            cfg = cameraConfigById(events[i].camera);
            showAlertBanner({ camera: events[i].camera, name: cfg ? cfg.name : events[i].camera, type: events[i].type });
          }
        }
        if (newest > alertPoll.lastAt) {
          alertPoll.lastAt = newest;
        }
      });
    }
    stopAlertPolling();
    alertPoll.lastAt = null;
    if (prefs.tvAlerts || !prefs.banner || !alertsBase()) {
      return;
    }
    alertPoll.timer = setInterval(poll, 3000);
    poll();
  }

  /* ------------------------------------------------------------------
     Update check. Reads the release feed (a static JSON file on GitHub) and compares versions.
     Installing is not possible from inside the TV (the TV denies it to apps without root), so this
     only tells the user; updater/ is the job that installs it.
     ------------------------------------------------------------------ */

  var updateInfo = { latest: '', checking: false, error: '' };

  function versionParts(v) {
    var m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
  }

  /* true when version a is newer than version b */
  function versionNewer(a, b) {
    var pa = versionParts(a);
    var pb = versionParts(b);
    var i;
    if (!pa || !pb) {
      return false;
    }
    for (i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) {
        return pa[i] > pb[i];
      }
    }
    return false;
  }

  function updateStatusText() {
    if (updateInfo.checking) {
      return 'Checking…';
    }
    if (updateInfo.error) {
      return 'Could not check (' + updateInfo.error + ')';
    }
    if (!updateInfo.latest) {
      return 'Not checked yet';
    }
    return versionNewer(updateInfo.latest, APP_VERSION)
      ? 'Update available: ' + updateInfo.latest
      : 'Up to date';
  }

  function checkForUpdate(manual) {
    var xhr;
    function finish() {
      updateInfo.checking = false;
      if (state.view === 'general') {
        renderGeneral(manual ? 'general:update-check' : null);
      }
    }
    if (updateInfo.checking) {
      return;
    }
    updateInfo.checking = true;
    updateInfo.error = '';
    if (state.view === 'general') {
      renderGeneral(null);
    }
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', UPDATE_FEED_URL, true);
      xhr.timeout = 10000;
      xhr.onload = function () {
        var feed;
        var i;
        var pkg = null;
        try {
          feed = JSON.parse(xhr.responseText);
          for (i = 0; i < feed.packages.length; i++) {
            if (feed.packages[i].id === APP_ID) {
              pkg = feed.packages[i];
            }
          }
          if (xhr.status !== 200 || !pkg || !versionParts(pkg.manifest.version)) {
            throw new Error('unexpected feed');
          }
        } catch (e) {
          updateInfo.error = 'bad feed';
          finish();
          return;
        }
        updateInfo.latest = pkg.manifest.version;
        prefs.lastUpdateCheck = Date.now();
        console.log('[update] latest ' + updateInfo.latest + ', running ' + APP_VERSION);
        if (versionNewer(updateInfo.latest, APP_VERSION) && prefs.seenUpdate !== updateInfo.latest) {
          prefs.seenUpdate = updateInfo.latest;
          showBanner('Update available: ' + updateInfo.latest, 'You have ' + APP_VERSION,
            'BACK  Dismiss', null);
        }
        savePrefs();
        finish();
      };
      xhr.onerror = function () { updateInfo.error = 'offline'; finish(); };
      xhr.ontimeout = function () { updateInfo.error = 'timed out'; finish(); };
      xhr.send(null);
    } catch (e) {
      updateInfo.error = 'failed';
      finish();
    }
  }

  function alertsHost() {
    return alertsBase().replace(/^https?:\/\//i, '').split(':')[0];
  }

  /* Plain XHR with a short timeout; callback(errorText, parsedJson). With no alert service
     configured (Settings · Developer) it fails at once with 'not configured'. */
  function alertsRequest(method, path, body, callback) {
    var xhr;
    var finished = false;
    function finish(error, data) {
      if (finished) {
        return;
      }
      finished = true;
      callback(error, data);
    }
    if (prefs.tvAlerts) {
      tvAlertsRequest(method, path, body, callback);
      return;
    }
    if (!alertsBase()) {
      setTimeout(function () { finish('not configured', null); }, 0);
      return;
    }
    try {
      xhr = new XMLHttpRequest();
      xhr.open(method, alertsBase() + path, true);
      xhr.timeout = ALERTS_XHR_TIMEOUT_MS;
      if (body !== null) {
        xhr.setRequestHeader('Content-Type', 'application/json');
      }
      xhr.onload = function () {
        var data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch (e) {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          finish(null, data);
        } else {
          finish(data && data.error ? data.error : 'HTTP ' + xhr.status, data);
        }
      };
      xhr.onerror = function () {
        finish('service unreachable', null);
      };
      xhr.ontimeout = function () {
        finish('service timeout', null);
      };
      xhr.send(body !== null ? JSON.stringify(body) : null);
    } catch (e) {
      finish(e && e.message ? e.message : 'request failed', null);
    }
  }

  function loadAlerts(focusKey) {
    alerts.pendingFocus = focusKey || '';
    alerts.loading = true;
    alerts.loadError = false;
    alerts.settings = null;
    alerts.saved = null;
    alerts.events = null;
    alerts.eventsError = false;
    renderAlerts(null);
    renderMenu(null);
    alertsRequest('GET', '/settings', null, function (error, data) {
      if (error || !data || typeof data !== 'object') {
        console.warn('[alerts] load failed: ' + (error || 'bad response'));
        alerts.loading = false;
        alerts.loadError = true;
        renderAlerts(null);
        renderMenu(null);
        return;
      }
      alerts.loading = false;
      alerts.settings = cloneAlertsSettings(data);
      alerts.saved = cloneAlertsSettings(data);
      renderAlerts(null);
      renderMenu(null);
      alertsRequest('GET', '/status', null, function (statusError, statusData) {
        if (!statusError && statusData && statusData.events) {
          alerts.events = statusData.events;
        } else {
          alerts.eventsError = true;
        }
        renderAlerts(null);
      });
    });
  }

  /* Small "Saved" / "Not saved: <reason>" line, cleared after 3 s. */
  function showAlertsSaveStatus(text, isError) {
    var el = $('alerts-save-status');
    if (!el) {
      return;
    }
    el.className = 'alerts-save-status' + (isError ? ' is-error' : '');
    el.textContent = text;
    if (alertsSaveTimer) {
      clearTimeout(alertsSaveTimer);
    }
    alertsSaveTimer = setTimeout(function () {
      alertsSaveTimer = null;
      el.textContent = '';
    }, 3000);
  }

  /* Back from Notifications: clear the status timer, return to the menu. */
  function closeNotifications() {
    if (alertsSaveTimer) {
      clearTimeout(alertsSaveTimer);
      alertsSaveTimer = null;
    }
    menuBack('menu:notifications');
  }

  function alertsRow(label, sub) {
    var row = document.createElement('div');
    var text = document.createElement('div');
    var name = document.createElement('span');
    var subEl;

    row.className = 'settings-row';
    text.className = 'settings-row-text';
    name.className = 'settings-row-name';
    name.textContent = label;
    text.appendChild(name);
    if (sub) {
      subEl = document.createElement('span');
      subEl.className = 'settings-row-url';
      subEl.textContent = sub;
      text.appendChild(subEl);
    }
    row.appendChild(text);
    return row;
  }

  function alertsMessageRow(text, retry) {
    var row = alertsRow(text, null);
    if (retry) {
      row.appendChild(makeSettingsButton(retry.label, {
        action: 'alerts-retry',
        focusKey: retry.focusKey,
        primary: true,
        onPress: retry.onPress
      }));
    }
    return row;
  }

  /* A toggle button: On/Off text plus a green "on" border — state is
     never carried by colour alone. */
  function alertsToggleButton(isOn, opts) {
    var button = makeSettingsButton(isOn ? 'On' : 'Off', opts);
    if (isOn) {
      button.className += ' is-on';
    }
    return button;
  }

  function alertsStepperLabel(text) {
    var span = document.createElement('span');
    span.className = 'alert-stepper-label';
    span.textContent = text;
    return span;
  }

  function alertsStepperValue(valueKey, text) {
    var span = document.createElement('span');
    span.className = 'alert-value';
    span.setAttribute('data-value', valueKey);
    span.textContent = text;
    return span;
  }

  /* "HH:MM" stepped by ALERT_QUIET_STEP_MIN minutes, wrapping midnight. */
  function stepAlertTime(value, direction) {
    var parts = String(value || '0:0').split(':');
    var minutes = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
    minutes += direction * ALERT_QUIET_STEP_MIN;
    minutes = ((minutes % 1440) + 1440) % 1440;
    return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
  }

  function alertCooldownLabel(seconds) {
    if (typeof seconds !== 'number') {
      return '?';
    }
    return seconds < 60 ? seconds + ' s' : Math.round(seconds / 60) + ' min';
  }

  /* Seconds snapped on ALERT_COOLDOWNS; a service value between two steps
     snaps down on − and up on +. */
  function stepAlertCooldown(current, direction) {
    var idx = 0;
    var i;
    for (i = 0; i < ALERT_COOLDOWNS.length; i++) {
      if (ALERT_COOLDOWNS[i] <= current) {
        idx = i;
      }
    }
    if (ALERT_COOLDOWNS[idx] === current) {
      idx += direction;
    } else if (direction > 0) {
      idx += 1;
    }
    if (idx < 0) {
      idx = 0;
    }
    if (idx > ALERT_COOLDOWNS.length - 1) {
      idx = ALERT_COOLDOWNS.length - 1;
    }
    return ALERT_COOLDOWNS[idx];
  }

  /* "Until morning" = minutes until the next 07:00 in the TV's local time. */
  function minutesUntilAlertMorning() {
    var now = new Date();
    var next = new Date(now.getTime());
    next.setHours(7, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return Math.max(1, Math.round((next.getTime() - now.getTime()) / 60000));
  }

  function alertEventType(type) {
    if (type === 'person' || type === 'vehicle' || type === 'animal') {
      return type.charAt(0).toUpperCase() + type.slice(1);
    }
    return 'Motion';
  }

  /* "23:41 Front · Person · sent" / "23:41 Back · Motion · quiet hours" */
  function alertEventLine(event) {
    var cfg = cameraConfigById(event.camera);
    var who = cfg ? cfg.name : (event.camera || '?');
    var why = event.sent
      ? 'sent'
      : ALERT_REASON_TEXT[event.reason] || event.reason || 'unknown';
    var time = event.at ? formatClock(new Date(event.at)) : '';
    return (time ? time + ' ' : '') + who + ' · ' + alertEventType(event.type) + ' · ' + why;
  }

  function alertsEventsRow() {
    var row = alertsRow('Recent', null);
    var text = row.firstChild;
    var events = alerts.events || [];
    var line;
    var i;
    var count = Math.min(ALERT_MAX_EVENTS, events.length);

    if (alerts.eventsError) {
      line = document.createElement('span');
      line.className = 'settings-row-url';
      line.textContent = 'Events unavailable';
      text.appendChild(line);
      return row;
    }
    if (alerts.events === null) {
      line = document.createElement('span');
      line.className = 'settings-row-url';
      line.textContent = 'Loading…';
      text.appendChild(line);
      return row;
    }
    if (!count) {
      line = document.createElement('span');
      line.className = 'settings-row-url';
      line.textContent = 'No events yet';
      text.appendChild(line);
      return row;
    }
    for (i = 0; i < count; i++) {
      line = document.createElement('span');
      line.className = 'settings-row-url alert-event';
      line.textContent = alertEventLine(events[i]);
      text.appendChild(line);
    }
    return row;
  }

  /* Apply a mutation optimistically and PUT the whole settings object. */
  function alertsMutate(focusKey, change) {
    if (!alerts.settings) {
      return;
    }
    change(alerts.settings);
    renderAlerts(focusKey);
    putAlerts(focusKey);
  }

  function putAlerts(focusKey) {
    if (!alerts.settings) {
      return;
    }
    /* The service validates strictly; a 400's error text becomes the
       "Not saved" reason and the UI reverts to the last saved copy. */
    alertsRequest('PUT', '/settings', alerts.settings, function (error, data) {
      if (error || !data || data.ok !== true) {
        console.warn('[alerts] save failed: ' + (error || 'rejected'));
        if (alerts.saved) {
          alerts.settings = cloneAlertsSettings(alerts.saved);
        }
        renderAlerts(focusKey);
        showAlertsSaveStatus('Not saved: ' + (error || 'rejected'), true);
        return;
      }
      if (data.settings) {
        alerts.settings = cloneAlertsSettings(data.settings);
      }
      alerts.saved = cloneAlertsSettings(alerts.settings);
      renderAlerts(null);
      showAlertsSaveStatus('Saved', false);
    });
  }

  function snoozeAlerts(minutes, focusKey) {
    if (minutes < 0) {
      minutes = minutesUntilAlertMorning();
    }
    alertsRequest('POST', '/snooze', { minutes: minutes }, function (error, data) {
      if (error || !data || data.ok !== true) {
        console.warn('[alerts] snooze failed: ' + (error || 'rejected'));
        renderAlerts(focusKey);
        showAlertsSaveStatus('Not saved: ' + (error || 'rejected'), true);
        return;
      }
      if (alerts.settings) {
        alerts.settings.snoozeUntil = data.snoozeUntil;
      }
      if (alerts.saved) {
        alerts.saved.snoozeUntil = data.snoozeUntil;
      }
      renderAlerts(null);
      showAlertsSaveStatus('Saved', false);
    });
  }

  /* A row of read-only text lines (used for the URL other systems call). */
  function alertsInfoRow(label, lines) {
    var row = alertsRow(label, null);
    var text = row.firstChild;
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = document.createElement('span');
      line.className = 'settings-row-url alert-event';
      line.textContent = lines[i];
      text.appendChild(line);
    }
    return row;
  }

  function alertSourceRow() {
    var row = alertsRow('Alert source', prefs.tvAlerts
      ? 'This TV receives alerts from your home automation'
      : 'A network alert service sends alerts to this TV');
    row.appendChild(makeSettingsButton(prefs.tvAlerts ? 'This TV' : 'Network service', {
      action: 'alerts-source',
      focusKey: 'alerts:source',
      onPress: toggleAlertSource
    }));
    return row;
  }

  /* TV mode: where to send alerts, and a test button. */
  function appendTvInfoRows(list) {
    var info = tv.info;
    var row;
    var firstId = cameraConfigs.length ? cameraConfigs[0].id : '';
    if (!info) {
      return;
    }
    if (info.error) {
      row = alertsRow('Alert service on this TV', 'Not running: ' + info.error);
      row.appendChild(makeSettingsButton('Retry', {
        action: 'alerts-tv-retry',
        focusKey: 'alerts:tv:retry',
        onPress: function () { tvStart(); loadAlerts(); }
      }));
      list.appendChild(row);
      return;
    }
    list.appendChild(alertsInfoRow('Send alerts to this TV', [
      'POST http://' + info.ip + ':' + info.port + '/motion?camera=' + (firstId || '<id>') + '&type=person',
      'token=' + info.token + '    (camera ids: ' + cameraConfigs.map(function (c) { return c.id; }).join(', ') + ')'
    ]));
    row = alertsRow('Test alert', 'Shows a banner now, or a toast if you leave the app');
    row.appendChild(makeSettingsButton('Send test', {
      action: 'alerts-tv-test',
      focusKey: 'alerts:tv:test',
      onPress: function () {
        tvCall('test', { camera: firstId }, function (error) {
          showAlertsSaveStatus(error ? 'Not sent: ' + error : 'Sent', !!error);
        });
      }
    }));
    list.appendChild(row);
  }

  /* No control below the source row yet: keep D-pad focus on it. */
  function focusAlertsEntry(key) {
    var el;
    if (state.view !== 'notifications') {
      return;
    }
    el = findFocusKey('notifications-screen', key || 'alerts:source') || findFocusKey('notifications-screen', 'alerts:source');
    if (el) {
      el.focus();
    }
  }

  function toggleAlertSource() {
    if (!prefs.tvAlerts && !window.PalmServiceBridge) {
      showAlertsSaveStatus('This mode needs a webOS TV', true);
      return;
    }
    prefs.tvAlerts = !prefs.tvAlerts;
    savePrefs();
    alerts.settings = null;
    alerts.loadError = false;
    tvStopEvents();
    stopAlertPolling();
    if (prefs.tvAlerts) {
      alerts.loading = true;
      renderAlerts('alerts:source');
      tvConfigure(function () {
        tvStartEvents();
        loadAlerts('alerts:source');
      });
    } else {
      tv.info = null;
      loadAlerts('alerts:source');
      startAlertPolling();
    }
  }

  function renderAlerts(refocusKey) {
    var list = $('alerts-list');
    var active = document.activeElement;
    var key = refocusKey;
    var toFocus = null;
    var s;
    var row;
    var i;

    /* Keep D-pad focus on the same control across re-renders. */
    if (!key && active && list.contains(active) && active.getAttribute) {
      key = active.getAttribute('data-focus-key');
    }
    clearNode(list);

    /* Where alerts come from: this TV's own service, or a network alert service. */
    list.appendChild(alertSourceRow());
    if (prefs.tvAlerts) {
      appendTvInfoRows(list);
    }

    if (alerts.loading) {
      list.appendChild(alertsMessageRow('Loading…', null));
      focusAlertsEntry(key);
      return;
    }

    if (!alertsConfigured()) {
      list.appendChild(alertsMessageRow(
        'Choose "This TV", or set a network alert service address in Settings · Developer.', null));
      focusAlertsEntry(key);
      return;
    }

    if (alerts.loadError || !alerts.settings) {
      list.appendChild(alertsMessageRow(
        (prefs.tvAlerts ? 'The alert service on this TV did not answer' : 'Alert service unreachable (' + alertsHost() + ')') +
        '. OK to retry', {
        label: 'Retry',
        focusKey: 'alerts:retry',
        onPress: function () { if (prefs.tvAlerts) { tvStart(); } loadAlerts(); }
      }));
      if (state.view === 'notifications') {
        toFocus = findFocusKey('notifications-screen', 'alerts:retry');
        if (toFocus) {
          toFocus.focus();
        }
      }
      return;
    }

    /* First full render after a load: start from the default control (or the one the caller named),
       not wherever the loading placeholder left focus. */
    if (alerts.pendingFocus !== null) {
      key = alerts.pendingFocus || null;
      alerts.pendingFocus = null;
    }

    s = alerts.settings;

    /* Display notifications: the service's master switch. */
    row = alertsRow('Display notifications', null);
    row.appendChild(alertsToggleButton(s.enabled === true, {
      action: 'alerts-enabled',
      focusKey: 'alerts:enabled',
      onPress: function () {
        alertsMutate('alerts:enabled', function (x) {
          x.enabled = !(x.enabled === true);
        });
      }
    }));
    list.appendChild(row);

    /* In-app banner (both sources). Off: alerts show as a TV toast even while the app is open. */
    row = alertsRow('In-app banner', 'While watching: a banner here instead of a toast over the video');
    row.appendChild(alertsToggleButton(prefs.banner !== false, {
      action: 'alerts-banner',
      focusKey: 'alerts:banner',
      onPress: function () {
        prefs.banner = !prefs.banner;
        savePrefs();
        if (prefs.tvAlerts) {
          tvStopEvents();
          tvStartEvents();
        } else {
          startAlertPolling();
        }
        renderAlerts('alerts:banner');
      }
    }));
    list.appendChild(row);

    /* Popup (default; absent in older service settings) or toast. Only the network service can show a popup. */
    if (!prefs.tvAlerts) {
      row = alertsRow('Alert style', 'Popup with buttons, or a corner toast');
      row.appendChild(makeSettingsButton(s.style === 'toast' ? 'Toast' : 'Popup', {
        action: 'alerts-style',
        focusKey: 'alerts:style',
        onPress: function () {
          alertsMutate('alerts:style', function (x) {
            x.style = x.style === 'toast' ? 'popup' : 'toast';
          });
        }
      }));
      list.appendChild(row);
    }

    /* Snooze */
    row = alertsRow('Snooze',
      s.snoozeUntil && s.snoozeUntil > Date.now()
        ? 'Snoozed until ' + formatClock(new Date(s.snoozeUntil))
        : null);
    for (i = 0; i < ALERT_SNOOZE_CHOICES.length; i++) {
      (function (choice) {
        var focusKey = 'alerts:snooze:' + choice.minutes;
        row.appendChild(makeSettingsButton(choice.label, {
          action: 'alerts-snooze:' + choice.minutes,
          focusKey: focusKey,
          onPress: function () {
            snoozeAlerts(choice.minutes, focusKey);
          }
        }));
      })(ALERT_SNOOZE_CHOICES[i]);
    }
    row.appendChild(makeSettingsButton('Off', {
      action: 'alerts-snooze:0',
      focusKey: 'alerts:snooze:0',
      onPress: function () {
        snoozeAlerts(0, 'alerts:snooze:0');
      }
    }));
    list.appendChild(row);

    /* Cameras: one toggle per camera id, named from the app's own list. */
    if (s.cameras) {
      var cameraIds = [];
      var cameraId;
      for (cameraId in s.cameras) {
        if (Object.prototype.hasOwnProperty.call(s.cameras, cameraId)) {
          cameraIds.push(cameraId);
        }
      }
      for (i = 0; i < cameraIds.length; i++) {
        (function (id) {
          var cfg = cameraConfigById(id);
          var on = s.cameras[id] !== false;
          var camRow = alertsRow(cfg ? cfg.name : id, null);
          camRow.appendChild(alertsToggleButton(on, {
            action: 'alerts-camera:' + id,
            focusKey: 'alerts:camera:' + id,
            onPress: function () {
              alertsMutate('alerts:camera:' + id, function (x) {
                x.cameras[id] = x.cameras[id] === false;
              });
            }
          }));
          list.appendChild(camRow);
        })(cameraIds[i]);
      }
    }

    /* Detection types */
    row = alertsRow('Detect', null);
    for (i = 0; i < ALERT_TYPES.length; i++) {
      (function (type) {
        var on = !s.types || s.types[type.key] !== false;
        var focusKey = 'alerts:type:' + type.key;
        var toggle = makeSettingsButton(type.label + ': ' + (on ? 'On' : 'Off'), {
          action: 'alerts-type:' + type.key,
          focusKey: focusKey,
          onPress: function () {
            alertsMutate(focusKey, function (x) {
              if (!x.types) {
                x.types = {};
              }
              x.types[type.key] = !on;
            });
          }
        });
        if (on) {
          toggle.className += ' is-on';
        }
        row.appendChild(toggle);
      })(ALERT_TYPES[i]);
    }
    list.appendChild(row);

    /* Quiet hours: toggle + start/end steppers in 30-minute steps */
    var qh = s.quietHours || { enabled: false, start: '23:00', end: '07:00' };
    row = alertsRow('Quiet hours', null);
    row.appendChild(alertsToggleButton(qh.enabled === true, {
      action: 'alerts-qh-enabled',
      focusKey: 'alerts:qh:toggle',
      onPress: function () {
        alertsMutate('alerts:qh:toggle', function (x) {
          if (!x.quietHours) {
            x.quietHours = { enabled: false, start: '23:00', end: '07:00' };
          }
          x.quietHours.enabled = !x.quietHours.enabled;
        });
      }
    }));
    row.appendChild(alertsStepperLabel('Start'));
    row.appendChild(makeSettingsButton('−', {
      action: 'alerts-qh-start-dec',
      focusKey: 'alerts:qh:start:dec',
      onPress: function () {
        alertsMutate('alerts:qh:start:dec', function (x) {
          x.quietHours.start = stepAlertTime(x.quietHours && x.quietHours.start, -1);
        });
      }
    }));
    row.appendChild(alertsStepperValue('alerts-qh-start', qh.start || '00:00'));
    row.appendChild(makeSettingsButton('+', {
      action: 'alerts-qh-start-inc',
      focusKey: 'alerts:qh:start:inc',
      onPress: function () {
        alertsMutate('alerts:qh:start:inc', function (x) {
          x.quietHours.start = stepAlertTime(x.quietHours && x.quietHours.start, 1);
        });
      }
    }));
    row.appendChild(alertsStepperLabel('End'));
    row.appendChild(makeSettingsButton('−', {
      action: 'alerts-qh-end-dec',
      focusKey: 'alerts:qh:end:dec',
      onPress: function () {
        alertsMutate('alerts:qh:end:dec', function (x) {
          x.quietHours.end = stepAlertTime(x.quietHours && x.quietHours.end, -1);
        });
      }
    }));
    row.appendChild(alertsStepperValue('alerts-qh-end', qh.end || '00:00'));
    row.appendChild(makeSettingsButton('+', {
      action: 'alerts-qh-end-inc',
      focusKey: 'alerts:qh:end:inc',
      onPress: function () {
        alertsMutate('alerts:qh:end:inc', function (x) {
          x.quietHours.end = stepAlertTime(x.quietHours && x.quietHours.end, 1);
        });
      }
    }));
    list.appendChild(row);

    /* Cooldown stepper */
    var cooldown = typeof s.cooldownSeconds === 'number' ? s.cooldownSeconds : 0;
    row = alertsRow('Cooldown', null);
    row.appendChild(makeSettingsButton('−', {
      action: 'alerts-cooldown-dec',
      focusKey: 'alerts:cooldown:dec',
      disabled: cooldown <= ALERT_COOLDOWNS[0],
      onPress: function () {
        alertsMutate('alerts:cooldown:dec', function (x) {
          x.cooldownSeconds = stepAlertCooldown(x.cooldownSeconds, -1);
        });
      }
    }));
    row.appendChild(alertsStepperValue('alerts-cooldown', alertCooldownLabel(s.cooldownSeconds)));
    row.appendChild(makeSettingsButton('+', {
      action: 'alerts-cooldown-inc',
      focusKey: 'alerts:cooldown:inc',
      disabled: cooldown >= ALERT_COOLDOWNS[ALERT_COOLDOWNS.length - 1],
      onPress: function () {
        alertsMutate('alerts:cooldown:inc', function (x) {
          x.cooldownSeconds = stepAlertCooldown(x.cooldownSeconds, 1);
        });
      }
    }));
    list.appendChild(row);

    /* Suppress while the viewer is in the foreground (network service only: this TV uses the banner) */
    if (!prefs.tvAlerts) {
      row = alertsRow('Not while watching', null);
      row.appendChild(alertsToggleButton(s.suppressWhileViewing === true, {
        action: 'alerts-watching',
        focusKey: 'alerts:watching',
        onPress: function () {
          alertsMutate('alerts:watching', function (x) {
            x.suppressWhileViewing = !(x.suppressWhileViewing === true);
          });
        }
      }));
      list.appendChild(row);
    }

    /* Recent events, read-only */
    list.appendChild(alertsEventsRow());

    if (state.view !== 'notifications') {
      return;
    }
    if (key) {
      toFocus = findFocusKey('notifications-screen', key);
    }
    if (!toFocus) {
      /* the main on/off switch first; the source row above it is a rarely used control */
      toFocus = findFocusKey('notifications-screen', 'alerts:enabled') ||
        $('notifications-screen').querySelector(SETTINGS_FOCUS);
    }
    if (toFocus) {
      toFocus.focus();
    }
  }

  /* ================================================================
     Remote input
     ================================================================ */

  function onKeyDown(event) {
    var code = event.keyCode || event.which;
    var direction = DIRS[code];
    var active = document.activeElement;
    var inInput;
    var cameraId;

    /* Banner (alert or update notice): OK opens its camera, Back dismisses. Not while typing in a field. */
    if (state.banner && (code === 461 || code === 27 ||
        (code === 13 && !(active && active.tagName === 'INPUT')))) {
      event.preventDefault();
      if (code === 13) {
        activateBanner();
      } else {
        hideBanner();
      }
      return;
    }

    /* Exit-confirm modal: it sits over the grid, so handle its keys first.
       ←/→ move between Cancel/Exit, OK activates, Back/Escape cancels. */
    if (state.exitConfirm) {
      if (direction) {
        event.preventDefault();
        if (direction === 'left' || direction === 'right') {
          moveFocusSpatial('#exit-dialog .btn', direction);
        }
        return;
      }
      if (code === 13) {
        event.preventDefault();
        if (active && typeof active.click === 'function') {
          active.click();
        }
        return;
      }
      if (code === 461 || code === 27) {
        event.preventDefault();
        closeExitDialog();
      }
      return;
    }

    /* Camera form: while a text input is focused, Left/Right belong to the
       text cursor (and OK opens the system keyboard) — only Up/Down leave
       the field. Back cancels the form; when the system keyboard consumed
       the key we never see the event at all. */
    if (state.view === 'form') {
      inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (direction) {
        if (inInput && (direction === 'left' || direction === 'right')) {
          return;
        }
        event.preventDefault();
        moveFocusSpatial('#form-screen .form-focus', direction);
        return;
      }
      if (code === 13) {
        if (inInput) {
          return;
        }
        event.preventDefault();
        if (active && typeof active.click === 'function') {
          active.click();
        }
        return;
      }
      if (code === 461 || code === 27) {
        event.preventDefault();
        closeForm();
      }
      return;
    }

    /* Text fields on settings pages (Developer): same rule as the camera form. */
    inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if (inInput && SETTINGS_VIEWS[state.view] &&
        (code === 13 || direction === 'left' || direction === 'right')) {
      return;
    }

    if (direction) {
      event.preventDefault();
      if (state.view === 'grid') {
        gridMoveFocus(direction);
      } else if (SETTINGS_VIEWS[state.view]) {
        /* Scoped to the visible screen: hidden screens' hidden buttons have
           zero-size rects that spatial navigation would otherwise accept.
           (The form handled its arrows above and never gets here.) */
        moveFocusSpatial('#' + SETTINGS_VIEWS[state.view] + ' ' + SETTINGS_FOCUS, direction);
      } else if (state.view === 'player' && (direction === 'left' || direction === 'right')) {
        switchCamera(direction === 'left' ? -1 : 1);
      }
      return;
    }

    if (code === 13) {
      event.preventDefault();
      if (state.view === 'grid') {
        cameraId = active && active.getAttribute
          ? active.getAttribute('data-camera-id')
          : null;
        if (active && active.id === 'settings-btn') {
          openSettings();
        } else if (cameraId) {
          openPlayer(cameraById(cameraId));
        }
      } else if (SETTINGS_VIEWS[state.view]) {
        /* Menu and every settings sub-page: the focused button fires. */
        if (active && typeof active.click === 'function') {
          active.click();
        }
      } else if (state.view === 'player') {
        retryIfDead();
      }
      return;
    }

    /* 461 is LG's Back key; 27 is Escape, kept for laptop testing. */
    if (code === 461 || code === 27) {
      event.preventDefault();
      if (state.view === 'player') {
        closePlayer();
      } else if (state.view === 'cameras') {
        camerasBack();
      } else if (state.view === 'notifications') {
        closeNotifications();
      } else if (state.view === 'general' || state.view === 'developer') {
        menuBack('menu:' + state.view);
      } else if (state.view === 'settings') {
        closeSettings();
      } else {
        /* Grid Back: confirm first unless the user switched that off. */
        if (prefs.confirmExit !== false) {
          openExitDialog();
        } else {
          exitApp();
        }
      }
    }
  }

  /* ================================================================
     Start
     ================================================================ */

  /* Settings pages outgrow 1080p. When focus moves to a button inside a scroll area, scroll
     it fully into view with a margin; don't rely on Chromium 53's native focus scrolling. */
  function keepFocusInView(event) {
    var el = event.target;
    var box = el && el.closest ? el.closest('.settings-scroll') : null;
    var r;
    var b;
    var margin = 24;
    if (!box) {
      return;
    }
    r = el.getBoundingClientRect();
    b = box.getBoundingClientRect();
    if (r.top < b.top + margin) {
      box.scrollTop -= (b.top + margin) - r.top;
    } else if (r.bottom > b.bottom - margin) {
      box.scrollTop += r.bottom - (b.bottom - margin);
    }
  }

  function start() {
    ensureHlsAvailable();
    state.handler = new StreamHandler();

    state.handler.on('statusChange', function (handle) {
      var line = '[stream] ' + handle.cameraId + ' -> ' + handle.status;
      if (handle.status === 'dead') {
        console.error(line + (handle.lastError ? ' (' + handle.lastError.code + ')' : ''));
      } else if (handle.status === 'backoff') {
        console.warn(line + ' retry=' + handle.retryCount + ' delay=' + handle.backoffDelay + 'ms');
      } else {
        console.log(line);
      }
      renderHandle(handle);
    });

    state.handler.on('error', function (handle, error) {
      console.error('[stream] ' + handle.cameraId + ' error ' + error.code + ': ' + error.message);
    });

    state.handler.on('streamReady', function (handle) {
      console.log('[stream] ' + handle.cameraId + ' live' +
        (state.openedAt ? ' after ' + (Date.now() - state.openedAt) + ' ms' : ''));
    });

    state.handler.on('streamConnect', onStreamConnect);

    $('settings-btn').addEventListener('click', function () {
      openSettings();
    });
    $('settings-btn').addEventListener('mouseenter', function () {
      var button = $('settings-btn');
      if (document.activeElement !== button) {
        button.focus();
      }
    });
    $('form-save').addEventListener('click', submitForm);
    $('form-cancel').addEventListener('click', function () {
      closeForm();
    });

    $('banner').addEventListener('click', activateBanner);
    $('exit-cancel').addEventListener('click', closeExitDialog);
    $('exit-confirm').addEventListener('click', exitApp);
    /* Magic Remote pointer: hovering shows the pointer's target. */
    $('exit-cancel').addEventListener('mouseenter', function () {
      $('exit-cancel').focus();
    });
    $('exit-confirm').addEventListener('mouseenter', function () {
      $('exit-confirm').focus();
    });

    loadCameraConfigs();
    buildCameras();
    rebuildGrid();

    refreshAllSnapshots();
    setInterval(refreshAllSnapshots, SNAPSHOT_INTERVAL_MS);

    /* Alerts: this TV's service (subscribe while visible) or polling a network alert service. */
    tvStart();
    startAlertPolling();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        tvStopEvents();
        hideBanner();
      } else {
        tvStart();
      }
    });
    if (prefs.checkUpdates !== false && !isLocalDev() &&
        Date.now() - prefs.lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS) {
      setTimeout(function () { checkForUpdate(false); }, 8000);
    }

    document.addEventListener('focus', keepFocusInView, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keydown', onAnyKeyForChrome, true);

    updateClock();
    setInterval(tick, 1000);

    document.addEventListener('webOSRelaunch', function (event) {
      var cameraId = readLaunchCamera(event && event.detail);
      if (!cameraId && window.PalmSystem) {
        cameraId = readLaunchCamera(window.PalmSystem.launchParams);
      }
      openCameraFromLaunch(cameraId);
    });

    setTimeout(function () {
      focusTile(state.focusedId);
      openCameraFromLaunch(initialLaunchCamera());
    }, 0);
  }

  loadPrefs(); /* before connectLogger: Debug mode gates the socket at startup */
  installLogger();
  connectLogger();
  console.log('[app] Webcam Viewer starting' + (DEV_MOCK ? ' (DEV_MOCK)' : ''));

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
