/* Webcam Viewer service (runs on the TV, Node 0.12: ES5 only).
   Receives motion alerts over HTTP on the LAN (POST /motion?camera=<id>&type=<type>&token=<token>),
   applies the do-not-disturb rules, and delivers the alert as an in-app banner when the app is open
   (it subscribes to 'events') or as a toast that opens the camera when the app is closed.
   The app owns the settings UI and talks to this service over Luna (configure, settings, putSettings,
   snooze, status, events, test). Verified on webOS 4.4.3: LAN listener, activity keep-alive, createToast
   with onclick. createAlert (popup with buttons) is denied to services, so toast is the delivery. */
'use strict';

var pkgInfo = require('./package.json');
var Service = require('webos-service');
var http = require('http');
var fs = require('fs');
var os = require('os');
var url = require('url');
var crypto = require('crypto');
var alertCore = require('./lib/core');

var APP_ID = 'com.petekaik.webcamviewer';
var STATE_DIR = '/media/internal/webcam-viewer';
var STATE_FILE = STATE_DIR + '/alerts.json';
var TYPE_LABEL = { person: 'Person', vehicle: 'Vehicle', animal: 'Animal', motion: 'Motion' };

var service = new Service(pkgInfo.name);
var bootedAt = Date.now();
var keepAlive = null;
var server = null;
var listenPort = 0;
var listenError = null;
var subscribers = {};

/* Without an open activity the library stops the service 5 s after its last request. */
service.activityManager.create('keepAlive', function (activity) {
  keepAlive = activity;
});

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveState(data) {
  try {
    try {
      fs.mkdirSync(STATE_DIR);
    } catch (e) {
      /* exists */
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('could not save state: ' + (e && e.message));
  }
}

function eventText(event) {
  var label = event.type === 'test' ? 'Test alert' : (TYPE_LABEL[event.type] || 'Motion') + ' detected';
  var text = event.name + ': ' + label;
  return text.length > 60 ? text.slice(0, 59) + '…' : text;
}

function subscriberCount() {
  return Object.keys(subscribers).length;
}

/* App open (subscribed): banner. App closed: toast whose click opens the camera. */
function deliver(event, cb) {
  var delivered = 0;
  Object.keys(subscribers).forEach(function (token) {
    try {
      subscribers[token].respond({ returnValue: true, event: event });
      delivered++;
    } catch (e) {
      delete subscribers[token];
    }
  });
  if (delivered > 0) {
    cb(null, 'banner');
    return;
  }
  service.call('luna://com.webos.notification/createToast', {
    message: eventText(event),
    onclick: { appId: APP_ID, params: { camera: event.camera, source: 'alert' } }
  }, function (m) {
    var p = m && m.payload;
    if (p && p.returnValue) {
      cb(null, 'toast');
    } else {
      cb(new Error((p && p.errorText) || 'toast failed'));
    }
  });
}

var core = alertCore.createCore({
  now: function () { return Date.now(); },
  load: loadState,
  save: saveState,
  randomToken: function () { return crypto.randomBytes(8).toString('hex'); },
  deliver: deliver
});

function localIp() {
  var nets = os.networkInterfaces();
  var ip = '';
  Object.keys(nets).forEach(function (name) {
    nets[name].forEach(function (a) {
      if (!ip && a.family === 'IPv4' && !a.internal) {
        ip = a.address;
      }
    });
  });
  return ip;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body) + '\n');
}

function handleHttp(req, res) {
  var parsed = url.parse(req.url, true);
  var q = parsed.query || {};
  if (parsed.pathname === '/motion' && (req.method === 'GET' || req.method === 'POST')) {
    req.resume();
    core.handleMotion({ camera: q.camera, type: q.type, token: q.token }, function (status, body) {
      send(res, status, body);
    });
  } else if (parsed.pathname === '/health') {
    send(res, 200, { ok: true, app: APP_ID });
  } else {
    send(res, 404, { ok: false, error: 'not found' });
  }
}

function startServer(port, done) {
  var finished = false;
  function finish(err) {
    if (!finished) {
      finished = true;
      done(err);
    }
  }
  function open() {
    var s = http.createServer(handleHttp);
    s.on('error', function (e) {
      listenError = e.message;
      finish(e);
    });
    s.listen(port, '0.0.0.0', function () {
      server = s;
      listenPort = port;
      listenError = null;
      finish(null);
    });
  }
  if (server && listenPort === port) {
    finish(null);
  } else if (server) {
    server.close(function () {
      server = null;
      open();
    });
  } else {
    open();
  }
}

function info() {
  return {
    listening: !!server && !listenError,
    port: listenPort || core.port(),
    ip: localIp(),
    token: core.token(),
    error: listenError || undefined
  };
}

function reply(message, payload) {
  payload.returnValue = payload.returnValue === false ? false : true;
  message.respond(payload);
}

service.register('configure', function (message) {
  var cfg = core.configure(message.payload || {});
  startServer(cfg.port, function (err) {
    var out = info();
    out.returnValue = !err;
    if (err) {
      out.errorText = err.message;
    }
    message.respond(out);
  });
});

service.register('settings', function (message) {
  reply(message, { settings: core.getSettings() });
});

service.register('putSettings', function (message) {
  var r = core.putSettings(message.payload && message.payload.settings);
  if (r.ok) {
    reply(message, { ok: true, settings: r.settings });
  } else {
    message.respond({ returnValue: false, errorText: r.errors.join('; '), errors: r.errors });
  }
});

service.register('snooze', function (message) {
  var r = core.snooze(message.payload && message.payload.minutes);
  if (r.ok) {
    reply(message, { ok: true, snoozeUntil: r.snoozeUntil });
  } else {
    message.respond({ returnValue: false, errorText: r.error });
  }
});

service.register('status', function (message) {
  var out = info();
  var st = core.status();
  out.events = st.events;
  out.subscribers = subscriberCount();
  out.uptimeS = Math.round((Date.now() - bootedAt) / 1000);
  out.node = process.version;
  reply(message, out);
});

service.register('test', function (message) {
  core.test(message.payload && message.payload.camera, function (r) {
    if (r.ok) {
      reply(message, { ok: true, via: r.via });
    } else {
      message.respond({ returnValue: false, errorText: r.error });
    }
  });
});

/* Subscription: the app subscribes while it is on screen and cancels when it is hidden or closed. */
var events = service.register('events');
events.on('request', function (message) {
  if (message.isSubscription) {
    subscribers[message.uniqueToken] = message;
  }
  message.respond({ returnValue: true, subscribed: !!message.isSubscription });
});
events.on('cancel', function (message) {
  delete subscribers[message.uniqueToken];
});
