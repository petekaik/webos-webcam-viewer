'use strict';

/**
 * smoke.spec.js — laptop-side smoke test for the webOS webcam viewer.
 *
 * Loads app/index.html in Playwright's Chromium against the mock camera
 * server, then drives it the way the TV remote does:
 *   - no uncaught page errors
 *   - both camera tiles render
 *   - ArrowRight / ArrowLeft (keyCode 39 / 37) move DOM focus between tiles
 *   - Enter (13) opens the fullscreen player
 *   - Back (461) returns to the grid
 *
 * Extra: the grid must survive (a) camera endpoints returning 404 and
 * (b) a self-signed HTTPS snapshot being blocked — the exact failure mode
 * webOS 4.4.3 hit on the real device.
 *
 * This is NOT a substitute for the TV. Playwright's Chromium is modern, so
 * Chromium-53 syntax/runtime quirks are covered by es5-check.js and the real
 * device only. See README.md.
 */

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const HTTP_PORT = Number(process.env.MOCK_HTTP_PORT || 8888);
const HTTPS_PORT = Number(process.env.MOCK_HTTPS_PORT || HTTP_PORT + 1);
const APP_DIR = process.env.MOCK_APP_DIR
	? path.resolve(process.env.MOCK_APP_DIR)
	: path.resolve(__dirname, '..', '..', 'app');
const APP_INDEX = path.join(APP_DIR, 'index.html');
const APP_URL = '/app/index.html';

// The app's markup is not owned by QA; try the shapes Dev is likely to use.
const TILE_SELECTORS = [
	'[data-camera-id]',
	'[data-camera]',
	'[data-tile]',
	'.camera-tile',
	'.tile',
	'main button',
	'button'
];

const FULLSCREEN_SELECTORS = [
	'video',
	'[data-view="fullscreen"]',
	'#fullscreen',
	'.fullscreen',
	'.fullscreen-player',
	'.player'
];

function formatErrors(errors) {
	return errors.map(function (err) {
		return err && err.stack ? err.stack : String(err);
	}).join('\n---\n');
}

/** Rewrite the app's hardcoded LAN camera URLs to the local mock. */
async function routeCameras(page, broken) {
	await page.route('**/*', async function (route) {
		let requestUrl;
		try {
			requestUrl = new URL(route.request().url());
		} catch (err) {
			return route.continue();
		}

		// Camera URL shapes: webcam-web's /hls/<id>/... and /snap/<id>.jpg, plus the
		// cameras' own /snap.jpeg (still accepted in Settings).
		let pathname = requestUrl.pathname;
		const isHls = /\.m3u8$/i.test(pathname) || /\.ts$/i.test(pathname);
		const isSnapshot = /\/snap(\/[^/]+)?\.jpe?g$/i.test(pathname);
		if (!isHls && !isSnapshot) return route.continue();
		pathname = isSnapshot ? '/snap.jpeg' : pathname.replace(/^\/hls\//, '/');

		// Keep the request's protocol (route.continue() can't change it): HTTPS
		// snapshots hit the self-signed mock, everything else the HTTP mock.
		const base = isSnapshot && requestUrl.protocol === 'https:'
			? 'https://127.0.0.1:' + HTTPS_PORT
			: 'http://127.0.0.1:' + HTTP_PORT;

		let query = '';
		try {
			const params = new URLSearchParams(requestUrl.searchParams);
			if (broken) params.set('broken', '1');
			const qs = params.toString();
			if (qs) query = '?' + qs;
		} catch (err) {
			query = requestUrl.search || '';
		}

		return route.continue({ url: base + pathname + query });
	});
}

async function getTiles(page) {
	for (const selector of TILE_SELECTORS) {
		const locator = page.locator(selector);
		if (await locator.count() >= 2) return {locator: locator, selector: selector};
	}
	return {locator: page.locator('button'), selector: 'button'};
}

async function firstVisible(page, selectors) {
	for (const selector of selectors) {
		const locator = page.locator(selector).first();
		if (await locator.count() > 0 && await locator.isVisible()) return locator;
	}
	return null;
}

async function waitForVisible(page, selectors, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = await firstVisible(page, selectors);
		if (found) return found;
		await page.waitForTimeout(100);
	}
	return null;
}

/**
 * The app ships with public defaults only (one demo stream, no alert service). Most tests
 * run against a "home" setup instead: two cameras and the alert service, seeded into
 * localStorage as an import would leave them. Only when storage is empty, so tests that
 * change settings and reload still see their own changes.
 */
const HOME_CAMERAS = [
	{id: 'front', name: 'Front', hls: 'http://192.168.0.10/hls/front/index.m3u8', snapshot: 'http://192.168.0.10/snap/front.jpg'},
	{id: 'back', name: 'Back', hls: 'http://192.168.0.10/hls/back/index.m3u8', snapshot: 'http://192.168.0.10/snap/back.jpg'}
];

function seedHome(page) {
	return page.addInitScript(function (cams) {
		try {
			if (!window.localStorage.getItem('webcamviewer.cameras.v1')) {
				window.localStorage.setItem('webcamviewer.cameras.v1', JSON.stringify(cams));
			}
			if (!window.localStorage.getItem('webcamviewer.prefs.v1')) {
				window.localStorage.setItem('webcamviewer.prefs.v1', JSON.stringify(
					{confirmExit: true, debug: false, loggerServer: '', alertsUrl: 'http://192.168.0.11:8790'}));
			}
		} catch (err) { /* storage blocked */ }
	}, HOME_CAMERAS);
}

/** Open the grid and return the tile locator plus any uncaught page errors. */
async function openGrid(page, options) {
	const errors = [];
	page.on('pageerror', function (err) { errors.push(err); });

	if (!(options && options.fresh)) await seedHome(page);
	await routeCameras(page, options && options.broken);
	await page.goto(APP_URL, {waitUntil: 'load'});

	const tiles = await getTiles(page);
	try {
		await expect(tiles.locator.first()).toBeVisible({timeout: 7000});
	} catch (err) {
		throw new Error('Camera tiles did not render.\nUncaught page errors:\n' +
			(formatErrors(errors) || '(none)'));
	}

	expect(await tiles.locator.count()).toBeGreaterThanOrEqual(2);
	return {tiles: tiles, errors: errors};
}

/**
 * Dispatch a real keydown with legacy keyCode/which set. webOS apps listen to
 * keyCode (Lumen's focus engine does); page.keyboard.press() does not reliably
 * expose the legacy property across Playwright versions.
 */
async function sendKey(page, key, keyCode) {
	await page.evaluate(function (payload) {
		const target = document.activeElement || document.body;
		const event = new KeyboardEvent('keydown', {
			key: payload.key,
			bubbles: true,
			cancelable: true
		});
		Object.defineProperty(event, 'keyCode', {get: function () { return payload.keyCode; }});
		Object.defineProperty(event, 'which', {get: function () { return payload.keyCode; }});
		target.dispatchEvent(event);
	}, {key: key, keyCode: keyCode});
}

async function focusedTileIndex(page, selector) {
	return page.evaluate(function (sel) {
		const els = Array.prototype.slice.call(document.querySelectorAll(sel));
		const active = document.activeElement;
		if (!active) return -1;
		const tile = active.closest ? active.closest(sel) : null;
		return tile ? els.indexOf(tile) : -1;
	}, selector);
}

test.beforeEach(function () {
	test.skip(!fs.existsSync(APP_INDEX),
		'app/index.html not present yet (Dev has not landed); checked ' + APP_INDEX);
});

test('grid renders and arrow keys move DOM focus between tiles', async function ({page}) {
	const opened = await openGrid(page);
	const tiles = opened.tiles;

	await tiles.locator.nth(0).focus();
	expect(await focusedTileIndex(page, tiles.selector)).toBe(0);

	await sendKey(page, 'ArrowRight', 39);
	await expect.poll(function () {
		return focusedTileIndex(page, tiles.selector);
	}, {timeout: 2000}).toBe(1);

	await sendKey(page, 'ArrowLeft', 37);
	await expect.poll(function () {
		return focusedTileIndex(page, tiles.selector);
	}, {timeout: 2000}).toBe(0);

	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Enter opens the fullscreen player and Back (461) returns to the grid', async function ({page}) {
	const opened = await openGrid(page);
	const tiles = opened.tiles;

	await tiles.locator.nth(0).focus();
	await sendKey(page, 'Enter', 13);

	const fullscreen = await waitForVisible(page, FULLSCREEN_SELECTORS, 5000);
	expect(fullscreen, 'Enter should open a fullscreen player (expected one of: ' +
		FULLSCREEN_SELECTORS.join(', ') + ')').not.toBeNull();

	await sendKey(page, 'Back', 461);
	await expect.poll(async function () {
		return (await firstVisible(page, FULLSCREEN_SELECTORS)) !== null;
	}, {timeout: 5000}).toBe(false);

	await expect(tiles.locator.first()).toBeVisible();
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('left/right in the player cycle cameras, and Back lands on the last one', async function ({page}) {
	const opened = await openGrid(page);
	const tiles = opened.tiles;
	const name = function () { return page.evaluate(function () { return document.getElementById('player-name').textContent; }); };
	const ids = await tiles.locator.evaluateAll(function (els) { return els.map(function (e) { return e.getAttribute('data-camera-id'); }); });

	await tiles.locator.nth(0).focus();
	await sendKey(page, 'Enter', 13);
	expect(await waitForVisible(page, FULLSCREEN_SELECTORS, 5000)).not.toBeNull();
	const first = await name();

	await sendKey(page, 'ArrowRight', 39);
	await expect.poll(name, {timeout: 2000}).not.toBe(first);
	await sendKey(page, 'ArrowLeft', 37);
	await expect.poll(name, {timeout: 2000}).toBe(first);
	await sendKey(page, 'ArrowLeft', 37); // wraps to the last camera
	await expect.poll(name, {timeout: 2000}).not.toBe(first);

	await sendKey(page, 'Back', 461);
	await expect.poll(function () {
		return page.evaluate(function () { return document.activeElement && document.activeElement.getAttribute('data-camera-id'); });
	}, {timeout: 3000}).toBe(ids[ids.length - 1]);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

// Regression: frame events only fire when video really decodes (it does on the
// TV, not in this headless browser), so fake them. They once threw
// "this._emit is not a function" on every frame, found only on real Chromium 53.
test('video frame events take the player live without errors', async function ({page}) {
	const opened = await openGrid(page);
	await opened.tiles.locator.nth(0).focus();
	await sendKey(page, 'Enter', 13);
	expect(await waitForVisible(page, FULLSCREEN_SELECTORS, 5000)).not.toBeNull();
	await page.waitForSelector('video', {state: 'attached', timeout: 5000});

	await page.evaluate(function () {
		const v = document.querySelector('video');
		Object.defineProperty(v, 'currentTime', {get: function () { return Date.now() / 1000; }});
		['loadeddata', 'playing', 'timeupdate', 'timeupdate'].forEach(function (t) { v.dispatchEvent(new Event(t)); });
	});

	await expect.poll(function () {
		return page.evaluate(function () { return document.body.textContent.indexOf('Live') !== -1; });
	}, {timeout: 3000}).toBe(true);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('?camera= launch parameter opens that camera full screen', async function ({page}) {
	// How a motion-alert toast opens the app: the packaged shell forwards the toast's
	// {camera} launch params to the NAS-hosted app as ?camera=.
	const errors = [];
	page.on('pageerror', function (err) { errors.push(err); });
	await seedHome(page);
	await routeCameras(page);
	await page.goto(APP_URL + '?camera=back', {waitUntil: 'load'});
	expect(await waitForVisible(page, FULLSCREEN_SELECTORS, 5000)).not.toBeNull();
	await expect.poll(function () {
		return page.evaluate(function () { return document.getElementById('player-name').textContent; });
	}, {timeout: 3000}).toBe('Back');
	expect(formatErrors(errors), 'uncaught page errors').toBe('');
});

test('snapshots load from the mock', async function ({page}) {
	// Proves the snapshot URL really reached the local mock (rather than silently
	// rendering a placeholder).
	const snapshotResponse = page.waitForResponse(function (response) {
		try {
			return /\/snap(\/[^/]+)?\.jpe?g$/i.test(new URL(response.url()).pathname);
		} catch (err) {
			return false;
		}
	}, {timeout: 7000});

	const opened = await openGrid(page);
	const response = await snapshotResponse;
	expect(response.status()).toBe(200);
	expect(response.headers()['content-type']).toContain('image/jpeg');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test.describe('hostile camera', function () {
	// webOS has blocked the cameras' self-signed HTTPS certs outright. Let the
	// browser reject them exactly as the TV does; the grid must still work.
	test.use({ignoreHTTPSErrors: false});

	test('tiles survive a blocked self-signed snapshot certificate', async function ({page}) {
		const opened = await openGrid(page);

		// Give img.onerror (and any placeholder logic) time to run.
		await page.waitForTimeout(1500);
		await expect(opened.tiles.locator.first()).toBeVisible();
		expect(await opened.tiles.locator.count()).toBeGreaterThanOrEqual(2);
		expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
	});
});

test('a camera returning 404 does not crash the grid', async function ({page}) {
	const opened = await openGrid(page, {broken: true});

	// Let the app's reconnect/backoff timers fire at least once.
	await page.waitForTimeout(1500);
	await expect(opened.tiles.locator.first()).toBeVisible();
	expect(await opened.tiles.locator.count()).toBeGreaterThanOrEqual(2);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

/* ------------------------------------------------------------- settings */

const STORAGE_KEY = 'webcamviewer.cameras.v1';

const SEEDED_CAMERAS = [
	{id: 'front', name: 'Front', hls: 'http://192.168.0.10:8888/front/index.m3u8', snapshot: 'https://192.168.0.42/snap.jpeg'},
	{id: 'back', name: 'Back', hls: 'http://192.168.0.10:8888/back/index.m3u8', snapshot: 'https://192.168.0.43/snap.jpeg'},
	{id: 'porch', name: 'Porch', hls: 'http://192.168.0.10:8888/porch/index.m3u8', snapshot: 'https://192.168.0.42/snap.jpeg'}
];

function seedCameras(page, list) {
	return page.addInitScript(function (payload) {
		try {
			window.localStorage.setItem(payload.key, payload.value);
		} catch (err) { /* storage blocked: the app must fall back to defaults */ }
	}, {key: STORAGE_KEY, value: JSON.stringify(list)});
}

async function focusedAttr(page, attr) {
	return page.evaluate(function (name) {
		return document.activeElement && document.activeElement.getAttribute
			? document.activeElement.getAttribute(name)
			: null;
	}, attr);
}

/** Drive the remote path: focus a tile, ArrowUp to the gear, OK. */
async function openSettings(page) {
	await page.locator('.tile').first().focus();
	await sendKey(page, 'ArrowUp', 38);
	await expect.poll(function () { return focusedAttr(page, 'id'); }, {timeout: 2000}).toBe('settings-btn');
	await sendKey(page, 'Enter', 13);
	await expect(page.locator('#settings-screen')).toBeVisible({timeout: 3000});
}

/** Focus an element directly, then press OK so the app's own OK-wiring fires. */
async function pressOkOn(page, selector) {
	await page.evaluate(function (sel) {
		const el = document.querySelector(sel);
		if (!el) throw new Error('nothing to focus: ' + sel);
		el.focus();
	}, selector);
	await sendKey(page, 'Enter', 13);
}

/** Menu -> a sub-page by its menu item. */
async function openSettingsPage(page, view) {
	await pressOkOn(page, '[data-action="menu-' + view + '"]');
	await expect(page.locator('#' + view + '-screen')).toBeVisible({timeout: 3000});
}

const SETTINGS_PAGES = [
	{view: 'general', screen: '#general-screen', title: 'Settings · General'},
	{view: 'notifications', screen: '#notifications-screen', title: 'Settings · Notifications'},
	{view: 'cameras', screen: '#cameras-screen', title: 'Settings · Cameras'},
	{view: 'developer', screen: '#developer-screen', title: 'Settings · Developer'}
];

test('arrow up from the grid focuses the settings gear, OK opens the Settings menu', async function ({page}) {
	const opened = await openGrid(page);

	await openSettings(page);
	expect(await page.locator('#settings-screen .title').textContent()).toBe('Settings');
	await expect(page.locator('#settings-menu .menu-item')).toHaveCount(4);
	// Focus starts on the first item.
	await expect.poll(function () { return focusedAttr(page, 'data-focus-key'); }, {timeout: 2000}).toBe('menu:general');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('menu items carry live summaries', async function ({page}) {
	const opened = await openGrid(page);
	await mockAlertsService(page);

	await openSettings(page);
	await expect(page.locator('[data-action="menu-general"] .menu-item-summary')).toHaveText('Confirm exit: On');
	// The notifications summary rides the GET fired when the menu opens.
	await expect(page.locator('[data-action="menu-notifications"] .menu-item-summary'))
		.toHaveText('On · Popup · Quiet hours off', {timeout: 6000});
	await expect(page.locator('[data-action="menu-cameras"] .menu-item-summary')).toHaveText('2 cameras');
	await expect(page.locator('[data-action="menu-developer"] .menu-item-summary')).toHaveText('Debug mode: Off');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('OK opens each sub-page, Back returns to the menu on that item, Back from the menu returns to the grid', async function ({page}) {
	const opened = await openGrid(page);
	await mockAlertsService(page);

	await openSettings(page);
	for (const p of SETTINGS_PAGES) {
		await pressOkOn(page, '[data-action="menu-' + p.view + '"]');
		await expect(page.locator(p.screen)).toBeVisible({timeout: 3000});
		expect(await page.locator(p.screen + ' .title').textContent()).toBe(p.title);

		await sendKey(page, 'Back', 461);
		await expect(page.locator('#settings-screen')).toBeVisible({timeout: 3000});
		await expect.poll(function () { return focusedAttr(page, 'data-action'); }, {timeout: 2000}).toBe('menu-' + p.view);
	}

	await sendKey(page, 'Back', 461);
	await expect(page.locator('#grid-screen')).toBeVisible({timeout: 3000});
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('adding a third camera through the form yields 3 tiles', async function ({page}) {
	const opened = await openGrid(page);

	await openSettings(page);
	await openSettingsPage(page, 'cameras');
	await pressOkOn(page, '[data-action="add"]');
	await expect(page.locator('#form-screen')).toBeVisible();

	await page.locator('#form-name').fill('Porch');
	await page.locator('#form-url').fill('http://192.168.0.10:8888/porch/index.m3u8');
	await page.locator('#form-snapshot').fill('https://192.168.0.42/snap.jpeg');
	await pressOkOn(page, '#form-save');

	// Save returns to the Cameras page, then Back -> menu -> grid.
	await expect(page.locator('#cameras-screen')).toBeVisible();
	await expect(page.locator('#settings-list .settings-row')).toHaveCount(3);

	await sendKey(page, 'Back', 461);
	await expect(page.locator('#settings-screen')).toBeVisible();
	await expect.poll(function () { return focusedAttr(page, 'data-action'); }, {timeout: 2000}).toBe('menu-cameras');

	await sendKey(page, 'Back', 461);
	await expect(page.locator('#grid-screen')).toBeVisible();
	await expect(page.locator('.tile')).toHaveCount(3);

	const stored = await page.evaluate(function (key) {
		return JSON.parse(window.localStorage.getItem(key));
	}, STORAGE_KEY);
	expect(stored.map(function (c) { return c.id; })).toEqual(['front', 'back', 'porch']);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('deleting a camera with confirmation leaves 2 tiles', async function ({page}) {
	await seedCameras(page, SEEDED_CAMERAS);
	const opened = await openGrid(page);
	await expect(page.locator('.tile')).toHaveCount(3);

	await openSettings(page);
	await openSettingsPage(page, 'cameras');
	await pressOkOn(page, '[data-action="delete"][data-camera-key="porch"]');
	await expect(page.locator('.settings-confirm-text')).toHaveText('Delete Porch?');
	await expect.poll(function () { return focusedAttr(page, 'data-action'); }, {timeout: 2000}).toBe('confirm-delete');

	await sendKey(page, 'Enter', 13);
	await expect(page.locator('#settings-list .settings-row')).toHaveCount(2);

	await sendKey(page, 'Back', 461);
	await expect(page.locator('#settings-screen')).toBeVisible();
	await sendKey(page, 'Back', 461);
	await expect(page.locator('.tile')).toHaveCount(2);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('the camera list persists across a page reload', async function ({page}) {
	await seedCameras(page, SEEDED_CAMERAS);
	const opened = await openGrid(page);
	await expect(page.locator('.tile')).toHaveCount(3);

	await page.reload({waitUntil: 'load'});
	await expect(page.locator('.tile').first()).toBeVisible({timeout: 7000});
	await expect(page.locator('.tile')).toHaveCount(3);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('reset to defaults restores the public demo camera', async function ({page}) {
	await seedCameras(page, SEEDED_CAMERAS);
	const opened = await openGrid(page);
	await expect(page.locator('.tile')).toHaveCount(3);

	await openSettings(page);
	await openSettingsPage(page, 'cameras');
	await pressOkOn(page, '[data-action="reset"]');
	await expect(page.locator('.settings-confirm-text')).toHaveText('Reset to defaults?');
	await expect.poll(function () { return focusedAttr(page, 'data-action'); }, {timeout: 2000}).toBe('confirm-reset');

	await sendKey(page, 'Enter', 13);
	await expect(page.locator('#settings-list .settings-row')).toHaveCount(1);

	await sendKey(page, 'Back', 461);
	await expect(page.locator('#settings-screen')).toBeVisible();
	await sendKey(page, 'Back', 461);
	await expect(page.locator('.tile')).toHaveCount(1);

	const stored = await page.evaluate(function (key) {
		return JSON.parse(window.localStorage.getItem(key));
	}, STORAGE_KEY);
	expect(stored.map(function (c) { return c.id; })).toEqual(['demo']);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

/* --------------------------------------------------------------- alerts */

const ALERTS_BASE = 'http://192.168.0.11:8790';

const ALERTS_SETTINGS_DEFAULTS = {
	enabled: true,
	cameras: {front: true, back: true},
	quietHours: {enabled: false, start: '23:00', end: '07:00'},
	cooldownSeconds: 120,
	snoozeUntil: 0,
	suppressWhileViewing: true,
	types: {person: true, vehicle: true, animal: false, motion: true},
	timezone: 'Europe/Athens'
};

/**
 * Stand-in for the motion-alert service (docs/ALERTS.md). Settings live in
 * memory; PUT bodies and snooze POSTs are recorded for assertions. Answers
 * CORS preflights the way the real service does (204 + allow headers).
 * Register AFTER openGrid so it wins over routeCameras' catch-all.
 */
async function mockAlertsService(page, options) {
	const opts = options || {};
	const settings = JSON.parse(JSON.stringify(ALERTS_SETTINGS_DEFAULTS));
	if (opts.settings) {
		Object.keys(opts.settings).forEach(function (key) { settings[key] = opts.settings[key]; });
	}
	const events = opts.events !== undefined ? opts.events : [
		{at: Date.now() - 60000, camera: 'front', type: 'person', reason: 'ok', sent: true},
		{at: Date.now() - 120000, camera: 'back', type: 'motion', reason: 'quiet-hours', sent: false}
	];
	const puts = [];
	const snoozes = [];

	const cors = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type'
	};
	const json = function (status, payload) {
		return {
			status: status,
			contentType: 'application/json',
			headers: cors,
			body: JSON.stringify(payload)
		};
	};

	await page.route(ALERTS_BASE + '/**', async function (route) {
		if (opts.unreachable) return route.abort();
		const request = route.request();
		let pathname;
		try {
			pathname = new URL(request.url()).pathname;
		} catch (err) {
			pathname = '';
		}
		if (request.method() === 'OPTIONS') {
			return route.fulfill({status: 204, headers: cors});
		}
		if (pathname === '/settings' && request.method() === 'GET') {
			return route.fulfill(json(200, settings));
		}
		if (pathname === '/settings' && request.method() === 'PUT') {
			const body = JSON.parse(request.postData());
			Object.keys(settings).forEach(function (key) { delete settings[key]; });
			Object.keys(body).forEach(function (key) { settings[key] = body[key]; });
			puts.push(body);
			return route.fulfill(json(200, {ok: true, settings: settings}));
		}
		if (pathname === '/snooze' && request.method() === 'POST') {
			const body = JSON.parse(request.postData());
			snoozes.push(body);
			settings.snoozeUntil = body.minutes ? Date.now() + body.minutes * 60000 : 0;
			return route.fulfill(json(200, {ok: true, snoozeUntil: settings.snoozeUntil}));
		}
		if (pathname === '/status' && request.method() === 'GET') {
			return route.fulfill(json(200, {ok: true, events: events}));
		}
		return route.fulfill(json(404, {ok: false, error: 'not-found'}));
	});

	return {settings: settings, puts: puts, snoozes: snoozes};
}

/** From the menu: open Settings · Notifications and wait until settings have loaded. */
async function openNotificationsPage(page) {
	await pressOkOn(page, '[data-action="menu-notifications"]');
	await expect(page.locator('#notifications-screen')).toBeVisible({timeout: 3000});
	await expect(page.locator('#notifications-screen .title')).toHaveText('Settings · Notifications', {timeout: 5000});
	await expect(page.locator('[data-action="alerts-enabled"]')).toBeVisible({timeout: 5000});
}

test('Settings · Notifications shows the loaded values', async function ({page}) {
	const opened = await openGrid(page);
	const alerts = await mockAlertsService(page);

	await openSettings(page);
	await openNotificationsPage(page);

	await expect(page.locator('[data-action="alerts-enabled"]')).toHaveText('On');
	await expect(page.locator('[data-action="alerts-style"]')).toHaveText('Popup');
	await expect(page.locator('[data-action="alerts-type:animal"]')).toHaveText('Animal: Off');
	await expect(page.locator('[data-value="alerts-qh-start"]')).toHaveText('23:00');
	await expect(page.locator('[data-value="alerts-cooldown"]')).toHaveText('2 min');
	// Camera rows use the app's own names; events are humanized.
	await expect(page.locator('#alerts-list')).toContainText('Front');
	await expect(page.locator('#alerts-list')).toContainText('quiet hours');
	// Focus starts on the first row.
	await expect.poll(function () { return focusedAttr(page, 'data-focus-key'); }, {timeout: 2000}).toBe('alerts:enabled');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('toggling Display notifications off PUTs enabled:false', async function ({page}) {
	const opened = await openGrid(page);
	const alerts = await mockAlertsService(page);

	await openSettings(page);
	await openNotificationsPage(page);
	await pressOkOn(page, '[data-action="alerts-enabled"]');

	await expect.poll(function () { return alerts.puts.length; }, {timeout: 3000}).toBe(1);
	expect(alerts.puts[0].enabled).toBe(false);
	await expect(page.locator('[data-action="alerts-enabled"]')).toHaveText('Off');
	await expect(page.locator('#alerts-save-status')).toHaveText('Saved');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Alert style switches popup <-> toast with a PUT (absent style reads as popup)', async function ({page}) {
	const opened = await openGrid(page);
	const alerts = await mockAlertsService(page);

	await openSettings(page);
	await openNotificationsPage(page);
	await expect(page.locator('[data-action="alerts-style"]')).toHaveText('Popup');
	await pressOkOn(page, '[data-action="alerts-style"]');

	await expect.poll(function () { return alerts.puts.length; }, {timeout: 3000}).toBe(1);
	expect(alerts.puts[0].style).toBe('toast');
	await expect(page.locator('[data-action="alerts-style"]')).toHaveText('Toast');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('toggling Person off sends a PUT with types.person === false', async function ({page}) {
	const opened = await openGrid(page);
	const alerts = await mockAlertsService(page);

	await openSettings(page);
	await openNotificationsPage(page);
	await pressOkOn(page, '[data-action="alerts-type:person"]');

	await expect.poll(function () { return alerts.puts.length; }, {timeout: 3000}).toBe(1);
	expect(alerts.puts[0].types.person).toBe(false);
	await expect(page.locator('[data-action="alerts-type:person"]')).toHaveText('Person: Off');
	await expect(page.locator('#alerts-save-status')).toHaveText('Saved');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('quiet-hours + on start from 23:30 wraps to 00:00', async function ({page}) {
	const opened = await openGrid(page);
	const alerts = await mockAlertsService(page, {
		settings: {quietHours: {enabled: true, start: '23:30', end: '07:00'}}
	});

	await openSettings(page);
	await openNotificationsPage(page);
	await expect(page.locator('[data-value="alerts-qh-start"]')).toHaveText('23:30');
	await pressOkOn(page, '[data-action="alerts-qh-start-inc"]');

	await expect.poll(function () { return alerts.puts.length; }, {timeout: 3000}).toBe(1);
	expect(alerts.puts[0].quietHours.start).toBe('00:00');
	await expect(page.locator('[data-value="alerts-qh-start"]')).toHaveText('00:00');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Snooze 1 h POSTs {minutes: 60}', async function ({page}) {
	const opened = await openGrid(page);
	const alerts = await mockAlertsService(page);

	await openSettings(page);
	await openNotificationsPage(page);
	await expect(page.locator('#alerts-list')).not.toContainText('Snoozed until');
	await pressOkOn(page, '[data-action="alerts-snooze:60"]');

	await expect.poll(function () { return alerts.snoozes.length; }, {timeout: 3000}).toBe(1);
	expect(alerts.snoozes[0]).toEqual({minutes: 60});
	await expect(page.locator('#alerts-list')).toContainText('Snoozed until');
	expect(alerts.puts.length).toBe(0); // snooze goes through /snooze, not PUT
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('unreachable service shows the retry message and Back returns to the menu', async function ({page}) {
	const opened = await openGrid(page);
	await mockAlertsService(page, {unreachable: true});

	await openSettings(page);
	// The menu summary mirrors the failure.
	await expect(page.locator('[data-action="menu-notifications"] .menu-item-summary'))
		.toHaveText('Alert service unavailable', {timeout: 6000});

	await pressOkOn(page, '[data-action="menu-notifications"]');
	await expect(page.locator('#notifications-screen')).toBeVisible({timeout: 3000});
	await expect(page.locator('#alerts-list')).toContainText(
		'Alert service unreachable (192.168.0.11). OK to retry', {timeout: 6000});

	await sendKey(page, 'Back', 461);
	await expect(page.locator('#settings-screen')).toBeVisible({timeout: 3000});
	// Back lands on the Notifications item the page was opened from.
	await expect.poll(function () { return focusedAttr(page, 'data-action'); }, {timeout: 2000}).toBe('menu-notifications');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

/* --------------------------------------------------------------- general */

const PREFS_KEY = 'webcamviewer.prefs.v1';

function readPrefs(page) {
	return page.evaluate(function (key) {
		return JSON.parse(window.localStorage.getItem(key));
	}, PREFS_KEY);
}

/**
 * Replace the exit paths with recorders. exitApp() tries, in order:
 * PalmSystem.platformBack(), PalmServiceBridge Luna close, then window.close()
 * after 500 ms. The stub is installed before the app's own scripts run.
 */
function stubExit(page) {
	return page.addInitScript(function () {
		window.__exitCalls = [];
		window.close = function () { window.__exitCalls.push('close'); };
		window.PalmSystem = {
			launchParams: '{}',
			platformBack: function () { window.__exitCalls.push('platformBack'); }
		};
	});
}

async function exitCalls(page) {
	return page.evaluate(function () { return window.__exitCalls || []; });
}

test('Back on the grid asks before exiting; Back again cancels and refocuses the tile', async function ({page}) {
	const opened = await openGrid(page);

	await page.locator('.tile').first().focus();
	await sendKey(page, 'Back', 461);

	await expect(page.locator('#exit-dialog')).toBeVisible();
	await expect(page.locator('#exit-dialog')).toContainText('Exit Webcam Viewer?');
	// Cancel is focused by default.
	await expect.poll(function () { return focusedAttr(page, 'id'); }, {timeout: 2000}).toBe('exit-cancel');

	// Back (or Escape) cancels; focus returns to the tile that was focused.
	await sendKey(page, 'Back', 461);
	await expect(page.locator('#exit-dialog')).toBeHidden();
	await expect.poll(function () { return focusedAttr(page, 'data-camera-id'); }, {timeout: 2000}).toBe('front');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('OK on Exit triggers the exit path', async function ({page}) {
	await stubExit(page);
	const opened = await openGrid(page);

	await page.locator('.tile').first().focus();
	await sendKey(page, 'Back', 461);
	await expect(page.locator('#exit-dialog')).toBeVisible();

	// ← / → move between the dialog's buttons.
	await sendKey(page, 'ArrowRight', 39);
	await expect.poll(function () { return focusedAttr(page, 'id'); }, {timeout: 2000}).toBe('exit-confirm');

	await sendKey(page, 'Enter', 13);
	await expect.poll(async function () { return (await exitCalls(page)).indexOf('platformBack') !== -1; },
		{timeout: 3000}).toBe(true);
	// window.close follows on a 500 ms timer in exitApp().
	await expect.poll(async function () { return (await exitCalls(page)).indexOf('close') !== -1; },
		{timeout: 3000}).toBe(true);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Confirm exit off: Back exits immediately, and the setting survives a reload', async function ({page}) {
	await stubExit(page);
	const opened = await openGrid(page);

	await openSettings(page);
	await openSettingsPage(page, 'general');
	await expect(page.locator('[data-action="general-confirm-exit"]')).toBeVisible();
	await pressOkOn(page, '[data-action="general-confirm-exit"]');
	await expect(page.locator('[data-action="general-confirm-exit"]')).toHaveText('Off');
	expect((await readPrefs(page)).confirmExit).toBe(false);

	await sendKey(page, 'Back', 461); // general page -> menu
	await expect(page.locator('#settings-screen')).toBeVisible();
	await sendKey(page, 'Back', 461); // menu -> grid
	await expect(page.locator('#grid-screen')).toBeVisible();
	await sendKey(page, 'Back', 461);
	await expect(page.locator('#exit-dialog')).toBeHidden();
	await expect.poll(async function () { return (await exitCalls(page)).indexOf('platformBack') !== -1; },
		{timeout: 3000}).toBe(true);

	// Reload: the setting persists, Back still exits without a dialog.
	await page.reload({waitUntil: 'load'});
	await expect(page.locator('.tile').first()).toBeVisible({timeout: 7000});
	expect((await readPrefs(page)).confirmExit).toBe(false);
	await page.locator('.tile').first().focus();
	await sendKey(page, 'Back', 461);
	await expect(page.locator('#exit-dialog')).toBeHidden();
	await expect.poll(async function () { return (await exitCalls(page)).indexOf('platformBack') !== -1; },
		{timeout: 3000}).toBe(true);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test.describe('settings sub-pages at TV resolution', function () {
	test.use({viewport: {width: 1920, height: 1080}});

	// Regression: on the TV, settings pages outgrew 1080p and arrow keys could not
	// reach (or scroll to) the lower rows. ArrowDown until focus sits on the page's
	// last focusable button; it must end fully inside the viewport.
	async function reachLastButton(page, screenSelector) {
		const lastKey = await page.evaluate(function (sel) {
			const all = document.querySelectorAll(sel + ' .settings-scroll .settings-focus:not([disabled])');
			return all.length ? all[all.length - 1].getAttribute('data-focus-key') : null;
		}, screenSelector);
		expect(lastKey, 'page has focusable buttons').not.toBeNull();

		let reached = false;
		for (let i = 0; i < 30 && !reached; i++) {
			reached = await page.evaluate(function (key) {
				const a = document.activeElement;
				return !!a && a.getAttribute('data-focus-key') === key;
			}, lastKey);
			if (!reached) await sendKey(page, 'ArrowDown', 40);
		}
		expect(reached, 'arrow-down reached the last button').toBe(true);

		const where = await page.evaluate(function () {
			const r = document.activeElement.getBoundingClientRect();
			return {top: r.top, bottom: r.bottom, h: window.innerHeight};
		});
		expect(where.top).toBeGreaterThanOrEqual(0);
		expect(where.bottom).toBeLessThanOrEqual(where.h);
	}

	test('Notifications: arrow-down scrolls to the last control, fully on screen', async function ({page}) {
		const opened = await openGrid(page);
		await mockAlertsService(page);
		await openSettings(page);
		await openNotificationsPage(page);

		await reachLastButton(page, '#notifications-screen');

		const scroll = await page.evaluate(function () {
			const box = document.querySelector('#notifications-screen .settings-scroll');
			return {scrolled: box.scrollTop, overflowing: box.scrollHeight > box.clientHeight};
		});
		expect(scroll.overflowing, 'notifications content is taller than the screen at 1080p').toBe(true);
		expect(scroll.scrolled).toBeGreaterThan(0);
		expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
	});

	test('Cameras: arrow-down reaches the last control, fully on screen', async function ({page}) {
		const opened = await openGrid(page);
		await openSettings(page);
		await openSettingsPage(page, 'cameras');

		await reachLastButton(page, '#cameras-screen');
		expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
	});

	test('General: arrow-down reaches the last control, fully on screen', async function ({page}) {
		const opened = await openGrid(page);
		await openSettings(page);
		await openSettingsPage(page, 'general');

		await reachLastButton(page, '#general-screen');
		expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
	});
});

test('unreachable alert service: the menu says so and the other pages still work', async function ({page}) {
	const opened = await openGrid(page);
	await mockAlertsService(page, {unreachable: true});

	await openSettings(page);
	await expect(page.locator('[data-action="menu-notifications"] .menu-item-summary'))
		.toHaveText('Alert service unavailable', {timeout: 6000});

	// The dead service affects only Notifications; other pages keep working.
	await openSettingsPage(page, 'general');
	await pressOkOn(page, '[data-action="general-confirm-exit"]');
	await expect(page.locator('[data-action="general-confirm-exit"]')).toHaveText('Off');

	await sendKey(page, 'Back', 461); // general -> menu
	await expect(page.locator('#settings-screen')).toBeVisible();
	await sendKey(page, 'Back', 461); // menu -> grid
	await expect(page.locator('#grid-screen')).toBeVisible({timeout: 3000});
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Debug mode toggle persists and gates the phone-home logger', async function ({page}) {
	const opened = await openGrid(page);
	// Public default is off.
	expect(await page.evaluate(function () { return window.__webcamDebug.loggerWanted(); })).toBe(false);

	await openSettings(page);
	await openSettingsPage(page, 'developer');
	// Read-only info rows are there while we are at it.
	await expect(page.locator('#developer-list')).toContainText('App version');
	await expect(page.locator('#developer-list')).toContainText('Chrome/');
	await pressOkOn(page, '[data-action="developer-debug"]');
	await expect(page.locator('[data-action="developer-debug"]')).toHaveText('On');
	expect(await page.evaluate(function () { return window.__webcamDebug.loggerWanted(); })).toBe(true);
	expect((await readPrefs(page)).debug).toBe(true);

	// On stays on after reload.
	await page.reload({waitUntil: 'load'});
	await expect(page.locator('.tile').first()).toBeVisible({timeout: 7000});
	expect(await page.evaluate(function () { return window.__webcamDebug.loggerWanted(); })).toBe(true);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

/* ------------------------------------------- public defaults, Developer, import */

test('fresh install: one demo camera, notifications not set up, debug off', async function ({page}) {
	const errors = [];
	page.on('pageerror', function (err) { errors.push(err); });
	await routeCameras(page);
	await page.goto(APP_URL, {waitUntil: 'load'});
	await expect(page.locator('.tile')).toHaveCount(1);
	await expect(page.locator('.tile').first()).toContainText('Demo');

	await openSettings(page);
	await expect(page.locator('[data-action="menu-notifications"] .menu-item-summary')).toHaveText('Not set up');
	await expect(page.locator('[data-action="menu-developer"] .menu-item-summary')).toHaveText('Debug mode: Off');
	await openSettingsPage(page, 'notifications');
	await expect(page.locator('#notifications-screen')).toContainText('Choose "This TV"');
	expect(formatErrors(errors), 'uncaught page errors').toBe('');
});

test('Developer: log server and alert service validate and save to prefs', async function ({page}) {
	const opened = await openGrid(page);
	await openSettings(page);
	await openSettingsPage(page, 'developer');

	await page.locator('#dev-logger').fill('not a host');
	await pressOkOn(page, '[data-action="developer-logger"]');
	await expect(page.locator('#developer-save-status')).toContainText('Not saved');
	expect((await readPrefs(page)).loggerServer).toBe('');

	await page.locator('#dev-logger').fill('192.168.0.10:8765');
	await pressOkOn(page, '[data-action="developer-logger"]');
	await expect(page.locator('#developer-save-status')).toContainText('Saved');
	expect((await readPrefs(page)).loggerServer).toBe('192.168.0.10:8765');

	await page.locator('#dev-alerts').fill('ftp://nope');
	await pressOkOn(page, '[data-action="developer-alerts"]');
	await expect(page.locator('#developer-save-status')).toContainText('Not saved');
	await page.locator('#dev-alerts').fill('');
	await pressOkOn(page, '[data-action="developer-alerts"]');
	await expect(page.locator('#developer-save-status')).toContainText('motion alerts off');
	expect((await readPrefs(page)).alertsUrl).toBe('');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Developer: ←/→ in a text field stay in the field', async function ({page}) {
	const opened = await openGrid(page);
	await openSettings(page);
	await openSettingsPage(page, 'developer');
	await page.locator('#dev-logger').focus();
	await sendKey(page, 'ArrowRight', 39);
	await sendKey(page, 'ArrowLeft', 37);
	expect(await focusedAttr(page, 'id')).toBe('dev-logger');
	await sendKey(page, 'ArrowDown', 40);
	expect(await focusedAttr(page, 'id')).not.toBe('dev-logger');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Developer: Import settings loads cameras and addresses from a URL; bad files are rejected', async function ({page}) {
	const errors = [];
	page.on('pageerror', function (err) { errors.push(err); });
	await routeCameras(page);
	// Registered after routeCameras' catch-all: Playwright tries the newest route first.
	await page.route('http://192.168.0.10/config.local.json', function (route) {
		route.fulfill({status: 200, headers: {'access-control-allow-origin': '*', 'content-type': 'application/json'},
			body: JSON.stringify({cameras: HOME_CAMERAS, loggerServer: '192.168.0.20:8765', alertsUrl: 'http://192.168.0.11:8790', debug: false})});
	});
	await page.route('http://192.168.0.10/bad.json', function (route) {
		route.fulfill({status: 200, headers: {'access-control-allow-origin': '*'}, body: '{"cameras": [{"id": "x"}]}'});
	});
	await page.goto(APP_URL, {waitUntil: 'load'});
	await expect(page.locator('.tile')).toHaveCount(1);

	await openSettings(page);
	await openSettingsPage(page, 'developer');
	await page.locator('#dev-import').fill('http://192.168.0.10/bad.json');
	await pressOkOn(page, '[data-action="developer-import"]');
	await expect(page.locator('#developer-save-status')).toContainText('Not imported');

	await page.locator('#dev-import').fill('http://192.168.0.10/config.local.json');
	await pressOkOn(page, '[data-action="developer-import"]');
	await expect(page.locator('#developer-save-status')).toHaveText('Imported 2 cameras, log server, alert service');
	const prefs = await readPrefs(page);
	expect(prefs.loggerServer).toBe('192.168.0.20:8765');
	expect(prefs.alertsUrl).toBe('http://192.168.0.11:8790');
	await expect(page.locator('.tile')).toHaveCount(2);
	expect(formatErrors(errors), 'uncaught page errors').toBe('');
});

test('Cameras page shows a status badge per camera, mirroring its tile', async function ({page}) {
	const opened = await openGrid(page);
	await openSettings(page);
	await openSettingsPage(page, 'cameras');
	await expect(page.locator('#cameras-screen [data-status-for]')).toHaveCount(2);
	await expect.poll(function () {
		return page.locator('#cameras-screen [data-status-for="front"]').textContent();
	}, {timeout: 6000}).toBe('Live');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('the player plays with sound (not muted)', async function ({page}) {
	const opened = await openGrid(page);
	await opened.tiles.locator.nth(0).focus();
	await sendKey(page, 'Enter', 13);
	await page.waitForSelector('video', {state: 'attached', timeout: 5000});
	await page.waitForTimeout(1500);
	// muted stays false unless the engine blocked autoplay with sound (then the app logs it).
	expect(await page.evaluate(function () { return document.querySelector('video').muted; })).toBe(false);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

/* ------------------------------------- TV alert mode, in-app banner, update check */

/** The TV service (service/webcam_service.js) in memory behind a fake PalmServiceBridge. */
function installFakeTvService(page) {
	return page.addInitScript(function () {
		var settings = {enabled: true, cameras: {}, quietHours: {enabled: false, start: '23:00', end: '07:00'},
			cooldownSeconds: 120, snoozeUntil: 0, types: {person: true, vehicle: true, animal: false, motion: true}};
		var subs = [];
		var calls = [];
		window.__fakeTv = {
			calls: calls,
			settings: function () { return settings; },
			subscribers: function () { return subs.filter(function (s) { return !s.cancelled; }).length; },
			emit: function (event) {
				subs.forEach(function (s) { if (!s.cancelled) s.fire({returnValue: true, event: event}); });
			}
		};
		window.PalmServiceBridge = function () {
			var self = this;
			var sub = null;
			this.call = function (uri, json) {
				var method = uri.split('/').pop();
				var params = JSON.parse(json || '{}');
				calls.push({method: method, params: params});
				function reply(payload) {
					setTimeout(function () {
						if (self.onservicecallback && !(sub && sub.cancelled)) self.onservicecallback(JSON.stringify(payload));
					}, 0);
				}
				if (method === 'configure') {
					(params.cameras || []).forEach(function (c) {
						if (typeof settings.cameras[c.id] !== 'boolean') settings.cameras[c.id] = true;
					});
					reply({returnValue: true, listening: true, ip: '192.0.2.30', port: 8791, token: 'tok12345678'});
				} else if (method === 'settings') {
					reply({returnValue: true, settings: JSON.parse(JSON.stringify(settings))});
				} else if (method === 'putSettings') {
					settings = params.settings;
					reply({returnValue: true, ok: true, settings: settings});
				} else if (method === 'snooze') {
					settings.snoozeUntil = params.minutes ? Date.now() + params.minutes * 60000 : 0;
					reply({returnValue: true, ok: true, snoozeUntil: settings.snoozeUntil});
				} else if (method === 'status') {
					reply({returnValue: true, events: []});
				} else if (method === 'test') {
					reply({returnValue: true, ok: true, via: 'banner'});
				} else if (method === 'events') {
					sub = {cancelled: false, fire: function (p) { reply(p); }};
					subs.push(sub);
					reply({returnValue: true, subscribed: true});
				} else {
					reply({returnValue: false, errorText: 'Unknown method'});
				}
			};
			this.cancel = function () { if (sub) sub.cancelled = true; };
		};
	});
}

/** Run before openGrid(): start with these prefs instead of the default 'home' ones. */
function seedPrefs(page, prefs) {
	return page.addInitScript(function (p) {
		try { window.localStorage.setItem('webcamviewer.prefs.v1', JSON.stringify(p)); } catch (e) { /* blocked */ }
	}, prefs);
}

const TV_PREFS = {confirmExit: true, debug: false, loggerServer: '', alertsUrl: '', tvAlerts: true, banner: true, checkUpdates: true};

test('Notifications: switching the alert source to This TV configures the service and shows where to send alerts', async function ({page}) {
	await installFakeTvService(page);
	const opened = await openGrid(page);
	await mockAlertsService(page);
	await openSettings(page);
	await openSettingsPage(page, 'notifications');
	await expect(page.locator('[data-action="alerts-source"]')).toHaveText('Network service');
	await expect(page.locator('[data-action="alerts-style"]')).toHaveCount(1);

	await pressOkOn(page, '[data-action="alerts-source"]');
	await expect(page.locator('[data-action="alerts-source"]')).toHaveText('This TV', {timeout: 3000});
	await expect(page.locator('#alerts-list')).toContainText('192.0.2.30:8791');
	await expect(page.locator('#alerts-list')).toContainText('token=tok12345678');
	// The network-only rows are gone: a service on the TV can't show a popup, and the banner replaces "not while watching".
	await expect(page.locator('[data-action="alerts-style"]')).toHaveCount(0);
	await expect(page.locator('[data-action="alerts-watching"]')).toHaveCount(0);
	const configure = await page.evaluate(function () {
		return window.__fakeTv.calls.filter(function (c) { return c.method === 'configure'; }).pop();
	});
	expect(configure.params.cameras.map(function (c) { return c.id; })).toEqual(['front', 'back']);

	// Edits go to the TV service, not to the network one.
	await pressOkOn(page, '[data-action="alerts-type:person"]');
	await expect.poll(function () {
		return page.evaluate(function () { return window.__fakeTv.settings().types.person; });
	}, {timeout: 3000}).toBe(false);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('TV alert mode: an alert while the app is open shows a banner; OK opens the camera, Back dismisses', async function ({page}) {
	await installFakeTvService(page);
	await seedPrefs(page, TV_PREFS);
	const opened = await openGrid(page);
	await expect.poll(function () { return page.evaluate(function () { return window.__fakeTv.subscribers(); }); }, {timeout: 3000}).toBe(1);

	await page.evaluate(function () { window.__fakeTv.emit({camera: 'back', name: 'Back', type: 'person', at: new Date().toISOString()}); });
	await expect(page.locator('#banner')).toBeVisible();
	await expect(page.locator('#banner-title')).toHaveText('Back: Person detected');
	await sendKey(page, 'Enter', 13);
	await expect(page.locator('#banner')).toBeHidden();
	expect(await waitForVisible(page, FULLSCREEN_SELECTORS, 5000)).not.toBeNull();
	await expect.poll(function () { return page.evaluate(function () { return document.getElementById('player-name').textContent; }); }, {timeout: 3000}).toBe('Back');

	// Back dismisses the banner and stays in the player.
	await page.evaluate(function () { window.__fakeTv.emit({camera: 'front', name: 'Front', type: 'motion', at: new Date().toISOString()}); });
	await expect(page.locator('#banner')).toBeVisible();
	await sendKey(page, 'Back', 461);
	await expect(page.locator('#banner')).toBeHidden();
	expect(await firstVisible(page, FULLSCREEN_SELECTORS)).not.toBeNull();
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('TV alert mode: a hidden app unsubscribes (alerts become toasts) and resubscribes when visible', async function ({page}) {
	await installFakeTvService(page);
	await seedPrefs(page, TV_PREFS);
	const opened = await openGrid(page);
	const subscribers = function () { return page.evaluate(function () { return window.__fakeTv.subscribers(); }); };
	await expect.poll(subscribers, {timeout: 3000}).toBe(1);

	const setHidden = function (hidden) {
		return page.evaluate(function (h) {
			Object.defineProperty(document, 'hidden', {value: h, configurable: true});
			document.dispatchEvent(new Event('visibilitychange'));
		}, hidden);
	};
	await setHidden(true);
	await expect.poll(subscribers, {timeout: 3000}).toBe(0);
	await setHidden(false);
	await expect.poll(subscribers, {timeout: 3000}).toBe(1);
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('network alert service: an alert it held back because the app is open becomes a banner', async function ({page}) {
	const opened = await openGrid(page);
	let polls = 0;
	const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
	await page.route(ALERTS_BASE + '/**', function (route) {
		if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
		const old = {at: '2026-06-15T10:00:00.000Z', camera: 'front', type: 'person', reason: 'ok', sent: true};
		const fresh = {at: '2026-06-15T10:05:00.000Z', camera: 'back', type: 'person', reason: 'viewing', sent: false};
		polls++;
		return route.fulfill({status: 200, headers: cors, contentType: 'application/json',
			body: JSON.stringify({ok: true, events: polls < 2 ? [old] : [fresh, old]})});
	});
	// Polling started at load against the real (unrouted) address; restart it now that the mock is in place.
	await page.reload({waitUntil: 'load'});
	await expect(page.locator('#banner')).toBeVisible({timeout: 12000});
	await expect(page.locator('#banner-title')).toHaveText('Back: Person detected');
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Updates: Check now reports a newer release as a banner and the status text', async function ({page}) {
	const feed = function (version) {
		return {paging: {page: 1}, packages: [{id: 'com.petekaik.webcamviewer', manifest: {version: version}}]};
	};
	let version = '9.9.9';
	const opened = await openGrid(page);
	await page.route('https://raw.githubusercontent.com/**', function (route) {
		route.fulfill({status: 200, headers: {'Access-Control-Allow-Origin': '*'}, contentType: 'application/json', body: JSON.stringify(feed(version))});
	});
	await openSettings(page);
	await openSettingsPage(page, 'general');
	await pressOkOn(page, '[data-action="general-update-check"]');
	await expect(page.locator('#general-list')).toContainText('Update available: 9.9.9', {timeout: 5000});
	await expect(page.locator('#banner-title')).toHaveText('Update available: 9.9.9');
	await sendKey(page, 'Back', 461); // dismisses the banner first
	await expect(page.locator('#banner')).toBeHidden();
	await expect(page.locator('#general-screen')).toBeVisible();

	version = '0.0.1';
	await pressOkOn(page, '[data-action="general-update-check"]');
	await expect(page.locator('#general-list')).toContainText('Up to date', {timeout: 5000});
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});

test('Updates: an unreachable or malformed feed says so and never throws', async function ({page}) {
	const opened = await openGrid(page);
	await page.route('https://raw.githubusercontent.com/**', function (route) { route.fulfill({status: 200, body: 'not json'}); });
	await openSettings(page);
	await openSettingsPage(page, 'general');
	await pressOkOn(page, '[data-action="general-update-check"]');
	await expect(page.locator('#general-list')).toContainText('Could not check', {timeout: 5000});
	expect(formatErrors(opened.errors), 'uncaught page errors').toBe('');
});
