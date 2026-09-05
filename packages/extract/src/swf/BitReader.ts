/** MSB-first bit reader, as SWF's packed structures require. */
export class BitReader {
  private bitPos = 0;

  constructor(
    private readonly buf: Buffer,
    private bytePos = 0,
  ) {}

  /** Byte offset of the next whole byte, after aligning. */
  get offset(): number {
    return this.bytePos;
  }

  align(): void {
    if (this.bitPos !== 0) {
      this.bitPos = 0;
      this.bytePos += 1;
    }
  }

  readBit(): number {
    const byte = this.buf[this.bytePos] ?? 0;
    const bit = (byte >> (7 - this.bitPos)) & 1;
    this.bitPos += 1;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos += 1;
    }
    return bit;
  }

  /** Unsigned bit field. */
  readUB(bits: number): number {
    let value = 0;
    for (let i = 0; i < bits; i++) value = (value << 1) | this.readBit();
    return value >>> 0;
  }

  /** Signed bit field, two's complement. */
  readSB(bits: number): number {
    if (bits === 0) return 0;
    const raw = this.readUB(bits);
    const sign = 1 << (bits - 1);
    return raw & sign ? raw - (1 << bits) : raw;
  }

  readU8(): number {
    this.align();
    const value = this.buf[this.bytePos] ?? 0;
    this.bytePos += 1;
    return value;
  }

  readU16(): number {
    this.align();
    const value = this.buf.readUInt16LE(this.bytePos);
    this.bytePos += 2;
    return value;
  }

  readS16(): number {
    this.align();
    const value = this.buf.readInt16LE(this.bytePos);
    this.bytePos += 2;
    return value;
  }

  readU32(): number {
    this.align();
    const value = this.buf.readUInt32LE(this.bytePos);
    this.bytePos += 4;
    return value;
  }

  get atEnd(): boolean {
    return this.bytePos >= this.buf.length;
  }

  /** RECT: 5-bit width field then four signed fields, in twips. */
  readRect(): { xMin: number; xMax: number; yMin: number; yMax: number } {
    this.align();
    const bits = this.readUB(5);
    const rect = {
      xMin: this.readSB(bits),
      xMax: this.readSB(bits),
      yMin: this.readSB(bits),
      yMax: this.readSB(bits),
    };
    this.align();
    return rect;
  }

  /**
   * CXFORMWITHALPHA: optional multiply and add terms per channel. Flash uses
   * these to tint a shared symbol, which is how one grey barrel shape becomes a
   * red one, so ignoring them loses most of the world's colour.
   */
  readColorTransform(withAlpha: boolean): {
    rMul: number; gMul: number; bMul: number; aMul: number;
    rAdd: number; gAdd: number; bAdd: number; aAdd: number;
  } {
    this.align();
    const hasAdd = this.readBit() === 1;
    const hasMult = this.readBit() === 1;
    const bits = this.readUB(4);
    const result = {
      rMul: 256, gMul: 256, bMul: 256, aMul: 256,
      rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0,
    };
    if (hasMult) {
      result.rMul = this.readSB(bits);
      result.gMul = this.readSB(bits);
      result.bMul = this.readSB(bits);
      if (withAlpha) result.aMul = this.readSB(bits);
    }
    if (hasAdd) {
      result.rAdd = this.readSB(bits);
      result.gAdd = this.readSB(bits);
      result.bAdd = this.readSB(bits);
      if (withAlpha) result.aAdd = this.readSB(bits);
    }
    this.align();
    return result;
  }

  /** MATRIX: optional scale and rotate/skew fields, then translation. */
  readMatrix(): [number, number, number, number, number, number] {
    this.align();
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (this.readBit()) {
      const bits = this.readUB(5);
      a = this.readSB(bits) / 65536;
      d = this.readSB(bits) / 65536;
    }
    if (this.readBit()) {
      const bits = this.readUB(5);
      b = this.readSB(bits) / 65536;
      c = this.readSB(bits) / 65536;
    }
    const translateBits = this.readUB(5);
    const tx = this.readSB(translateBits);
    const ty = this.readSB(translateBits);
    this.align();
    return [a, b, c, d, tx, ty];
  }
}

/** A Flash colour transform: per-channel multiply (÷256) then add. */
export interface ColorTransform {
  rMul: number;
  gMul: number;
  bMul: number;
  aMul: number;
  rAdd: number;
  gAdd: number;
  bAdd: number;
  aAdd: number;
}

export const IDENTITY_CXFORM: ColorTransform = {
  rMul: 256, gMul: 256, bMul: 256, aMul: 256,
  rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0,
};

/** Apply `child` first, then `parent`, matching nested display objects. */
export function composeCxform(parent: ColorTransform, child: ColorTransform): ColorTransform {
  const mul = (p: number, c: number): number => (p * c) / 256;
  const add = (pMul: number, cAdd: number, pAdd: number): number => (pMul * cAdd) / 256 + pAdd;
  return {
    rMul: mul(parent.rMul, child.rMul),
    gMul: mul(parent.gMul, child.gMul),
    bMul: mul(parent.bMul, child.bMul),
    aMul: mul(parent.aMul, child.aMul),
    rAdd: add(parent.rMul, child.rAdd, parent.rAdd),
    gAdd: add(parent.gMul, child.gAdd, parent.gAdd),
    bAdd: add(parent.bMul, child.bAdd, parent.bAdd),
    aAdd: add(parent.aMul, child.aAdd, parent.aAdd),
  };
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Transform a packed 0xRRGGBB colour and its alpha. */
export function applyCxform(
  color: number,
  alpha: number,
  cx: ColorTransform,
): { color: number; alpha: number } {
  const r = clamp255(((color >> 16) & 0xff) * (cx.rMul / 256) + cx.rAdd);
  const g = clamp255(((color >> 8) & 0xff) * (cx.gMul / 256) + cx.gAdd);
  const b = clamp255((color & 0xff) * (cx.bMul / 256) + cx.bAdd);
  const a = Math.max(0, Math.min(1, alpha * (cx.aMul / 256) + cx.aAdd / 255));
  return { color: (r << 16) | (g << 8) | b, alpha: a };
}
