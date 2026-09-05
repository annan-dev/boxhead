/**
 * DefineBitsLossless / DefineBitsLossless2 -> RGBA.
 *
 * Tag 20 stores PIX24 (one unused byte, then RGB); tag 36 stores PIX32 with
 * alpha first and RGB *premultiplied*, which must be undone for PNG. Rows in
 * colour-mapped images are padded to a 4-byte boundary.
 */
import { inflateSync } from 'node:zlib';

export interface DecodedBitmap {
  id: number;
  width: number;
  height: number;
  /** Non-premultiplied RGBA, width * height * 4 bytes. */
  rgba: Buffer;
}

const FORMAT_COLORMAP = 3;
const FORMAT_RGB15 = 4;
const FORMAT_RGB24 = 5;

export function decodeLossless(body: Buffer, hasAlpha: boolean): DecodedBitmap | null {
  if (body.length < 7) return null;
  const id = body.readUInt16LE(0);
  const format = body[2]!;
  const width = body.readUInt16LE(3);
  const height = body.readUInt16LE(5);
  if (width <= 0 || height <= 0) return null;

  let offset = 7;
  let tableSize = 0;
  if (format === FORMAT_COLORMAP) {
    tableSize = body[offset]! + 1;
    offset += 1;
  }

  let data: Buffer;
  try {
    data = inflateSync(body.subarray(offset));
  } catch {
    return null;
  }

  const rgba = Buffer.alloc(width * height * 4);

  if (format === FORMAT_COLORMAP) {
    const entry = hasAlpha ? 4 : 3;
    const table = data.subarray(0, tableSize * entry);
    const pixels = data.subarray(tableSize * entry);
    const stride = (width + 3) & ~3; // padded to 4 bytes
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = pixels[y * stride + x] ?? 0;
        const p = index * entry;
        const out = (y * width + x) * 4;
        const a = hasAlpha ? (table[p + 3] ?? 255) : 255;
        rgba[out] = table[p] ?? 0;
        rgba[out + 1] = table[p + 1] ?? 0;
        rgba[out + 2] = table[p + 2] ?? 0;
        rgba[out + 3] = a;
      }
    }
    return { id, width, height, rgba };
  }

  if (format === FORMAT_RGB15) {
    const stride = (width * 2 + 3) & ~3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = data.readUInt16BE(y * stride + x * 2);
        const out = (y * width + x) * 4;
        rgba[out] = ((v >> 10) & 0x1f) << 3;
        rgba[out + 1] = ((v >> 5) & 0x1f) << 3;
        rgba[out + 2] = (v & 0x1f) << 3;
        rgba[out + 3] = 255;
      }
    }
    return { id, width, height, rgba };
  }

  if (format === FORMAT_RGB24) {
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      const out = i * 4;
      if (hasAlpha) {
        const a = data[p] ?? 0;
        // Stored premultiplied; recover straight colour for PNG.
        const scale = a === 0 ? 0 : 255 / a;
        rgba[out] = a === 0 ? 0 : Math.min(255, Math.round((data[p + 1] ?? 0) * scale));
        rgba[out + 1] = a === 0 ? 0 : Math.min(255, Math.round((data[p + 2] ?? 0) * scale));
        rgba[out + 2] = a === 0 ? 0 : Math.min(255, Math.round((data[p + 3] ?? 0) * scale));
        rgba[out + 3] = a;
      } else {
        rgba[out] = data[p + 1] ?? 0;
        rgba[out + 1] = data[p + 2] ?? 0;
        rgba[out + 2] = data[p + 3] ?? 0;
        rgba[out + 3] = 255;
      }
    }
    return { id, width, height, rgba };
  }

  return null;
}
