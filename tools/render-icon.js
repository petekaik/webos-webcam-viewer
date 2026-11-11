#!/usr/bin/env node
/*
 * tools/render-icon.js — renders app/largeIcon.png (600) and app/icon.png
 * (130) with zero dependencies: pixel-wise supersampled rasterization of the
 * same geometry as tools/icon.html (keep the two in sync).
 *
 * Exists because the screenshot/Rasterize flow (Playwright) is not installed
 * in every checkout; this always works where Node works.
 *
 *   node tools/render-icon.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var OUT = [
  [600, path.join(__dirname, '..', 'app', 'largeIcon.png')],
  [130, path.join(__dirname, '..', 'app', 'icon.png')],
  [600, path.join(__dirname, '..', 'design', 'screens', 'icon-600.png')],
  [130, path.join(__dirname, '..', 'design', 'screens', 'icon-130.png')]
];

/* ------------------------------------------------------------ PNG writer */

var CRC_TABLE = (function () {
  var table = new Array(256);
  var n;
  var c;
  var k;
  for (n = 0; n < 256; n++) {
    c = n;
    for (k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  var c = 0xFFFFFFFF;
  var i;
  for (i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  var out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  /* bit depth */
  ihdr[9] = 6;  /* RGBA */
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  var raw = Buffer.alloc(height * (1 + width * 4));
  var y;
  for (y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; /* filter: none */
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------------------------------------------- drawing */

function hex(s) {
  return {
    r: parseInt(s.substr(1, 2), 16),
    g: parseInt(s.substr(3, 2), 16),
    b: parseInt(s.substr(5, 2), 16)
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(a, b, t) {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t)
  };
}

function over(dst, src, alpha) {
  /* src color composited over dst with coverage alpha */
  dst.r = lerp(dst.r, src.r, alpha);
  dst.g = lerp(dst.g, src.g, alpha);
  dst.b = lerp(dst.b, src.b, alpha);
}

function segDist(px, py, ax, ay, bx, by) {
  var dx = bx - ax;
  var dy = by - ay;
  var len2 = dx * dx + dy * dy;
  var t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  var cx = ax + t * dx;
  var cy = ay + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

/* Geometry in 600-unit space; identical to tools/icon.html. */

var AMBER_HI = hex('#ffd79b');
var AMBER_MID = hex('#f0b35b');
var AMBER_LO = hex('#cf8a3c');
var BG = hex('#0b0d0f');
var GLASS_IN = hex('#10161d');
var GLASS_OUT = hex('#0a0c0e');
var GLINT = hex('#ffe9c4');

var ROOF = [[168, 268, 300, 174], [300, 174, 432, 268]];
var WALLS = [[206, 262, 206, 438], [206, 438, 394, 438], [394, 438, 394, 262]];
var STROKE_R = 17; /* 34 / 2 */

var LENS_C = [300, 338];
var LENS_R = 68;
var LENS_RING_W_R = 9; /* 18 / 2 */
var GLASS_R = 36;
var GLINT_C = [320, 316];
var GLINT_R = 11;

function amberAt(y) {
  var t = y / 600;
  if (t <= 0.55) {
    return lerpColor(AMBER_HI, AMBER_MID, t / 0.55);
  }
  return lerpColor(AMBER_MID, AMBER_LO, (t - 0.55) / 0.45);
}

function inRoundedRect(x, y) {
  var dx = Math.abs(x - 300) - (300 - 112);
  var dy = Math.abs(y - 300) - (300 - 112);
  var ox = Math.max(dx, 0);
  var oy = Math.max(dy, 0);
  var d = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - 112;
  return d <= 0;
}

function strokeHit(x, y, segs, radius) {
  var i;
  for (i = 0; i < segs.length; i++) {
    if (segDist(x, y, segs[i][0], segs[i][1], segs[i][2], segs[i][3]) <= radius) {
      return true;
    }
  }
  return false;
}

function sample(x, y, rgba) {
  /* rgba: [r,g,b,a] accumulator for one subsample */
  var col;
  var t;
  var d;

  rgba[0] = 0;
  rgba[1] = 0;
  rgba[2] = 0;
  rgba[3] = 0;

  if (!inRoundedRect(x, y)) {
    return;
  }

  col = { r: BG.r, g: BG.g, b: BG.b };

  /* top-left amber glow */
  d = Math.sqrt((x - 192) * (x - 192) + (y - 144) * (y - 144)) / 540;
  if (d < 1) {
    t = d <= 0.6 ? lerp(0.09, 0.03, d / 0.6) : lerp(0.03, 0, (d - 0.6) / 0.4);
    over(col, AMBER_MID, t);
  }

  /* floor glow ellipse */
  var ex = (x - 300) / 170;
  var ey = (y - 486) / 42;
  var u = ex * ex + ey * ey;
  if (u < 1) {
    over(col, AMBER_MID, 0.06 * (1 - u));
  }

  /* house outline */
  if (strokeHit(x, y, ROOF, STROKE_R) || strokeHit(x, y, WALLS, STROKE_R)) {
    var amber = amberAt(y);
    col.r = amber.r;
    col.g = amber.g;
    col.b = amber.b;
  }

  /* lens ring */
  var dl = Math.sqrt((x - LENS_C[0]) * (x - LENS_C[0]) + (y - LENS_C[1]) * (y - LENS_C[1]));
  if (Math.abs(dl - LENS_R) <= LENS_RING_W_R) {
    var ringCol = amberAt(y);
    col.r = ringCol.r;
    col.g = ringCol.g;
    col.b = ringCol.b;
  }

  /* lens glass */
  if (dl <= GLASS_R) {
    var glass = lerpColor(GLASS_IN, GLASS_OUT, dl / GLASS_R);
    col.r = glass.r;
    col.g = glass.g;
    col.b = glass.b;
  }

  /* glint */
  var dg = Math.sqrt((x - GLINT_C[0]) * (x - GLINT_C[0]) + (y - GLINT_C[1]) * (y - GLINT_C[1]));
  if (dg <= GLINT_R) {
    col.r = GLINT.r;
    col.g = GLINT.g;
    col.b = GLINT.b;
  }

  rgba[0] = col.r;
  rgba[1] = col.g;
  rgba[2] = col.b;
  rgba[3] = 255;
}

function render(size) {
  var SS = 4;
  var out = Buffer.alloc(size * size * 4);
  var px;
  var py;
  var i;
  var j;
  var acc = [0, 0, 0, 0];
  var s = [0, 0, 0, 0];
  var sampleCount = SS * SS;
  var scale = 600 / size;

  for (py = 0; py < size; py++) {
    for (px = 0; px < size; px++) {
      acc[0] = 0;
      acc[1] = 0;
      acc[2] = 0;
      acc[3] = 0;
      for (j = 0; j < SS; j++) {
        for (i = 0; i < SS; i++) {
          sample((px + (i + 0.5) / SS) * scale, (py + (j + 0.5) / SS) * scale, s);
          acc[0] += s[0];
          acc[1] += s[1];
          acc[2] += s[2];
          acc[3] += s[3];
        }
      }
      var off = (py * size + px) * 4;
      out[off] = Math.round(acc[0] / sampleCount);
      out[off + 1] = Math.round(acc[1] / sampleCount);
      out[off + 2] = Math.round(acc[2] / sampleCount);
      out[off + 3] = Math.round(acc[3] / sampleCount);
    }
  }
  return out;
}

function main() {
  var i;
  for (i = 0; i < OUT.length; i++) {
    var size = OUT[i][0];
    var file = OUT[i][1];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(size, size, render(size)));
    console.log('wrote ' + path.relative(path.join(__dirname, '..'), file) + ' (' + size + 'x' + size + ')');
  }
}

main();
