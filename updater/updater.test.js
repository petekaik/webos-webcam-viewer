'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  parseFeed, compareVersions, allowedUrl, parseInstalledVersion, exitCodeFor, runOnce,
} = require('./updater.js');

const APP = 'com.petekaik.webcamviewer';
const IPK_URL = 'https://github.com/petekaik/webos-webcam-viewer/releases/download/v0.3.2/com.petekaik.webcamviewer_0.3.2_all.ipk';
const IPK = Buffer.from('pretend this is an ipk');

function feed(overrides = {}) {
  return JSON.stringify({
    packages: [{
      id: APP,
      manifest: {
        version: '0.3.2',
        ipkUrl: IPK_URL,
        ipkHash: { sha256: crypto.createHash('sha256').update(IPK).digest('hex') },
        ipkSize: IPK.length,
        ...overrides,
      },
    }],
  });
}

function listOutput(version) {
  return `id : ${APP}\nversion : ${version}\n\nid : com.other.app\nversion : 9.9.9\n`;
}

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function collector() {
  const logs = [];
  return {
    logs,
    log: (o) => logs.push(o),
    has: (level, msg) => logs.some((l) => l.level === level && (!msg || l.msg.includes(msg))),
  };
}

// Standard fakes: feed OK, ipk OK, app installed at `installed`.
function harness({ installed = '0.3.1', running = '', feedText = feed(), ipk = IPK, installError = null } = {}) {
  const calls = [];
  let listCalls = 0;
  let current = installed;

  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'ares-install' && args.includes('-F')) {
      listCalls++;
      return { stdout: current === null ? listOutput('0.0.1').replace(APP, 'com.nope') : listOutput(current) };
    }
    if (cmd === 'ares-launch' && args.includes('-r')) {
      return { stdout: running };
    }
    if (cmd === 'ares-install') {
      if (installError) throw new Error(installError);
      current = '0.3.2'; // the fake install takes effect
      return { stdout: '' };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };

  const fakeFetch = async (url) => {
    calls.push(['fetch', url]);
    if (url === 'https://feed.test/apps.json') return response(feedText);
    return response(ipk);
  };

  const c = collector();
  return {
    calls, c,
    deps: {
      config: {
        feed: 'https://feed.test/apps.json', appId: APP, device: 'tv',
        intervalHours: 6, retryMinutes: 15, installIfMissing: false,
        aresBin: 'ares-install', launchBin: 'ares-launch', dryRun: false,
      },
      fetch: fakeFetch,
      exec,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
      log: c.log,
    },
    installs: () => calls.filter((x) => x[0] === 'ares-install' && !x.includes('-F')).length,
    listCalls: () => listCalls,
  };
}

test('parseFeed accepts a valid feed', () => {
  const pkg = parseFeed(feed(), APP);
  assert.equal(pkg.version, '0.3.2');
  assert.equal(pkg.ipkUrl, IPK_URL);
  assert.equal(pkg.ipkSize, IPK.length);
  assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
});

test('parseFeed returns null when the app is absent', () => {
  assert.equal(parseFeed(feed(), 'com.someone.else'), null);
});

test('parseFeed rejects malformed feeds', () => {
  assert.throws(() => parseFeed('not json', APP));
  assert.throws(() => parseFeed('{}', APP));
  assert.throws(() => parseFeed('{"packages":{}}', APP));
  assert.throws(() => parseFeed(feed({ version: 'latest' }), APP));
  assert.throws(() => parseFeed(feed({ ipkUrl: 42 }), APP));
  assert.throws(() => parseFeed(feed({ ipkHash: { sha256: 'abc' } }), APP));
  assert.throws(() => parseFeed(feed({ ipkSize: 0 }), APP));
  assert.throws(() => parseFeed(feed({ ipkSize: '12' }), APP));
});

test('compareVersions compares numerically, ignoring suffixes', () => {
  assert.equal(compareVersions('0.3.1', '0.3.2'), -1);
  assert.equal(compareVersions('0.3.2', '0.10.0'), -1);
  assert.equal(compareVersions('0.3.1', '0.3.1'), 0);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.3.2-beta.1', '0.3.2'), 0);
  assert.equal(compareVersions('0.3.2+build5', '0.3.2'), 0);
  assert.equal(compareVersions('0.10.0', '0.2.9'), 1);
});

test('allowedUrl accepts only GitHub release .ipk URLs', () => {
  assert.equal(allowedUrl(IPK_URL), true);
  assert.equal(allowedUrl('https://github.com/a/b/releases/download/tag/app_1.0.0_all.ipk'), true);
  assert.equal(allowedUrl('http://github.com/a/b/releases/download/tag/app.ipk'), false);
  assert.equal(allowedUrl('https://evil.com/a/b/releases/download/tag/app.ipk'), false);
  assert.equal(allowedUrl('https://github.com.evil.com/a/b/releases/download/tag/app.ipk'), false);
  assert.equal(allowedUrl(`${IPK_URL}?download=1`), false);
  assert.equal(allowedUrl(`${IPK_URL}#frag`), false);
  assert.equal(allowedUrl('https://github.com/a/b/releases/download/tag/app.zip'), false);
  assert.equal(allowedUrl('https://github.com/a/b/archive/refs/tags/v1.ipk'), false);
});

test('parseInstalledVersion reads id/version blocks', () => {
  assert.equal(parseInstalledVersion(listOutput('0.3.1'), APP), '0.3.1');
  assert.equal(parseInstalledVersion(`  id :   ${APP}  \n version: 1.2.3 \n`, APP), '1.2.3');
  assert.equal(parseInstalledVersion(listOutput('0.3.1'), 'com.not.there'), null);
  assert.equal(parseInstalledVersion('', APP), null);
  assert.equal(parseInstalledVersion('garbage\nversion : 1.0.0', APP), null);
});

test('exit codes map to the brief', () => {
  assert.equal(exitCodeFor({ status: 'up-to-date' }), 0);
  assert.equal(exitCodeFor({ status: 'installed' }), 0);
  assert.equal(exitCodeFor({ status: 'dry-run' }), 0);
  assert.equal(exitCodeFor({ status: 'not-installed' }), 0);
  assert.equal(exitCodeFor({ status: 'refused' }), 1);
  assert.equal(exitCodeFor({ status: 'failed' }), 1);
  assert.equal(exitCodeFor({ status: 'deferred' }), 2);
});

test('runOnce: up to date does not install', async () => {
  const h = harness({ installed: '0.3.2' });
  const result = await runOnce(h.deps);
  assert.equal(result.status, 'up-to-date');
  assert.equal(h.installs(), 0);
  assert.equal(h.c.has('info', 'up to date'), true);
});

test('runOnce: newer version is downloaded, verified and installed', async () => {
  const h = harness({ installed: '0.3.1' });
  const result = await runOnce(h.deps);
  assert.equal(result.status, 'installed');
  assert.equal(result.confirmed, true);
  assert.equal(h.installs(), 1);
  assert.equal(h.listCalls(), 2, 're-reads the installed version after installing');
  assert.equal(h.c.has('info', 'installed and version confirmed'), true);
});

test('runOnce: defers when the app is running', async () => {
  const h = harness({ running: `${APP}\ncom.other.app\n` });
  const result = await runOnce(h.deps);
  assert.deepEqual(result, { status: 'deferred', reason: 'app-open' });
  assert.equal(h.installs(), 0);
  assert.equal(h.calls.some((c) => c[0] === 'fetch' && c[1] !== 'https://feed.test/apps.json'), false);
});

test('runOnce: defers when the TV is unreachable', async () => {
  const h = harness();
  h.deps.exec = async () => { throw new Error('connection refused'); };
  const result = await runOnce(h.deps);
  assert.deepEqual(result, { status: 'deferred', reason: 'unreachable' });
  assert.equal(h.c.has('warn', 'TV unreachable'), true);
});

test('runOnce: refuses on hash mismatch and never installs', async () => {
  const h = harness({ feedText: feed({ ipkHash: { sha256: '0'.repeat(64) } }) });
  const result = await runOnce(h.deps);
  assert.deepEqual(result, { status: 'refused', reason: 'hash' });
  assert.equal(h.installs(), 0);
  assert.equal(h.c.has('error', 'sha256 mismatch'), true);
});

test('runOnce: refuses on size mismatch and never installs', async () => {
  const h = harness({ feedText: feed({ ipkSize: IPK.length + 1 }) });
  const result = await runOnce(h.deps);
  assert.deepEqual(result, { status: 'refused', reason: 'size' });
  assert.equal(h.installs(), 0);
  assert.equal(h.c.has('error', 'size mismatch'), true);
});

test('runOnce: dry run downloads and verifies but does not install', async () => {
  const h = harness();
  h.deps.config.dryRun = true;
  const result = await runOnce(h.deps);
  assert.equal(result.status, 'dry-run');
  assert.equal(h.installs(), 0);
  assert.equal(h.c.has('info', 'dry run: would install'), true);
});

test('runOnce: skips a missing app unless installIfMissing', async () => {
  const h = harness({ installed: null });
  const result = await runOnce(h.deps);
  assert.equal(result.status, 'not-installed');
  assert.equal(h.installs(), 0);
});

test('runOnce: installs a missing app when installIfMissing is set', async () => {
  const h = harness({ installed: null });
  h.deps.config.installIfMissing = true;
  const result = await runOnce(h.deps);
  assert.equal(result.status, 'installed');
  assert.equal(h.installs(), 1);
});

test('runOnce: malformed feed is refused before touching the TV', async () => {
  const h = harness({ feedText: '{"packages": "nope"}' });
  const result = await runOnce(h.deps);
  assert.deepEqual(result, { status: 'refused', reason: 'feed' });
  assert.equal(h.calls.some((c) => c[0] === 'ares-install'), false);
});

test('runOnce: disallowed ipk URL is refused', async () => {
  const h = harness({ feedText: feed({ ipkUrl: 'https://evil.example/app.ipk' }) });
  const result = await runOnce(h.deps);
  assert.deepEqual(result, { status: 'refused', reason: 'url' });
  assert.equal(h.installs(), 0);
});

test('parseFeed rejects an absurd ipkSize', () => {
  const feed = { packages: [{ id: 'a.b', manifest: { version: '1.0.0', ipkUrl: 'https://github.com/o/r/releases/download/v1/a.ipk',
    ipkHash: { sha256: 'a'.repeat(64) }, ipkSize: 65 * 1024 * 1024 } }] };
  assert.throws(() => parseFeed(feed, 'a.b'), /ipkSize/);
});
