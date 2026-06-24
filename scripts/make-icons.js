'use strict';
/**
 * 의존성 없이(Node 내장 zlib만) PWA 아이콘 PNG를 생성한다.
 * 가을 그라데이션 배경 + 부드러운 음표 + 비네팅.
 *   node scripts/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = 0 (deflate, adaptive filter, no interlace)
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c0, c1, t) {
  return [Math.round(lerp(c0[0], c1[0], t)), Math.round(lerp(c0[1], c1[1], t)), Math.round(lerp(c0[2], c1[2], t))];
}

function render(size) {
  const w = size, h = size;
  const buf = Buffer.alloc(w * 4 * h);
  const topLeft = [0x16, 0x2a, 0x1d];   // deep forest green
  const botRight = [0xc8, 0x86, 0x2a];  // warm amber
  const cream = [0xf3, 0xe7, 0xd6];

  // 음표(8분음표) 파라미터 — 가운데 안전영역 안에 배치
  const headR = size * 0.135;
  const headCx = size * 0.40, headCy = size * 0.66;
  const stemW = size * 0.05;
  const stemX = headCx + headR * 0.82;
  const stemTop = size * 0.26;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 대각 그라데이션
      let t = (x / w + y / h) / 2;
      let [r, g, b] = mix(topLeft, botRight, t);
      // 비네팅(가장자리 어둡게)
      const dx = (x - w / 2) / (w / 2), dy = (y - h / 2) / (h / 2);
      const v = Math.max(0, 1 - 0.55 * (dx * dx + dy * dy));
      r *= v; g *= v; b *= v;

      // 음표 그리기(부드러운 안티앨리어싱)
      let noteA = 0;
      // 머리(살짝 기운 타원)
      const hx = x - headCx, hy = y - headCy;
      const ell = (hx * hx) / (headR * headR) + (hy * hy) / ((headR * 0.8) * (headR * 0.8));
      if (ell < 1) noteA = 1; else noteA = Math.max(noteA, Math.max(0, 1 - (ell - 1) * 8));
      // 기둥
      if (x >= stemX && x <= stemX + stemW && y >= stemTop && y <= headCy) noteA = 1;
      // 깃발(기둥 위 오른쪽으로 흐르는 곡선 근사)
      const fx = x - (stemX + stemW);
      const fy = y - stemTop;
      if (fx >= 0 && fy >= 0 && fy < size * 0.22) {
        const curve = size * 0.16 * (1 - fy / (size * 0.22));
        if (fx < curve && fx < size * 0.13) noteA = 1;
      }

      if (noteA > 0) {
        r = lerp(r, cream[0], noteA); g = lerp(g, cream[1], noteA); b = lerp(b, cream[2], noteA);
      }

      const i = (y * w + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b); buf[i + 3] = 255;
    }
  }
  return encodePng(w, h, buf);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512, 180]) {
  const png = render(size);
  const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('wrote', name, png.length, 'bytes');
}
