import { deflateSync } from 'node:zlib';

/** Distance from point p to the segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** The app icon (blue rounded square with a white check mark, same as web/icon.svg) as a PNG. */
export function iconPng(size = 128): Buffer {
  const ss = 3; // supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const radius = size * 0.22;
  const stroke = size * 0.055;
  const [a, b, c] = [
    [0.25, 0.53],
    [0.42, 0.7],
    [0.75, 0.34],
  ].map(([x, y]) => [x * size, y * size]);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let alpha = 0;
      let white = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const cx = Math.max(radius, Math.min(size - radius, px));
          const cy = Math.max(radius, Math.min(size - radius, py));
          if (Math.hypot(px - cx, py - cy) > radius) continue;
          alpha++;
          if (Math.min(segDist(px, py, a[0], a[1], b[0], b[1]), segDist(px, py, b[0], b[1], c[0], c[1])) <= stroke) white++;
        }
      }
      const n = ss * ss;
      const t = (x + y) / (2 * size);
      const base = [59 + (29 - 59) * t, 130 + (78 - 130) * t, 246 + (216 - 246) * t];
      const w = alpha ? white / alpha : 0;
      const o = row + 1 + x * 4;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(base[i] * (1 - w) + 255 * w);
      raw[o + 3] = Math.round((alpha / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A Windows .ico holding one PNG image (supported since Windows Vista). */
export function iconIco(size = 128): Buffer {
  const png = iconPng(size);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = size >= 256 ? 0 : size;
  head[7] = size >= 256 ? 0 : size;
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}
