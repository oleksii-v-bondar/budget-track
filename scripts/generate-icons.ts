/**
 * Writes the PWA icons to src/web/public: an SVG (also the favicon) and PNGs for the web app manifest and iOS.
 * The design is a white bar chart on brand green, drawn full-bleed so the PNGs also work as maskable icons (the bars
 * stay inside the central 80 % safe zone). Run with `npm run icons` after changing it; the output is committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const OUT = new URL('../src/web/public/', import.meta.url);
const BRAND: [number, number, number] = [0x15, 0x80, 0x3d];
const WHITE: [number, number, number] = [0xff, 0xff, 0xff];

/** Bars in units of the icon's size (0..1): left, top, width, height, corner radius. */
const BARS = [
  { x: 0.25, y: 0.5, w: 0.13, h: 0.24, r: 0.03 },
  { x: 0.435, y: 0.36, w: 0.13, h: 0.38, r: 0.03 },
  { x: 0.62, y: 0.24, w: 0.13, h: 0.5, r: 0.03 },
];

function svg(): string {
  const bars = BARS.map(
    (b) =>
      `<rect x="${b.x * 512}" y="${b.y * 512}" width="${b.w * 512}" height="${b.h * 512}" rx="${b.r * 512}" fill="#fff"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#15803d"/>${bars}</svg>\n`;
}

/** True when (px, py), in units of the icon's size, lies inside a bar (a rounded rectangle). */
function inBar(px: number, py: number): boolean {
  return BARS.some((b) => {
    const dx = Math.max(b.x + b.r - px, 0, px - (b.x + b.w - b.r));
    const dy = Math.max(b.y + b.r - py, 0, py - (b.y + b.h - b.r));
    return dx * dx + dy * dy <= b.r * b.r;
  });
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGB PNG of the design at `size` × `size` pixels, anti-aliased with 4 × 4 samples per pixel. */
function png(size: number): Buffer {
  const SAMPLES = 4;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 (none), then RGB triples
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (inBar((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size)) covered++;
        }
      }
      const alpha = covered / (SAMPLES * SAMPLES);
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(BRAND[c]! + (WHITE[c]! - BRAND[c]!) * alpha);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit depth, truecolour, deflate, no filter, no interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pixels = deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL('icon.svg', OUT), svg());
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
] as const) {
  writeFileSync(new URL(name, OUT), png(size));
}
console.log('icons written to src/web/public');
