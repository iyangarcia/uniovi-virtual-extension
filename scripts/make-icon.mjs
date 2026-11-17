// Generates extension/icons/icon{16,48,128}.png (white "U" on blue) without image deps.
// Run once: node scripts/make-icon.mjs. The PNGs are committed.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function png(size) {
  const s = size / 128; // design on a 128 grid
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter: none
    for (let x = 0; x < size; x++) {
      const X = (x + 0.5) / s, Y = (y + 0.5) / s;
      // rounded square
      const r = 26, inX = Math.max(r - X, X - (128 - r), 0), inY = Math.max(r - Y, Y - (128 - r), 0);
      const inside = inX * inX + inY * inY <= r * r;
      // "U": two bars + bottom half-ring
      const d = Math.hypot(X - 64, Y - 74);
      const u = ((X >= 34 && X <= 52) || (X >= 76 && X <= 94)) && Y >= 28 && Y <= 74 || (Y > 74 && d >= 12 && d <= 30);
      if (!inside) row.push(0, 0, 0, 0);
      else if (u) row.push(255, 255, 255, 255);
      else row.push(0x15, 0x65, 0xc0, 255);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("extension/icons", { recursive: true });
for (const size of [16, 48, 128]) writeFileSync(`extension/icons/icon${size}.png`, png(size));
console.log("icons written");
