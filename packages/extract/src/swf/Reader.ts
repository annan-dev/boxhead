/**
 * Minimal SWF container reader: header, zlib body, and a recursive tag walker.
 * Only the tags this project needs are given names; the rest pass through by code.
 */
import { inflateSync } from 'node:zlib';

export interface SwfTag {
  /** SWF tag code, e.g. 39 = DefineSprite, 12 = DoAction. */
  code: number;
  /** Tag body, excluding the header word. */
  body: Buffer;
}

export interface SwfFile {
  version: number;
  frameRate: number;
  frameCount: number;
  /** Fully decompressed body, starting at the FrameSize RECT. */
  raw: Buffer;
  tags: SwfTag[];
}

export const TagCode = {
  DefineBits: 6,
  DefineSound: 14,
  DefineBitsLossless: 20,
  DefineBitsJPEG2: 21,
  DoAction: 12,
  DefineBitsJPEG3: 35,
  DefineBitsLossless2: 36,
  DefineSprite: 39,
  DoInitAction: 59,
  ExportAssets: 56,
  End: 0,
} as const;

/** Advance past a RECT, whose bit width is encoded in the top 5 bits of byte 0. */
function rectEnd(b: Buffer, off: number): number {
  const nbits = b[off]! >> 3;
  return off + Math.ceil((5 + nbits * 4) / 8);
}

/** Walk a flat tag stream. Stops after the End tag. */
export function walkTags(buf: Buffer, start = 0): SwfTag[] {
  const out: SwfTag[] = [];
  let off = start;
  while (off < buf.length - 1) {
    const header = buf.readUInt16LE(off);
    off += 2;
    const code = header >> 6;
    let len = header & 0x3f;
    if (len === 0x3f) {
      len = buf.readUInt32LE(off);
      off += 4;
    }
    out.push({ code, body: buf.subarray(off, off + len) });
    off += len;
    if (code === TagCode.End) break;
  }
  return out;
}

export function readSwf(data: Buffer): SwfFile {
  const sig = data.toString('latin1', 0, 3);
  if (sig !== 'CWS' && sig !== 'FWS' && sig !== 'ZWS') {
    throw new Error(`not a SWF: signature ${JSON.stringify(sig)}`);
  }
  if (sig === 'ZWS') throw new Error('LZMA-compressed SWF (ZWS) is not supported');

  const version = data[3]!;
  const declared = data.readUInt32LE(4);
  const raw = sig === 'CWS' ? inflateSync(data.subarray(8)) : data.subarray(8);

  // declared length counts the 8-byte header; a mismatch means a truncated or padded file
  if (sig === 'CWS' && raw.length + 8 !== declared) {
    process.stderr.write(
      `warning: body is ${raw.length + 8} bytes, header declares ${declared}\n`,
    );
  }

  let off = rectEnd(raw, 0);
  const frameRate = raw.readUInt16LE(off) / 256;
  off += 2;
  const frameCount = raw.readUInt16LE(off);
  off += 2;

  return { version, frameRate, frameCount, raw, tags: walkTags(raw, off) };
}

/** Nested tags inside a DefineSprite body (which begins with id + frameCount). */
export function spriteTags(body: Buffer): SwfTag[] {
  return walkTags(body.subarray(4), 0);
}

export function spriteId(body: Buffer): number {
  return body.readUInt16LE(0);
}

/** Parse ExportAssets into id -> exported symbol name. */
export function parseExportAssets(body: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  if (body.length < 2) return out;
  const count = body.readUInt16LE(0);
  let p = 2;
  for (let i = 0; i < count; i++) {
    if (p + 2 > body.length) break;
    const id = body.readUInt16LE(p);
    p += 2;
    const end = body.indexOf(0, p);
    if (end < 0) break;
    out.set(id, body.toString('latin1', p, end));
    p = end + 1;
  }
  return out;
}
