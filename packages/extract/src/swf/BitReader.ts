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
