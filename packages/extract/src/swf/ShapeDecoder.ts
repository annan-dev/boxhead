/**
 * DefineShape 1-4 and DefineMorphShape -> filled subpaths.
 *
 * Only what the character's face and torso textures need is implemented: solid
 * fills, straight and quadratic edges. Gradients and bitmap fills are recorded
 * with their average colour rather than reproduced, and strokes are ignored --
 * the source art for these symbols is flat-shaded.
 *
 * A morph shape is decoded at its start state. The two symbols in the source
 * that use one (the rocket and a blood spray) never actually tween, so the
 * start shape is the whole picture.
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
  /** Bitmap character ids referenced by fills, in style order. */
  bitmaps: number[];
}

interface FillStyle {
  color: number;
  alpha: number;
  bitmap?: number;
}

const FILL_SOLID = 0x00;
export const TAG_DEFINE_MORPH_SHAPE = 46;

/** Blend two colours; a morph shape is drawn part way between its two states. */
function lerpColor(
  a: { color: number; alpha: number },
  b: { color: number; alpha: number },
  t: number,
): { color: number; alpha: number } {
  const channel = (shift: number): number =>
    Math.round(((a.color >> shift) & 0xff) * (1 - t) + ((b.color >> shift) & 0xff) * t);
  return {
    color: (channel(16) << 16) | (channel(8) << 8) | channel(0),
    alpha: a.alpha * (1 - t) + b.alpha * t,
  };
}

function readRgba(r: BitReader, withAlpha: boolean): { color: number; alpha: number } {
  const red = r.readU8();
  const green = r.readU8();
  const blue = r.readU8();
  const alpha = withAlpha ? r.readU8() / 255 : 1;
  return { color: (red << 16) | (green << 8) | blue, alpha };
}

function readFillStyles(r: BitReader, withAlpha: boolean, extended: boolean): FillStyle[] {
  let count = r.readU8();
  if (extended && count === 0xff) count = r.readU16();
  const styles: FillStyle[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.readU8();
    if (type === FILL_SOLID) {
      styles.push(readRgba(r, withAlpha));
      continue;
    }
    if (type === 0x10 || type === 0x12 || type === 0x13) {
      // Gradient: average the stops so the shape still reads correctly.
      r.readMatrix();
      const spread = r.readU8();
      const stopCount = spread & 0x0f;
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
      const bitmap = r.readU16();
      r.readMatrix();
      styles.push({ color: -1, alpha: 1, bitmap });
      continue;
    }
    // Unknown fill type: the byte stream is no longer trustworthy.
    styles.push({ color: -1, alpha: 1 });
    break;
  }
  return styles;
}

/**
 * Morph fill styles carry a start and an end state for every field; the two
 * are blended at ratio `t`.
 */
function readMorphFillStyles(r: BitReader, t: number): FillStyle[] {
  let count = r.readU8();
  if (count === 0xff) count = r.readU16();
  const styles: FillStyle[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.readU8();
    if (type === FILL_SOLID) {
      const start = readRgba(r, true);
      const end = readRgba(r, true);
      styles.push(lerpColor(start, end, t));
      continue;
    }
    if (type === 0x10 || type === 0x12 || type === 0x13) {
      r.readMatrix(); // start gradient matrix
      r.readMatrix(); // end gradient matrix
      const stopCount = r.readU8() & 0x0f;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let s = 0; s < stopCount; s++) {
        r.readU8(); // start ratio
        const start = readRgba(r, true);
        r.readU8(); // end ratio
        const end = readRgba(r, true);
        const mixed = lerpColor(start, end, t);
        red += (mixed.color >> 16) & 0xff;
        green += (mixed.color >> 8) & 0xff;
        blue += mixed.color & 0xff;
        alpha += mixed.alpha;
      }
      const n = Math.max(stopCount, 1);
      styles.push({
        color: (((red / n) | 0) << 16) | (((green / n) | 0) << 8) | ((blue / n) | 0),
        alpha: alpha / n,
      });
      continue;
    }
    if (type >= 0x40 && type <= 0x43) {
      const bitmap = r.readU16();
      r.readMatrix();
      r.readMatrix();
      styles.push({ color: -1, alpha: 1, bitmap });
      continue;
    }
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
        // A line fill is a full FILLSTYLE; read and discard it.
        readFillStyles(new BitReader(Buffer.alloc(0)), withAlpha, extended);
        r.readU8();
        r.readMatrix();
      } else {
        readRgba(r, withAlpha);
      }
    } else {
      readRgba(r, withAlpha);
    }
  }
}

function skipMorphLineStyles(r: BitReader): void {
  let count = r.readU8();
  if (count === 0xff) count = r.readU16();
  for (let i = 0; i < count; i++) {
    r.readU16(); // start width
    r.readU16(); // end width
    readRgba(r, true);
    readRgba(r, true);
  }
}

interface RecordContext {
  withAlpha: boolean;
  extended: boolean;
  shape4: boolean;
  /** Morph shapes cannot introduce new styles mid-stream. */
  allowNewStyles: boolean;
  /** For a morph shape: the end state's edges, blended in at ratio `t`. */
  morph?: { end: Edge[]; t: number } | undefined;
}

/** One shape edge, with an optional quadratic control point. */
interface Edge {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  curved: boolean;
}

/**
 * Walk the shape records and assemble filled outlines.
 *
 * Flash shapes share edges: a boundary between two faces of a cube is stored
 * once, painting FillStyle0 on its left and FillStyle1 on its right. Every
 * edge is therefore filed under both fills (reversed for the left one), and
 * each fill's edges are then chained into closed loops. Filing an edge under
 * only one fill, as a simpler reading does, leaves the neighbouring face open
 * and it closes across the gap as a triangle.
 */
function readShapeRecords(r: BitReader, initialFills: FillStyle[], ctx: RecordContext): SubPath[] {
  let fills = initialFills;
  let fillBits = r.readUB(4);
  let lineBits = r.readUB(4);

  const edgesByFill = new Map<number, { style: FillStyle | undefined; edges: Edge[] }>();
  let fill0 = 0;
  let fill1 = 0;
  let x = 0;
  let y = 0;
  // A style table may be replaced mid-shape; edges remember the table they
  // came from so a later replacement cannot recolour them.
  let tableId = 0;

  const file = (index: number, edge: Edge): void => {
    if (index <= 0) return;
    const key = tableId * 65536 + index;
    let entry = edgesByFill.get(key);
    if (!entry) {
      entry = { style: fills[index - 1], edges: [] };
      edgesByFill.set(key, entry);
    }
    entry.edges.push(edge);
  };
  // Morph edges pair up by position in the stream; the end shape has exactly
  // as many, in the same order.
  let edgeIndex = 0;
  const addEdge = (start: Edge): void => {
    const target = ctx.morph?.end[edgeIndex++];
    const edge = target && ctx.morph ? lerpEdge(start, target, ctx.morph.t) : start;
    file(fill1, edge);
    file(fill0, { x0: edge.x1, y0: edge.y1, cx: edge.cx, cy: edge.cy, x1: edge.x0, y1: edge.y0, curved: edge.curved });
  };

  let guard = 0;
  while (!r.atEnd && guard++ < 100000) {
    const isEdge = r.readBit();
    if (!isEdge) {
      const flags = r.readUB(5);
      if (flags === 0) break; // EndShapeRecord

      // Fields appear in this order regardless of which are present.
      if (flags & 0x01) {
        const bits = r.readUB(5);
        x = r.readSB(bits);
        y = r.readSB(bits);
      }
      if (flags & 0x02) fill0 = r.readUB(fillBits);
      if (flags & 0x04) fill1 = r.readUB(fillBits);
      if (flags & 0x08) r.readUB(lineBits);
      if (flags & 0x10 && ctx.allowNewStyles) {
        fills = readFillStyles(r, ctx.withAlpha, ctx.extended);
        skipLineStyles(r, ctx.withAlpha, ctx.extended, ctx.shape4);
        fillBits = r.readUB(4);
        lineBits = r.readUB(4);
        fill0 = 0;
        fill1 = 0;
        tableId += 1;
      }
      continue;
    }

    const isStraight = r.readBit();
    const bits = r.readUB(4) + 2;
    const x0 = x;
    const y0 = y;
    if (isStraight) {
      if (r.readBit()) {
        x += r.readSB(bits);
        y += r.readSB(bits);
      } else if (r.readBit()) {
        y += r.readSB(bits);
      } else {
        x += r.readSB(bits);
      }
      addEdge({ x0, y0, cx: 0, cy: 0, x1: x, y1: y, curved: false });
    } else {
      const cx = x + r.readSB(bits);
      const cy = y + r.readSB(bits);
      x = cx + r.readSB(bits);
      y = cy + r.readSB(bits);
      addEdge({ x0, y0, cx, cy, x1: x, y1: y, curved: true });
    }
  }

  const paths: SubPath[] = [];
  for (const { style, edges } of edgesByFill.values()) {
    if (!style || style.color < 0) continue;
    const commands = chainEdges(edges);
    if (commands.length > 0) paths.push({ color: style.color, alpha: style.alpha, commands });
  }
  return paths;
}

/**
 * Blend one edge between its two morph states. A straight edge paired with a
 * curve is treated as a curve whose control point sits at its midpoint, as the
 * player does.
 */
function lerpEdge(a: Edge, b: Edge, t: number): Edge {
  const mix = (p: number, q: number): number => p + (q - p) * t;
  const curved = a.curved || b.curved;
  const acx = a.curved ? a.cx : (a.x0 + a.x1) / 2;
  const acy = a.curved ? a.cy : (a.y0 + a.y1) / 2;
  const bcx = b.curved ? b.cx : (b.x0 + b.x1) / 2;
  const bcy = b.curved ? b.cy : (b.y0 + b.y1) / 2;
  return {
    x0: mix(a.x0, b.x0),
    y0: mix(a.y0, b.y0),
    cx: curved ? mix(acx, bcx) : 0,
    cy: curved ? mix(acy, bcy) : 0,
    x1: mix(a.x1, b.x1),
    y1: mix(a.y1, b.y1),
    curved,
  };
}

/**
 * The end state of a morph shape: edges only, in the start shape's order.
 * Its style-change records carry at most a move-to.
 */
function readMorphEdges(r: BitReader): Edge[] {
  const fillBits = r.readUB(4);
  const lineBits = r.readUB(4);
  const edges: Edge[] = [];
  let x = 0;
  let y = 0;
  let guard = 0;
  while (!r.atEnd && guard++ < 100000) {
    const isEdge = r.readBit();
    if (!isEdge) {
      const flags = r.readUB(5);
      if (flags === 0) break;
      if (flags & 0x01) {
        const bits = r.readUB(5);
        x = r.readSB(bits);
        y = r.readSB(bits);
      }
      if (flags & 0x02) r.readUB(fillBits);
      if (flags & 0x04) r.readUB(fillBits);
      if (flags & 0x08) r.readUB(lineBits);
      continue;
    }
    const isStraight = r.readBit();
    const bits = r.readUB(4) + 2;
    const x0 = x;
    const y0 = y;
    if (isStraight) {
      if (r.readBit()) {
        x += r.readSB(bits);
        y += r.readSB(bits);
      } else if (r.readBit()) {
        y += r.readSB(bits);
      } else {
        x += r.readSB(bits);
      }
      edges.push({ x0, y0, cx: 0, cy: 0, x1: x, y1: y, curved: false });
    } else {
      const cx = x + r.readSB(bits);
      const cy = y + r.readSB(bits);
      x = cx + r.readSB(bits);
      y = cy + r.readSB(bits);
      edges.push({ x0, y0, cx, cy, x1: x, y1: y, curved: true });
    }
  }
  return edges;
}

/** Join edges end-to-start into closed loops, emitting path commands. */
function chainEdges(edges: Edge[]): PathCommand[] {
  const byStart = new Map<string, Edge[]>();
  const keyOf = (px: number, py: number): string => `${px},${py}`;
  for (const edge of edges) {
    const key = keyOf(edge.x0, edge.y0);
    const list = byStart.get(key);
    if (list) list.push(edge);
    else byStart.set(key, [edge]);
  }

  const used = new Set<Edge>();
  const commands: PathCommand[] = [];
  for (const first of edges) {
    if (used.has(first)) continue;
    used.add(first);
    commands.push({ op: 'M', x: first.x0, y: first.y0 });
    let current = first;
    let guard = 0;
    while (guard++ < edges.length + 1) {
      if (current.curved) {
        commands.push({ op: 'Q', cx: current.cx, cy: current.cy, x: current.x1, y: current.y1 });
      } else {
        commands.push({ op: 'L', x: current.x1, y: current.y1 });
      }
      if (current.x1 === first.x0 && current.y1 === first.y0) break; // loop closed
      const candidates = byStart.get(keyOf(current.x1, current.y1));
      const next = candidates?.find((edge) => !used.has(edge));
      if (!next) break; // open run: the renderer closes it
      used.add(next);
      current = next;
    }
  }
  return commands;
}

function bitmapsOf(fills: FillStyle[]): number[] {
  const out: number[] = [];
  for (const fill of fills) {
    if (fill.bitmap !== undefined && !out.includes(fill.bitmap)) out.push(fill.bitmap);
  }
  return out;
}

/**
 * Decode a shape definition. `ratio` (0..1) only matters for a morph shape and
 * comes from the PlaceObject that shows it.
 */
export function decodeShape(tagCode: number, body: Buffer, ratio = 0): DecodedShape | null {
  if (tagCode === TAG_DEFINE_MORPH_SHAPE) return decodeMorphShape(body, ratio);

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

  const fills = readFillStyles(r, withAlpha, extended);
  skipLineStyles(r, withAlpha, extended, shape4);
  const paths = readShapeRecords(r, fills, { withAlpha, extended, shape4, allowNewStyles: true });
  return { id, bounds, paths, bitmaps: bitmapsOf(fills) };
}

/**
 * DefineMorphShape blended at `t` (0 = start state, 1 = end state). The smoke
 * puffs and the rocket's flame are morphs that a timeline steps through by
 * ratio, so the start state alone would freeze them.
 */
export function decodeMorphShape(body: Buffer, t = 0): DecodedShape | null {
  if (body.length < 3) return null;
  const r = new BitReader(body, 0);
  const id = r.readU16();
  const startBounds = r.readRect();
  const endBounds = r.readRect();
  const endOffset = r.readU32(); // from just after this field to the end edges
  const endEdgesAt = r.offset + endOffset;

  const fills = readMorphFillStyles(r, t);
  skipMorphLineStyles(r);
  const endEdges = t > 0 && endEdgesAt < body.length ? readMorphEdges(new BitReader(body, endEdgesAt)) : [];
  const paths = readShapeRecords(r, fills, {
    withAlpha: true,
    extended: true,
    shape4: false,
    allowNewStyles: false,
    morph: endEdges.length > 0 ? { end: endEdges, t } : undefined,
  });
  const mix = (p: number, q: number): number => p + (q - p) * t;
  const bounds = {
    xMin: mix(startBounds.xMin, endBounds.xMin),
    xMax: mix(startBounds.xMax, endBounds.xMax),
    yMin: mix(startBounds.yMin, endBounds.yMin),
    yMax: mix(startBounds.yMax, endBounds.yMax),
  };
  return { id, bounds, paths, bitmaps: bitmapsOf(fills) };
}
