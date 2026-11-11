#!/usr/bin/env node
'use strict';

// Keep a webOS TV app up to date by installing the latest GitHub release with
// LG's official CLI. Runs outside the TV because the TV itself cannot install
// packages (appInstallService/dev/install is denied on real hardware).

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  feed: 'https://raw.githubusercontent.com/petekaik/webos-webcam-viewer/main/webosbrew/apps.json',
  appId: 'com.petekaik.webcamviewer',
  device: 'tv',
  intervalHours: 6,
  retryMinutes: 15,
  installIfMissing: false,
  aresBin: 'ares-install',
  launchBin: 'ares-launch',
};

const FEED_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const CLI_TIMEOUT_MS = 5 * 60_000; // a powered-off TV must not hang the job
const MAX_IPK_BYTES = 64 * 1024 * 1024;
const URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^?#]+\.ipk$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

function parseFeed(raw, appId) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.packages)) {
    throw new Error('feed: missing packages array');
  }
  const pkg = data.packages.find((p) => p && p.id === appId);
  if (!pkg) return null;

  const m = pkg.manifest;
  if (!m || typeof m !== 'object') throw new Error('feed: package has no manifest');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    throw new Error('feed: bad version');
  }
  if (typeof m.ipkUrl !== 'string' || m.ipkUrl.length === 0) {
    throw new Error('feed: bad ipkUrl');
  }
  const sha256 = m.ipkHash && m.ipkHash.sha256;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error('feed: bad ipkHash.sha256');
  }
  if (!Number.isInteger(m.ipkSize) || m.ipkSize <= 0 || m.ipkSize > MAX_IPK_BYTES) {
    throw new Error('feed: bad ipkSize');
  }
  return { version: m.version, ipkUrl: m.ipkUrl, sha256: sha256.toLowerCase(), ipkSize: m.ipkSize };
}

// Numeric major.minor.patch comparison; any -suffix / +suffix is ignored.
function compareVersions(a, b) {
  const nums = (v) => String(v).split(/[-+]/, 1)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function allowedUrl(url) {
  return typeof url === 'string' && URL_RE.test(url);
}

// Parses blocks like "id : com.x.y" / "version : 0.3.1" from ares-install -F.
function parseInstalledVersion(output, appId) {
  let currentId = null;
  for (const line of String(output).split(/\r?\n/)) {
    const id = line.match(/^\s*id\s*:\s*(.+?)\s*$/);
    if (id) {
      currentId = id[1];
      continue;
    }
    const version = line.match(/^\s*version\s*:\s*(.+?)\s*$/);
    if (version && currentId === appId) return version[1];
  }
  return null;
}

function exitCodeFor(result) {
  if (result.status === 'deferred') return 2;
  if (result.status === 'refused' || result.status === 'failed') return 1;
  return 0;
}

async function runOnce(deps) {
  const { config, fetch, exec, now } = deps;
  const log = deps.log || ((o) => console.log(JSON.stringify(o)));
  const say = (level, msg, extra = {}) =>
    log({ t: new Date(now()).toISOString(), level, msg, ...extra });

  // 1. Fetch feed. A network failure is transient; a malformed feed is not.
  let feedText;
  try {
    const res = await fetch(config.feed, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feedText = await res.text();
  } catch (err) {
    say('warn', 'feed unreachable; deferring', { error: err.message });
    return { status: 'deferred', reason: 'feed' };
  }

  let pkg;
  try {
    pkg = parseFeed(feedText, config.appId);
  } catch (err) {
    say('error', 'malformed feed; refusing', { error: err.message });
    return { status: 'refused', reason: 'feed' };
  }
  if (!pkg) {
    say('error', 'app not found in feed; refusing', { appId: config.appId });
    return { status: 'refused', reason: 'missing-app' };
  }

  // 2. Only GitHub release .ipk URLs are allowed.
  if (!allowedUrl(pkg.ipkUrl)) {
    say('error', 'ipkUrl not allowed; refusing', { ipkUrl: pkg.ipkUrl });
    return { status: 'refused', reason: 'url' };
  }

  // 3. Installed version. CLI failure means the TV is unreachable.
  let installed;
  try {
    const { stdout } = await exec(config.aresBin, ['-d', config.device, '-F']);
    installed = parseInstalledVersion(stdout, config.appId);
  } catch (err) {
    say('warn', 'TV unreachable; deferring', { device: config.device, error: err.message });
    return { status: 'deferred', reason: 'unreachable' };
  }

  if (installed === null && !config.installIfMissing) {
    say('info', 'app not installed; skipping (installIfMissing=false)', { appId: config.appId });
    return { status: 'not-installed' };
  }

  // 4. Install only when the feed is newer (or the app is missing and allowed).
  if (installed !== null && compareVersions(pkg.version, installed) <= 0) {
    say('info', 'up to date', { installed, feed: pkg.version });
    return { status: 'up-to-date', installed, version: pkg.version };
  }

  // 5. Installing replaces the running app, so never do it while it is open.
  let running;
  try {
    const { stdout } = await exec(config.launchBin, ['-d', config.device, '-r']);
    running = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    say('warn', 'could not list running apps; deferring', { error: err.message });
    return { status: 'deferred', reason: 'launch-check' };
  }
  if (running.includes(config.appId)) {
    say('info', 'app is running; deferring install', { appId: config.appId });
    return { status: 'deferred', reason: 'app-open' };
  }

  say('info', installed === null ? 'app missing; installing' : 'newer version available', {
    installed, feed: pkg.version,
  });

  // 6./7. Download, verify, install.
  let tmpDir;
  let ipkPath;
  try {
    const res = await fetch(pkg.ipkUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (declared > pkg.ipkSize) {
      say('error', 'download larger than the feed says; refusing', { expected: pkg.ipkSize, declared });
      return { status: 'refused', reason: 'size' };
    }
    const buf = Buffer.from(await res.arrayBuffer());

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcam-updater-'));
    ipkPath = path.join(tmpDir, 'update.ipk');
    fs.writeFileSync(ipkPath, buf);

    if (buf.length !== pkg.ipkSize) {
      say('error', 'size mismatch; refusing', { expected: pkg.ipkSize, got: buf.length });
      return { status: 'refused', reason: 'size' };
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(ipkPath)).digest('hex');
    if (hash !== pkg.sha256) {
      say('error', 'sha256 mismatch; refusing', { expected: pkg.sha256, got: hash });
      return { status: 'refused', reason: 'hash' };
    }

    if (config.dryRun) {
      say('info', 'dry run: would install', { ipkUrl: pkg.ipkUrl, version: pkg.version });
      return { status: 'dry-run', version: pkg.version };
    }

    try {
      await exec(config.aresBin, ['-d', config.device, ipkPath]);
    } catch (err) {
      say('error', 'install failed', { error: err.message });
      return { status: 'failed', reason: 'install' };
    }

    let after = null;
    try {
      const { stdout } = await exec(config.aresBin, ['-d', config.device, '-F']);
      after = parseInstalledVersion(stdout, config.appId);
    } catch (err) {
      say('warn', 'could not re-read installed version', { error: err.message });
    }
    const confirmed = after !== null && compareVersions(after, pkg.version) === 0;
    say(confirmed ? 'info' : 'warn',
      confirmed ? 'installed and version confirmed' : 'installed but version not confirmed',
      { version: pkg.version, installed: after });
    return { status: 'installed', confirmed, version: pkg.version, installed: after };
  } catch (err) {
    say('error', 'download failed', { error: err.message });
    return { status: 'failed', reason: 'download' };
  } finally {
    if (ipkPath) try { fs.unlinkSync(ipkPath); } catch { /* already gone */ }
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* already gone */ }
  }
}

function execFile(cmd, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: CLI_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function parseArgs(argv) {
  const opts = { once: false, dryRun: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') opts.once = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--config') opts.config = argv[++i];
    else if (arg.startsWith('--config=')) opts.config = arg.slice('--config='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function loadConfig(file) {
  const config = { ...DEFAULTS };
  if (file) Object.assign(config, JSON.parse(fs.readFileSync(file, 'utf8')));
  return config;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig(opts.config);
  if (opts.dryRun) config.dryRun = true;

  const log = (o) => console.log(JSON.stringify(o));
  const deps = { config, fetch: globalThis.fetch, exec: execFile, now: Date.now, log };

  if (opts.once) {
    const result = await runOnce(deps);
    process.exitCode = exitCodeFor(result);
    return;
  }

  for (;;) {
    let result;
    try {
      result = await runOnce(deps);
    } catch (err) {
      log({ t: new Date().toISOString(), level: 'error', msg: 'unexpected error', error: err.message });
      result = { status: 'failed' };
    }
    const minutes = result.status === 'deferred' ? config.retryMinutes : config.intervalHours * 60;
    const waitMs = Math.max(1, minutes) * 60_000;
    log({
      t: new Date().toISOString(), level: 'info', msg: 'sleeping',
      minutes: waitMs / 60_000, nextRun: new Date(Date.now() + waitMs).toISOString(),
    });
    await sleep(waitMs);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'fatal', error: err.message }));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  parseFeed,
  compareVersions,
  allowedUrl,
  parseInstalledVersion,
  exitCodeFor,
  runOnce,
  parseArgs,
  loadConfig,
};
