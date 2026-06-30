#!/usr/bin/env node
/**
 * Genera le icone PWA per Music Quiz.
 * Usa solo moduli Node.js built-in (zlib, fs, path) — zero dipendenze esterne.
 *
 * Design: "broadcast" — onde sonore bianche che si irradiano dal centro,
 * su sfondo viola-nero con glow rosa e viola. Accent bar rosa→viola in basso.
 *
 * Uso: node scripts/generate-icons.js
 */
"use strict";
const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

// ─── PNG encoder ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(tag, data) {
  const t   = Buffer.from(tag, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function encodePNG(w, h, rgba) {
  const rowBytes = w * 4;
  // filter byte (0 = None) prepended to each row
  const raw = Buffer.alloc(h * (rowBytes + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (rowBytes + 1)] = 0;
    rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Drawing primitives (work on Uint8ClampedArray of RGBA pixels) ────────────

function blendPixel(buf, w, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w) return;
  const h = buf.length / (w * 4);
  if (y >= h) return;
  const i   = (Math.round(y) * w + Math.round(x)) * 4;
  const sa  = a / 255;
  const da  = buf[i + 3] / 255;
  const oa  = sa + da * (1 - sa);
  if (oa < 0.001) { buf[i + 3] = 0; return; }
  buf[i]     = (r * sa + buf[i]     * da * (1 - sa)) / oa;
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa;
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa;
  buf[i + 3] = oa * 255;
}

function fillAll(buf, w, r, g, b) {
  const h = buf.length / (w * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4]     = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
}

function fillRect(buf, w, x0, y0, rw, rh, r, g, b, a) {
  for (let y = y0; y < y0 + rh; y++)
    for (let x = x0; x < x0 + rw; x++)
      blendPixel(buf, w, x, y, r, g, b, a);
}

function fillCircle(buf, w, cx, cy, radius, r, g, b, a) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2)
        blendPixel(buf, w, x, y, r, g, b, a);
    }
  }
}

function radialGlow(buf, w, cx, cy, radius, r, g, b, maxA) {
  const h = buf.length / (w * 4);
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d >= radius) continue;
      const t = 1 - d / radius;
      blendPixel(buf, w, x, y, r, g, b, t * t * maxA);
    }
  }
}

function strokeArc(buf, w, cx, cy, radius, a1, a2, thickness, r, g, b, a) {
  const steps = Math.max(80, Math.ceil(Math.abs(a2 - a1) * radius * 2));
  const half  = thickness / 2;
  for (let i = 0; i <= steps; i++) {
    const angle = a1 + (a2 - a1) * i / steps;
    fillCircle(buf, w, cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, half, r, g, b, a);
  }
}

function fillRoundRect(buf, w, x0, y0, rw, rh, cr, r, g, b, a) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const dx = x - x0, dy = y - y0;
      const inCorner =
        (dx < cr       && dy < cr       && (dx - cr)       ** 2 + (dy - cr)       ** 2 > cr * cr) ||
        (dx > rw - cr  && dy < cr       && (dx - (rw - cr)) ** 2 + (dy - cr)       ** 2 > cr * cr) ||
        (dx < cr       && dy > rh - cr  && (dx - cr)       ** 2 + (dy - (rh - cr)) ** 2 > cr * cr) ||
        (dx > rw - cr  && dy > rh - cr  && (dx - (rw - cr)) ** 2 + (dy - (rh - cr)) ** 2 > cr * cr);
      if (!inCorner) blendPixel(buf, w, x, y, r, g, b, a);
    }
  }
}

function gradientBar(buf, w, y0, barH, r1, g1, b1, r2, g2, b2) {
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    const r = r1 + (r2 - r1) * t;
    const g = g1 + (g2 - g1) * t;
    const b = b1 + (b2 - b1) * t;
    fillRect(buf, w, x, y0, 1, barH, r, g, b, 255);
  }
}

// ─── Downsample (box filter) ──────────────────────────────────────────────────

function downsample(src, srcW, srcH, dstW, dstH) {
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const sx0 = Math.floor(x * scaleX);
      const sx1 = Math.min(srcW, Math.ceil((x + 1) * scaleX));
      const sy0 = Math.floor(y * scaleY);
      const sy1 = Math.min(srcH, Math.ceil((y + 1) * scaleY));
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * srcW + sx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
          n++;
        }
      }
      const i2 = (y * dstW + x) * 4;
      dst[i2]     = r / n;
      dst[i2 + 1] = g / n;
      dst[i2 + 2] = b / n;
      dst[i2 + 3] = a / n;
    }
  }
  return dst;
}

// ─── Icon design ──────────────────────────────────────────────────────────────
//
// Render a HIGH-resolution canvas (RENDER_SIZE × RENDER_SIZE), then
// downsample to each target size for automatic antialiasing.
//
// Design:
//   • Dark purple-black background gradient
//   • Soft pink radial glow (top-left) + violet glow (bottom-right)
//   • Microphone silhouette: rounded capsule body + stand + base
//   • Three concentric arc pairs (sound waves) on left and right
//   • Gradient accent bar (pink → violet) at the very bottom

const RENDER_SIZE = 720; // = 4× of 180px
const S = RENDER_SIZE;
const PI = Math.PI;

function renderIcon() {
  const buf = new Uint8ClampedArray(S * S * 4);

  // 1. Background gradient (top-left dark → bottom-right slightly lighter purple)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (x / S * 0.4 + y / S * 0.6); // diagonal weight
      const r = Math.round(10 + t * 14);   // #0a → #18
      const g = Math.round(6  + t * 8);    // #06 → #0e
      const b = Math.round(18 + t * 28);   // #12 → #2e
      const i = (y * S + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }

  // 2. Glow: pink top-left
  radialGlow(buf, S, S * 0.25, S * 0.22, S * 0.65, 255, 61, 129, 90);

  // 3. Glow: violet bottom-right
  radialGlow(buf, S, S * 0.78, S * 0.78, S * 0.55, 124, 58, 237, 80);

  // 4. Microphone body (white rounded capsule, center-upper area)
  const micCX   = S * 0.5;
  const micBodyY = S * 0.15;
  const micBodyH = S * 0.38;
  const micBodyW = S * 0.20;
  const micCR   = micBodyW / 2;
  fillRoundRect(
    buf, S,
    micCX - micBodyW / 2, micBodyY,
    micBodyW, micBodyH, micCR,
    255, 255, 255, 255
  );

  // 5. Microphone grille lines (subtle dark horizontal stripes on the body)
  const grillCount = 4;
  for (let k = 1; k <= grillCount; k++) {
    const gy = micBodyY + (micBodyH / (grillCount + 1)) * k;
    fillRect(buf, S, micCX - micBodyW / 2 + S * 0.02, gy - S * 0.004, micBodyW - S * 0.04, S * 0.008, 10, 6, 18, 80);
  }

  // 6. Microphone stand (thin vertical line below body)
  const standTop    = micBodyY + micBodyH;
  const standBottom = standTop + S * 0.14;
  const standW      = S * 0.022;
  fillRoundRect(buf, S, micCX - standW / 2, standTop, standW, standBottom - standTop, standW / 2, 255, 255, 255, 255);

  // 7. Microphone base (horizontal bar)
  const baseW = S * 0.36;
  const baseH = S * 0.022;
  fillRoundRect(buf, S, micCX - baseW / 2, standBottom, baseW, baseH, baseH / 2, 255, 255, 255, 255);

  // 8. Sound wave arcs — centered on mid-height of microphone body
  const waveCX = micCX;
  const waveCY = micBodyY + micBodyH * 0.45;

  // Radii & thickness at render scale
  const radii     = [S * 0.195, S * 0.285, S * 0.375];
  const thickness = [S * 0.030, S * 0.025, S * 0.022];
  const alphas    = [255, 210, 155];
  const span      = [55, 60, 66]; // half-span in degrees for each ring

  for (let k = 0; k < 3; k++) {
    const rad = radii[k];
    const thk = thickness[k];
    const alp = alphas[k];
    const s   = span[k] * PI / 180;

    // LEFT arcs (opening left, ≈ 120° to 240° = π*2/3 to π*4/3)
    strokeArc(buf, S, waveCX, waveCY, rad, PI - s, PI + s, thk, 255, 255, 255, alp);

    // RIGHT arcs (opening right, ≈ -s to +s = around 0°)
    strokeArc(buf, S, waveCX, waveCY, rad, -s, s, thk, 255, 255, 255, alp);
  }

  // 9. Accent bar at the bottom (pink → violet)
  const barH = Math.round(S * 0.034);
  gradientBar(buf, S, S - barH, barH, 255, 61, 129, 124, 58, 237);

  return buf;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const SIZES = [120, 152, 167, 180, 192, 512];
const OUT_DIR = path.join(__dirname, "..", "public", "icons");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`Rendering icona a ${RENDER_SIZE}×${RENDER_SIZE} (supersampling 4×)...`);
const large = renderIcon();

for (const size of SIZES) {
  process.stdout.write(`  → ${size}×${size}px ... `);
  const small  = downsample(large, RENDER_SIZE, RENDER_SIZE, size, size);
  const png    = encodePNG(size, size, Buffer.from(small.buffer));
  const file   = path.join(OUT_DIR, `apple-touch-icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`${png.length.toLocaleString()} bytes`);
}

// Copy principale senza dimensione nel nome (180px)
const main    = downsample(large, RENDER_SIZE, RENDER_SIZE, 180, 180);
const mainPng = encodePNG(180, 180, Buffer.from(main.buffer));
fs.writeFileSync(path.join(OUT_DIR, "apple-touch-icon.png"), mainPng);
console.log(`  → apple-touch-icon.png (copia 180px)`);
console.log("\n✓ Tutte le icone generate in public/icons/");
