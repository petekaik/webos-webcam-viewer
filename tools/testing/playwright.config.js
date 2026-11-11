'use strict';

const path = require('path');
const { defineConfig } = require('@playwright/test');

const httpPort = Number(process.env.MOCK_HTTP_PORT || 8888);

/**
 * Playwright starts the mock camera server automatically. Point the tests at
 * a different built app with MOCK_APP_DIR=/path/to/app (the mock server serves
 * it at /app/index.html and inherits the same env var).
 */
module.exports = defineConfig({
	testDir: __dirname,
	testMatch: /smoke\.spec\.js$/,
	timeout: 30000,
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:' + httpPort,
		// The real cameras use self-signed HTTPS. Ignore cert errors by default
		// so the app can show snapshots; one test turns this off on purpose to
		// reproduce webOS blocking the cert.
		ignoreHTTPSErrors: true,
		viewport: { width: 1280, height: 720 },
		trace: 'retain-on-failure'
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } }
	],
	webServer: {
		command: 'node mock-camera-server.js',
		cwd: __dirname,
		url: 'http://127.0.0.1:' + httpPort + '/healthz',
		reuseExistingServer: true,
		timeout: 120000
	}
});
