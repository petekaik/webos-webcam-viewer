#!/usr/bin/env node
/**
 * es5-check.js — fail before deploy if anything under app/ is not strict ES5.
 *
 * The TV runs Chromium 53 / V8 ~5.3. Every previous attempt on this device
 * failed for reasons the laptop toolchain did not surface; a stray `const`
 * or arrow function is one of the few failures we can catch for free before
 * `ares-package`. This parses every app/**\/*.js as strict ES5 with acorn
 * (ecmaVersion 5), so `const`, `let`, arrows, classes, template literals,
 * `import`/`export`, `async` etc. are all parse errors.
 *
 * Usage (from anywhere):
 *   node tools/testing/es5-check.js
 *
 * Exit codes:
 *   0  every file parses as strict ES5
 *   1  at least one syntax violation
 *   2  checker misconfigured (acorn missing, app/ missing or has no JS)
 *
 * Requires acorn:  cd tools/testing && npm install
 */
'use strict';

var fs = require('fs');
var path = require('path');

var REPO_ROOT = path.resolve(__dirname, '..', '..');
var APP_DIR = process.env.WEBCAM_APP_DIR
	? path.resolve(process.env.WEBCAM_APP_DIR)
	: path.join(REPO_ROOT, 'app');

// Added after Chrome 53: Object.values/entries (54), Element.append/prepend (54),
// padStart/padEnd (57), Promise#finally (63), flat/flatMap (69), closest is fine (41).
var CHROME53_MISSING = /Object\.(values|entries|fromEntries)\b|\.(padStart|padEnd|finally|append|prepend|replaceWith|flat|flatMap|matchAll|trimStart|trimEnd)\(|\b(IntersectionObserver|ResizeObserver|AbortController|requestIdleCallback)\b/;

function loadAcorn() {
	try {
		return require('acorn');
	} catch (err) {
		console.error('es5-check: cannot find acorn.');
		console.error('  Run:  cd tools/testing && npm install');
		console.error('  (' + (err && err.message ? err.message : err) + ')');
		process.exit(2);
	}
}

/** Recursively collect .js files, sorted for stable output. */
function findJsFiles(dir, out) {
	var entries;
	try {
		entries = fs.readdirSync(dir, {withFileTypes: true});
	} catch (err) {
		return;
	}
	entries.sort(function (a, b) {
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
	for (var i = 0; i < entries.length; i++) {
		var entry = entries[i];
		var full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			findJsFiles(full, out);
		} else if (entry.isFile() && /\.js$/i.test(entry.name)) {
			out.push(full);
		}
	}
}

function main() {
	var acorn = loadAcorn();

	if (!fs.existsSync(APP_DIR) || !fs.statSync(APP_DIR).isDirectory()) {
		console.error('es5-check: app directory not found: ' + APP_DIR);
		console.error('  (set WEBCAM_APP_DIR to point somewhere else)');
		process.exit(2);
	}

	var files = [];
	findJsFiles(APP_DIR, files);

	if (files.length === 0) {
		console.error('es5-check: no .js files under ' + APP_DIR);
		console.error('  Refusing to report success: an app with no JavaScript is probably the wrong path.');
		process.exit(2);
	}

	var violations = [];
	for (var i = 0; i < files.length; i++) {
		var file = files[i];
		var raw = fs.readFileSync(file, 'utf8');
		if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // BOM
		if (raw.slice(0, 2) === '#!') raw = '//' + raw.slice(2); // shebang

		// Parse as strict: the leading directive makes acorn reject sloppy-only
		// ES5 too (e.g. `with`, octal literals). One synthetic line is prepended,
		// so reported line numbers are shifted back by one.
		var source = '"use strict";\n' + raw;
		try {
			acorn.parse(source, {
				ecmaVersion: 5,
				sourceType: 'script',
				locations: true
			});
			// Valid ES5 syntax can still call APIs Chromium 53 lacks. Our code only;
			// vendored libs feature-detect. ponytail: regex denylist, may false-positive on
			// same-named user methods; extend list when the TV throws "is not a function".
			if (file.indexOf(path.sep + 'vendor' + path.sep) === -1) {
				var lines = raw.split('\n');
				for (var n = 0; n < lines.length; n++) {
					var m = CHROME53_MISSING.exec(lines[n]);
					if (m) violations.push(path.relative(REPO_ROOT, file) + ':' + (n + 1) +
						'  API not in Chromium 53: ' + m[0]);
				}
			}
		} catch (err) {
			var line = err.loc ? Math.max(1, err.loc.line - 1) : 1;
			var col = err.loc ? err.loc.column + 1 : 1;
			var rel = path.relative(REPO_ROOT, file);
			// acorn appends its own (shifted) "(line:col)" to the message.
			var message = String(err.message).replace(/\s*\(\d+:\d+\)$/, '');
			violations.push(rel + ':' + line + ':' + col + '  ' + message);
		}
	}

	if (violations.length === 0) {
		console.log('es5-check: OK — ' + files.length + ' file(s) parse as strict ES5.');
		process.exit(0);
	}

	console.error('es5-check: FAIL — ' + violations.length + ' violation(s) in ' +
		files.length + ' file(s) (target is Chromium 53: no ES6+ syntax):');
	for (var v = 0; v < violations.length; v++) {
		console.error('  ' + violations[v]);
	}
	console.error('');
	console.error('Fix the syntax or transpile it to ES5 before packaging for the TV.');
	process.exit(1);
}

main();
