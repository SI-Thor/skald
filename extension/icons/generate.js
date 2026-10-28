// skald — icon PNG generator. Dependency-free Node script (uses only
// node:zlib / node:fs): renders the icon with a hand-rolled PNG encoder and
// 4x supersampling, writing icon-{16,32,48,96}.png next to this file.
//
// Run: node icons/generate.js
//
// Design (mirrors icon.svg): dark rounded-rect tile (#222837) with a
// five-bar amber waveform (#ffb454, centre bar lighter #ffce82).

'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

// ---- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter type: none
    rgba.copy ?
      rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4) :
      Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing ----------------------------------------------------------------

// Layout in unit coordinates (0..1); mirrors icon.svg at 96px.
const LAYOUT = {
  tile: { hw: 0.5, hh: 0.5, r: 0.1875 }, // rounded-rect half extents + radius
  bars: [
    { cx: 0.245, hh: 0.15 },
    { cx: 0.372, hh: 0.27 },
    { cx: 0.5, hh: 0.4 },
    { cx: 0.628, hh: 0.27 },
    { cx: 0.755, hh: 0.15 },
  ],
  barHw: 0.0365, // half width → 7px at 96
  barR: 0.0365, // pill-shaped ends
};

const BG = [0x22, 0x28, 0x37, 255];
const AMBER = [0xff, 0xb4, 0x54, 255];
const AMBER_LIGHT = [0xff, 0xce, 0x82, 255];

function insideRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) <= r;
}

/** Render at `size` px using 4x supersampling; returns an RGBA Buffer. */
function renderIcon(size) {
  const SS = 4;
  const big = size * SS;
  const coverage = new Float32Array(big * big); // 0..1 alpha coverage
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const ux = (x + 0.5) / big;
      const uy = (y + 0.5) / big;
      if (insideRoundRect(ux, uy, 0.5, 0.5, LAYOUT.tile.hw, LAYOUT.tile.hh, LAYOUT.tile.r)) {
        coverage[y * big + x] = 1;
      }
    }
  }
  const barMask = new Float32Array(big * big);
  for (let i = 0; i < LAYOUT.bars.length; i++) {
    const b = LAYOUT.bars[i];
    for (let y = 0; y < big; y++) {
      for (let x = 0; x < big; x++) {
        const ux = (x + 0.5) / big;
        const uy = (y + 0.5) / big;
        if (insideRoundRect(ux, uy, b.cx, 0.5, LAYOUT.barHw, b.hh, LAYOUT.barR)) {
          barMask[y * big + x] = i === 2 ? 2 : 1; // centre bar marker
        }
      }
    }
  }

  // Compose with box-filter downsampling.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0;
      let barCov = 0;
      let lightCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = (y * SS + sy) * big + (x * SS + sx);
          if (coverage[idx]) {
            bgCov += 1;
            if (barMask[idx] === 1) barCov += 1;
            else if (barMask[idx] === 2) lightCov += 1;
          }
        }
      }
      const total = SS * SS;
      const tileA = bgCov / total;
      const barA = barCov / total;
      const lightA = lightCov / total;
      const o = (y * size + x) * 4;
      // Start transparent, layer tile then bars (bars always sit on the tile).
      let rC = 0;
      let gC = 0;
      let bC = 0;
      let aC = tileA;
      if (aC > 0) {
        rC = (BG[0] * tileA) / aC;
        gC = (BG[1] * tileA) / aC;
        bC = (BG[2] * tileA) / aC;
      }
      if (barA > 0 || lightA > 0) {
        // Replace tile colour under the bars (bars are opaque on the tile).
        const brC = AMBER[0] * barA + AMBER_LIGHT[0] * lightA;
        const bgC = AMBER[1] * barA + AMBER_LIGHT[1] * lightA;
        const bbC = AMBER[2] * barA + AMBER_LIGHT[2] * lightA;
        const barTot = barA + lightA;
        rC = (rC * (tileA - barTot) + brC) / tileA;
        gC = (gC * (tileA - barTot) + bgC) / tileA;
        bC = (bC * (tileA - barTot) + bbC) / tileA;
      }
      out[o] = Math.round(Math.min(255, Math.max(0, rC)));
      out[o + 1] = Math.round(Math.min(255, Math.max(0, gC)));
      out[o + 2] = Math.round(Math.min(255, Math.max(0, bC)));
      out[o + 3] = Math.round(aC * 255);
    }
  }
  return out;
}

function main() {
  const sizes = [16, 32, 48, 96];
  for (const size of sizes) {
    const file = path.join(__dirname, `icon-${size}.png`);
    const png = encodePng(size, size, renderIcon(size));
    fs.writeFileSync(file, png);
    console.log(`wrote ${file} (${size}x${size}, ${png.length} bytes)`);
  }
}

main();
