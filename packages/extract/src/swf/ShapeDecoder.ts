/**
 * DefineShape 1-4 -> filled subpaths.
 *
 * Only what the character's face and torso textures need is implemented: solid
 * fills, straight and quadratic edges. Gradients and bitmap fills are recorded
 * with their average colour rather than reproduced, and strokes are ignored --
 * the source art for these symbols is flat-shaded.
 */
import { BitReader } from './BitReader.js';

/** Path commands in twips: M x y | L x y | Q cx cy x y. */
export type PathCommand =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'Q'; cx: number; cy: number; x: number; y: number };

export interface SubPath {
  /** 0xRRGGBB, or -1 when the fill could not be resolved. */
  color: number;
  alpha: number;
  commands: PathCommand[];
}

export interface DecodedShape {
  id: number;
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  paths: SubPath[];
}

interface FillStyle {
  color: number;
  alpha: number;
}

const FILL_SOLID = 0x00;

function readFillStyles(r: BitReader, withAlpha: boolean, extended: boolean): FillStyle[] {
  let count = r.readU8();
  if (extended && count === 0xff) count = r.readU16();
  const styles: FillStyle[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.readU8();
    if (type === FILL_SOLID) {
      const red = r.readU8();
      const green = r.readU8();
      const blue = r.readU8();
      const alpha = withAlpha ? r.readU8() / 255 : 1;
      styles.push({ color: (red << 16) | (green << 8) | blue, alpha });
      continue;
    }
    if (type === 0x10 || type === 0x12 || type === 0x13) {
      // Gradient: average the stops so the shape still reads correctly.
      r.readMatrix();
      const spread = r.readU8();
      const stopCount = type === 0x13 ? (spread & 0x0f) : spread & 0x0f;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let s = 0; s < stopCount; s++) {
        r.readU8(); // ratio
        red += r.readU8();
        green += r.readU8();
        blue += r.readU8();
        alpha += withAlpha ? r.readU8() : 255;
      }
      if (type === 0x13) r.readS16(); // focal point
      const n = Math.max(stopCount, 1);
      styles.push({
        color: (((red / n) | 0) << 16) | (((green / n) | 0) << 8) | ((blue / n) | 0),
        alpha: alpha / n / 255,
      });
      continue;
    }
    if (type >= 0x40 && type <= 0x43) {
      r.readU16(); // bitmap id
      r.readMatrix();
      styles.push({ color: -1, alpha: 1 });
      continue;
    }
    // Unknown fill type: the byte stream is no longer trustworthy.
    styles.push({ color: -1, alpha: 1 });
    break;
  }
  return styles;
}

function skipLineStyles(r: BitReader, withAlpha: boolean, extended: boolean, shape4: boolean): void {
  let count = r.readU8();
  if (extended && count === 0xff) count = r.readU16();
  for (let i = 0; i < count; i++) {
    r.readU16(); // width
    if (shape4) {
      const flags = r.readU16();
      const hasFill = (flags & 0x0008) !== 0;
      if ((flags & 0x0030) === 0x0020) r.readU16(); // miter limit
      if (hasFill) {
        // A line fill is a full FILLSTYLE; reuse the reader and discard it.
        readFillStyles(new BitReader(Buffer.alloc(0)), withAlpha, extended);
        r.readU8();
        r.readMatrix();
      } else {
        r.readU8();
        r.readU8();
        r.readU8();
        if (withAlpha) r.readU8();
      }
    } else {
      r.readU8();
      r.readU8();
      r.readU8();
      if (withAlpha) r.readU8();
    }
  }
}

export function decodeShape(tagCode: number, body: Buffer): DecodedShape | null {
  const withAlpha = tagCode === 32 || tagCode === 83; // DefineShape3 / 4
  const extended = tagCode !== 2; // DefineShape2 and later allow 16-bit counts
  const shape4 = tagCode === 83;
  if (body.length < 3) return null;

  const r = new BitReader(body, 0);
  const id = r.readU16();
  const bounds = r.readRect();
  if (shape4) {
    r.readRect(); // edge bounds
    r.readU8(); // flags
  }

  let fills = readFillStyles(r, withAlpha, extended);
  skipLineStyles(r, withAlpha, extended, shape4);

  let fillBits = r.readUB(4);
  let lineBits = r.readUB(4);

  const paths: SubPath[] = [];
  // Edges accumulate into a run; a style change or a move closes the run and
  // files it under whichever fill is active. Shapes declare a left fill
  // (FillStyle0) and/or a right fill (FillStyle1) and either may be the one
  // that actually paints, so both are tracked.
  const runs = new Map<number, PathCommand[][]>();
  let run: PathCommand[] = [];
  let fill0 = 0;
  let fill1 = 0;
  let x = 0;
  let y = 0;

  const flush = (): void => {
    const index = fill1 || fill0;
    if (run.length > 1 && index > 0) {
      const list = runs.get(index) ?? [];
      list.push(run);
      runs.set(index, list);
    }
    run = [];
  };

  let guard = 0;
  while (!r.atEnd && guard++ < 100000) {
    const isEdge = r.readBit();
    if (!isEdge) {
      const flags = r.readUB(5);
      if (flags === 0) break; // EndShapeRecord

      // Fields appear in this order regardless of which are present.
      if (flags & 0x01) {
        flush();
        const bits = r.readUB(5);
        x = r.readSB(bits);
        y = r.readSB(bits);
      }
      if (flags & 0x02) {
        flush();
        fill0 = r.readUB(fillBits);
      }
      if (flags & 0x04) {
        flush();
        fill1 = r.readUB(fillBits);
      }
      if (flags & 0x08) r.readUB(lineBits);
      if (flags & 0x10) {
        flush();
        fills = readFillStyles(r, withAlpha, extended);
        skipLineStyles(r, withAlpha, extended, shape4);
        fillBits = r.readUB(4);
        lineBits = r.readUB(4);
        fill0 = 0;
        fill1 = 0;
      }
      // Every new run starts from the current pen position.
      if (run.length === 0) run = [{ op: 'M', x, y }];
      continue;
    }

    if (run.length === 0) run = [{ op: 'M', x, y }];

    const isStraight = r.readBit();
    const bits = r.readUB(4) + 2;
    if (isStraight) {
      if (r.readBit()) {
        x += r.readSB(bits);
        y += r.readSB(bits);
      } else if (r.readBit()) {
        y += r.readSB(bits);
      } else {
        x += r.readSB(bits);
      }
      run.push({ op: 'L', x, y });
    } else {
      const cx = x + r.readSB(bits);
      const cy = y + r.readSB(bits);
      x = cx + r.readSB(bits);
      y = cy + r.readSB(bits);
      run.push({ op: 'Q', cx, cy, x, y });
    }
  }
  flush();

  for (const [fillIndex, subpaths] of runs) {
    const style = fills[fillIndex - 1];
    if (!style || style.color < 0) continue;
    paths.push({
      color: style.color,
      alpha: style.alpha,
      commands: subpaths.flat(),
    });
  }

  return { id, bounds, paths };
}
