'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Returns an async grab(source) -> Buffer|null. source is either an RTSP URL
// or, mostly for tests, an ffmpeg input argument array (e.g. lavfi).
function createGrabber(options) {
  const opts = options || {};
  const size = Number(opts.size) > 0 ? Math.floor(Number(opts.size)) : 80;
  const ffmpeg = opts.ffmpeg || 'ffmpeg';
  // RTSP waits for the next keyframe (5 s apart on these cameras); HTTP stills are instant.
  const timeoutMs = opts.timeoutMs || 8000;
  const logger = opts.logger || console;

  return async function grab(source) {
    const url = String(source);
    const input = Array.isArray(source)
      ? source
      : (/^rtsp:/i.test(url) ? ['-rtsp_transport', 'tcp', '-i', url] : ['-i', url]);
    const args = ['-hide_banner', '-loglevel', 'error']
      .concat(input)
      .concat([
        '-frames:v', '1',
        '-vf', 'crop=ih:ih,scale=' + size + ':' + size,
        '-f', 'image2', '-c:v', 'png', 'pipe:1'
      ]);

    try {
      const result = await execFileAsync(ffmpeg, args, {
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
        encoding: 'buffer'
      });
      const png = result.stdout;
      if (!Buffer.isBuffer(png) || png.length < PNG_MAGIC.length ||
          !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        logger.warn('[alerts] ffmpeg did not return a PNG');
        return null;
      }
      return png;
    } catch (err) {
      const stderr = err.stderr ? Buffer.from(err.stderr).toString('utf8').trim() : '';
      const detail = stderr ? stderr.split('\n').pop() : err.message;
      logger.warn('[alerts] snapshot failed: ' + detail);
      return null;
    }
  };
}

module.exports = { createGrabber, PNG_MAGIC };
