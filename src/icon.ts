import { deflateSync } from 'node:zlib';

/**
 * The TutorDesk mark: a sheet on the desk, two lines of writing and one in the accent colour. Drawn
 * from rectangles, so the same shapes make the SVG favicon, the PNGs of the web manifest and the
 * Windows shortcut icon without an image library.
 */

const INK = '#111111';
const PAPER = '#ffffff';
const ACCENT = '#24508f';

/** [x, y, width, height, colour] on a 64 × 64 grid. */
const SHAPES: [number, number, number, number, string][] = [
  [0, 0, 64, 64, INK],
  [16, 10, 32, 44, PAPER],
  [22, 20, 20, 4, INK],
  [22, 28, 20, 4, INK],
  [22, 36, 12, 4, ACCENT],
];

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${SHAPES.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('')}</svg>`;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

let crcTable: number[] | undefined;
function crc32(buf: Buffer): number {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** The mark as a square PNG of `size` pixels. */
export function iconPng(size: number): Buffer {
  const scale = size / 64;
  const row = size * 4 + 1;
  const px = Buffer.alloc(row * size);
  for (const [x, y, w, h, c] of SHAPES) {
    const [r, g, b] = rgb(c);
    for (let j = Math.round(y * scale); j < Math.round((y + h) * scale); j++) {
      for (let i = Math.round(x * scale); i < Math.round((x + w) * scale); i++) {
        const o = j * row + 1 + i * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

/** A Windows .ico holding PNGs (Vista and later read these). */
export function iconIco(sizes = [16, 32, 48, 256]): Buffer {
  const pngs = sizes.map(iconPng);
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i]!.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i]!.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...pngs]);
}

export const MANIFEST = JSON.stringify({
  name: 'TutorDesk',
  short_name: 'TutorDesk',
  start_url: '/',
  display: 'standalone',
  background_color: PAPER,
  theme_color: PAPER,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
});
