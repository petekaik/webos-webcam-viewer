#!/usr/bin/env node
/**
 * mock-camera-server.js — laptop-side stand-in for the two real cameras.
 *
 * Serves, with no npm dependencies:
 *   http://127.0.0.1:8888/<id>/index.m3u8   live-ish looping HLS playlist
 *   http://127.0.0.1:8888/<id>/segN.ts      MPEG-TS segments (generated with ffmpeg)
 *   https://127.0.0.1:8889/snap.jpeg        static JPEG over a SELF-SIGNED cert
 *   http://127.0.0.1:8888/app/...           the app itself, so it runs from http://
 *
 * The HTTPS snapshot is the point: the real cameras use self-signed certs and
 * webOS 4.4.3 has previously blocked them outright. Reproducing that locally
 * is the only way to exercise the failure mode before the real deploy.
 *
 * Broken-camera toggle (for reconnect/backoff work):
 *   MOCK_BROKEN=1 node mock-camera-server.js
 *   or request any camera URL with ?broken=1 / ?fail=1
 *   or prefix the path with /broken/  (e.g. /broken/front/index.m3u8)
 * Camera endpoints then return 404.
 *
 * Env:
 *   MOCK_HTTP_PORT   default 8888 (matches the app's hardcoded HLS port)
 *   MOCK_HTTPS_PORT  default MOCK_HTTP_PORT + 1
 *   MOCK_HOST        default 127.0.0.1 (use 0.0.0.0 to expose on the LAN)
 *   MOCK_APP_DIR     default <repo>/app
 *   MOCK_BROKEN      "1" to serve 404 for every camera endpoint
 *
 * Requirements: node, openssl (self-signed cert), ffmpeg (test HLS/jpeg).
 * If ffmpeg is missing the server still runs; HLS simply has no media.
 */
'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var os = require('os');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

var HTTP_PORT = parseInt(process.env.MOCK_HTTP_PORT || '8888', 10);
var HTTPS_PORT = parseInt(process.env.MOCK_HTTPS_PORT || String(HTTP_PORT + 1), 10);
var HOST = process.env.MOCK_HOST || '127.0.0.1';
var BROKEN = process.env.MOCK_BROKEN === '1';
var APP_DIR = process.env.MOCK_APP_DIR
	? path.resolve(process.env.MOCK_APP_DIR)
	: path.resolve(__dirname, '..', '..', 'app');

var CAMERA_IDS = ['front', 'back'];

var MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.m3u8': 'application/vnd.apple.mpegurl',
	'.ts': 'video/mp2t',
	'.map': 'application/json'
};

// 1x1 white JPEG. Only used if ffmpeg cannot generate a nicer test pattern.
var FALLBACK_JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
	'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
	'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR' +
	'CAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
	'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK' +
	'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG' +
	'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl' +
	'5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
	'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk' +
	'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE' +
	'hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk' +
	'5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
	'base64'
);

var tmpDirs = [];

function makeTempDir(prefix) {
	var dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

// ── media ────────────────────────────────────────────────────────────────

var media = {dir: null, segments: [], playlistCounter: {}};
var snapshot = FALLBACK_JPEG;

function generateMedia() {
	var dir = makeTempDir('webos-cam-media-');
	var playlistPath = path.join(dir, 'index.m3u8');
	try {
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error', '-y',
			'-f', 'lavfi',
			'-i', 'testsrc=size=640x360:rate=25:duration=6',
			'-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
			'-g', '50',
			'-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
			'-hls_segment_filename', path.join(dir, 'seg%d.ts'),
			playlistPath
		], {stdio: ['ignore', 'ignore', 'pipe']});
	} catch (err) {
		console.warn('[mock] ffmpeg could not generate HLS media: ' +
			(err && err.message ? err.message.split('\n')[0] : err));
		console.warn('[mock]   HLS endpoints will serve a playlist with no segments.');
		return {dir: dir, segments: [], playlistCounter: {}};
	}

	var text = fs.readFileSync(playlistPath, 'utf8');
	var segments = [];
	var pendingDuration = null;
	text.split(/\r?\n/).forEach(function (line) {
		if (line.indexOf('#EXTINF:') === 0) {
			pendingDuration = parseFloat(line.slice(8));
		} else if (line && line.charAt(0) !== '#' && pendingDuration !== null) {
			segments.push({file: path.basename(line), duration: pendingDuration});
			pendingDuration = null;
		}
	});

	if (segments.length === 0) {
		console.warn('[mock] ffmpeg produced no segments; HLS will be empty.');
	}
	return {dir: dir, segments: segments, playlistCounter: {}};
}

function generateSnapshot() {
	var out = path.join(media.dir, 'snap.jpeg');
	try {
		execFileSync('ffmpeg', [
			'-hide_banner', '-loglevel', 'error', '-y',
			'-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=1:duration=1',
			'-frames:v', '1', '-q:v', '4', out
		], {stdio: ['ignore', 'ignore', 'pipe']});
		return fs.readFileSync(out);
	} catch (err) {
		console.warn('[mock] ffmpeg could not generate snapshot JPEG; using 1x1 fallback.');
		return FALLBACK_JPEG;
	}
}

/**
 * Build a live playlist that loops the generated segments.
 * Each request slides the media sequence forward by one segment-window and
 * inserts a discontinuity between rounds, so clients can keep playing forever
 * without pretending the repeated timestamps are continuous.
 */
function buildPlaylist(cameraId) {
	var n = media.segments.length;
	if (n === 0) {
		return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n';
	}

	var count = media.playlistCounter[cameraId] || 0;
	media.playlistCounter[cameraId] = count + 1;

	var base = count * n;
	var target = 1;
	var lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
	media.segments.forEach(function (s) {
		if (s.duration > target) target = Math.ceil(s.duration);
	});
	lines.push('#EXT-X-TARGETDURATION:' + target);
	lines.push('#EXT-X-MEDIA-SEQUENCE:' + base);
	lines.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + count);

	for (var round = 0; round < 2; round++) {
		if (round > 0) lines.push('#EXT-X-DISCONTINUITY');
		media.segments.forEach(function (s, i) {
			lines.push('#EXTINF:' + s.duration.toFixed(3) + ',');
			lines.push(s.file + '?seq=' + (base + round * n + i));
		});
	}
	return lines.join('\n') + '\n';
}

// ── self-signed cert ─────────────────────────────────────────────────────

function generateCert() {
	var dir = makeTempDir('webos-cam-cert-');
	var keyPath = path.join(dir, 'key.pem');
	var certPath = path.join(dir, 'cert.pem');
	var confPath = path.join(dir, 'openssl.cnf');

	fs.writeFileSync(confPath, [
		'[req]',
		'distinguished_name = dn',
		'x509_extensions = v3',
		'prompt = no',
		'[dn]',
		'CN = localhost',
		'[v3]',
		'subjectAltName = DNS:localhost, IP:127.0.0.1',
		''
	].join('\n'));

	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
		'-keyout', keyPath, '-out', certPath, '-config', confPath
	], {stdio: ['ignore', 'ignore', 'pipe']});

	return {
		key: fs.readFileSync(keyPath),
		cert: fs.readFileSync(certPath)
	};
}

// ── helpers ──────────────────────────────────────────────────────────────

function send(res, status, body, headers) {
	res.statusCode = status;
	var h = headers || {};
	if (body !== undefined && body !== null && !res.getHeader('Content-Type') && !h['Content-Type']) {
		h['Content-Type'] = 'text/plain; charset=utf-8';
	}
	h['Access-Control-Allow-Origin'] = '*';
	Object.keys(h).forEach(function (k) {
		res.setHeader(k, h[k]);
	});
	res.end(body);
}

function isBroken(urlObj, pathname) {
	if (BROKEN) return true;
	if (pathname.indexOf('/broken/') === 0) return true;
	var flag = urlObj.searchParams.get('broken') || urlObj.searchParams.get('fail');
	return flag === '1' || flag === 'true';
}

function serveAppFile(res, pathname) {
	var rel = pathname.replace(/^\/app\/?/, '');
	if (rel === '' || rel.charAt(rel.length - 1) === '/') rel += 'index.html';

	var appRoot = path.resolve(APP_DIR);
	var file = path.resolve(appRoot, rel);
	if (file !== appRoot && file.indexOf(appRoot + path.sep) !== 0) {
		return send(res, 403, 'Forbidden');
	}

	fs.readFile(file, function (err, data) {
		if (err) return send(res, 404, 'Not found: ' + pathname);
		var type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
		send(res, 200, data, {
			'Content-Type': type,
			'Cache-Control': 'no-store'
		});
	});
}

function handleHttp(req, res) {
	var urlObj;
	try {
		urlObj = new URL(req.url, 'http://localhost');
	} catch (err) {
		return send(res, 400, 'Bad request');
	}

	var pathname = decodeURIComponent(urlObj.pathname);
	var broken = isBroken(urlObj, pathname);
	if (pathname.indexOf('/broken/') === 0) pathname = pathname.slice('/broken'.length);

	if (req.method === 'OPTIONS') {
		return send(res, 204, '', {
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Allow-Headers': '*'
		});
	}

	if (pathname === '/healthz') {
		return send(res, 200, JSON.stringify({
			ok: true,
			broken: broken,
			cameras: CAMERA_IDS,
			segments: media.segments.length,
			appDir: APP_DIR,
			appPresent: fs.existsSync(path.join(APP_DIR, 'index.html'))
		}), {'Content-Type': 'application/json; charset=utf-8'});
	}

	if (pathname === '/') {
		if (fs.existsSync(path.join(APP_DIR, 'index.html'))) {
			res.statusCode = 302;
			res.setHeader('Location', '/app/index.html');
			return res.end();
		}
		return send(res, 200, [
			'webOS webcam mock camera server',
			'',
			'HLS:      http://127.0.0.1:' + HTTP_PORT + '/front/index.m3u8',
			'Snapshot: https://127.0.0.1:' + HTTPS_PORT + '/snap.jpeg (self-signed)',
			'App:      not built yet (' + APP_DIR + '/index.html missing)',
			'',
			'Set MOCK_APP_DIR to serve a built app under /app/.',
			'Broken toggle: MOCK_BROKEN=1, ?broken=1, or /broken/<id>/index.m3u8'
		].join('\n'));
	}

	if (pathname === '/app' || pathname.indexOf('/app/') === 0) {
		return serveAppFile(res, pathname);
	}

	var hlsMatch = pathname.match(/^\/([^/]+)\/index\.m3u8$/);
	if (hlsMatch) {
		if (CAMERA_IDS.indexOf(hlsMatch[1]) === -1) return send(res, 404, 'Unknown camera id');
		if (broken) return send(res, 404, 'camera down (mock broken mode)');
		return send(res, 200, buildPlaylist(hlsMatch[1]), {
			'Content-Type': MIME['.m3u8'],
			'Cache-Control': 'no-cache, no-store, must-revalidate'
		});
	}

	var segMatch = pathname.match(/^\/([^/]+)\/([A-Za-z0-9_.-]+\.ts)$/);
	if (segMatch) {
		if (CAMERA_IDS.indexOf(segMatch[1]) === -1) return send(res, 404, 'Unknown camera id');
		if (broken) return send(res, 404, 'camera down (mock broken mode)');
		var segFile = path.basename(segMatch[2]);
		return fs.readFile(path.join(media.dir, segFile), function (err, data) {
			if (err) return send(res, 404, 'No such segment');
			send(res, 200, data, {
				'Content-Type': MIME['.ts'],
				'Cache-Control': 'public, max-age=60'
			});
		});
	}

	// Plain-HTTP snapshot, like webcam-web's /snap/<id>.jpg on the NAS.
	if (pathname === '/snap.jpeg') {
		if (broken) return send(res, 404, 'camera down (mock broken mode)');
		return send(res, 200, snapshot, {
			'Content-Type': MIME['.jpeg'],
			'Cache-Control': 'no-store'
		});
	}

	send(res, 404, 'Not found: ' + pathname);
}

function handleHttps(req, res) {
	var urlObj;
	try {
		urlObj = new URL(req.url, 'https://localhost');
	} catch (err) {
		return send(res, 400, 'Bad request');
	}

	var pathname = decodeURIComponent(urlObj.pathname);
	var broken = isBroken(urlObj, pathname);
	if (pathname.indexOf('/broken/') === 0) pathname = pathname.slice('/broken'.length);

	if (pathname === '/healthz') {
		return send(res, 200, JSON.stringify({ok: true, broken: broken, https: true}),
			{'Content-Type': 'application/json; charset=utf-8'});
	}

	if (pathname === '/snap.jpeg' || /^\/[^/]+\/snap\.jpeg$/.test(pathname)) {
		if (broken) return send(res, 404, 'camera down (mock broken mode)');
		return send(res, 200, snapshot, {
			'Content-Type': MIME['.jpeg'],
			'Cache-Control': 'no-store'
		});
	}

	send(res, 404, 'Not found: ' + pathname);
}

// ── main ─────────────────────────────────────────────────────────────────

function main() {
	media = generateMedia();
	snapshot = generateSnapshot();

	var cert;
	try {
		cert = generateCert();
	} catch (err) {
		console.error('[mock] FATAL: could not create a self-signed cert with openssl.');
		console.error('[mock]   The HTTPS snapshot endpoint is the main reason this server exists.');
		console.error('[mock]   ' + (err && err.message ? err.message.split('\n')[0] : err));
		process.exit(1);
	}

	var httpServer = http.createServer(function (req, res) {
		try {
			handleHttp(req, res);
		} catch (err) {
			console.error('[mock] handler error:', err);
			send(res, 500, 'Internal mock error');
		}
	});

	var httpsServer = https.createServer(cert, function (req, res) {
		try {
			handleHttps(req, res);
		} catch (err) {
			console.error('[mock] HTTPS handler error:', err);
			send(res, 500, 'Internal mock error');
		}
	});

	function onListenError(name) {
		return function (err) {
			if (err && err.code === 'EADDRINUSE') {
				console.error('[mock] ' + name + ' port already in use: ' + err.port);
				console.error('[mock]   Stop the other process or set MOCK_HTTP_PORT / MOCK_HTTPS_PORT.');
			} else {
				console.error('[mock] ' + name + ' server error:', err);
			}
			shutdown(1);
		};
	}

	httpServer.on('error', onListenError('HTTP'));
	httpsServer.on('error', onListenError('HTTPS'));

	httpServer.listen(HTTP_PORT, HOST, function () {
		httpsServer.listen(HTTPS_PORT, HOST, function () {
			console.log('[mock] webOS webcam mock camera server');
			console.log('[mock]   HLS:      http://127.0.0.1:' + HTTP_PORT + '/front/index.m3u8');
			console.log('[mock]             http://127.0.0.1:' + HTTP_PORT + '/back/index.m3u8');
			console.log('[mock]   Snapshot: https://127.0.0.1:' + HTTPS_PORT + '/snap.jpeg  (self-signed)');
			console.log('[mock]   Health:   http://127.0.0.1:' + HTTP_PORT + '/healthz');
			if (fs.existsSync(path.join(APP_DIR, 'index.html'))) {
				console.log('[mock]   App:      http://127.0.0.1:' + HTTP_PORT + '/app/index.html');
			} else {
				console.log('[mock]   App:      not built yet (' + APP_DIR + '/index.html missing)');
			}
			console.log('[mock]   Broken:   MOCK_BROKEN=1, ?broken=1, or /broken/<id>/index.m3u8');
			console.log('[mock]   Media:    ' + media.segments.length + ' segment(s) in ' + media.dir);
			if (media.segments.length === 0) {
				console.log('[mock]             (empty HLS — install ffmpeg for playable test media)');
			}
		});
	});

	var shuttingDown = false;
	function shutdown(code) {
		if (shuttingDown) return;
		shuttingDown = true;
		try { httpServer.close(); } catch (e) { /* ignore */ }
		try { httpsServer.close(); } catch (e) { /* ignore */ }
		tmpDirs.forEach(function (dir) {
			try { fs.rmSync(dir, {recursive: true, force: true}); } catch (e) { /* ignore */ }
		});
		process.exit(code || 0);
	}

	process.on('SIGINT', function () { shutdown(0); });
	process.on('SIGTERM', function () { shutdown(0); });
}

main();
