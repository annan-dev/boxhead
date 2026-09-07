/**
 * Flattens exported MovieClips into per-frame vector art.
 *
 * The world art -- wall blocks, barrels, mines, pickups, explosions, muzzle
 * flashes -- is not in the XSI data block with the characters. It ships as
 * ordinary Flash symbols: a sprite whose timeline places a handful of shapes,
 * one per visible face of a box, which is exactly where the original's chunky
 * 3D look comes from.
 *
 * Reproducing that means running the display list rather than just collecting
 * every PlaceObject in the tag stream: several of these symbols are animated
 * (an 18-frame explosion, a wall with 10 damage states) and merging their
 * frames would draw every state at once.
 */
import {
  BitReader,
  IDENTITY_CXFORM,
  applyCxform,
  composeCxform,
  type ColorTransform,
} from './swf/BitReader.js';
import { decodeShape, TAG_DEFINE_MORPH_SHAPE } from './swf/ShapeDecoder.js';
import { spriteTags, spriteId, TagCode, type SwfTag } from './swf/Reader.js';
import type { SpriteArt, SpriteFrame, TextureLayer } from '@boxhead/shared';

/** DefineShape 1-4 plus DefineMorphShape, blended at the placing tag's ratio. */
const SHAPE_TAGS = new Set([2, 22, 32, 83, TAG_DEFINE_MORPH_SHAPE]);
/** DefineBits, DefineBitsLossless(2), DefineBitsJPEG2/3: indexed so fills resolve. */
const BITMAP_TAGS = new Set([6, 20, 21, 35, 36]);
const PLACE_OBJECT = 4;
const PLACE_OBJECT2 = 26;
const PLACE_OBJECT3 = 70;
const REMOVE_OBJECT = 5;
const REMOVE_OBJECT2 = 28;
const SHOW_FRAME = 1;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Apply `child`, then `parent`. */
function multiply(parent: Matrix, child: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = parent;
  const [a2, b2, c2, d2, e2, f2] = child;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export interface DefinitionTable {
  get(id: number): { code: number; body: Buffer } | undefined;
}

interface Placement {
  characterId: number;
  matrix: Matrix;
  cxform: ColorTransform;
  /** Morph ratio, 0..1. */
  ratio: number;
  /** Instance name, when the timeline gave one. */
  name?: string | undefined;
}

/** The child clip the original's animation primitive steps frame by frame. */
const CONTENTS_NAME = '_Contents';

/**
 * Read the leading fields of a place tag.
 * `character` is undefined for a move that only changes an existing entry.
 */
interface PlaceFields {
  depth: number;
  character?: number;
  matrix?: Matrix;
  cxform?: ColorTransform;
  ratio?: number;
  name?: string;
}

function parsePlace(tag: SwfTag): PlaceFields | null {
  const body = tag.body;
  if (tag.code === PLACE_OBJECT) {
    // The oldest form: character and depth are mandatory and unflagged.
    if (body.length < 4) return null;
    const character = body.readUInt16LE(0);
    const depth = body.readUInt16LE(2);
    const reader = new BitReader(body, 4);
    const matrix = reader.readMatrix();
    const cxform = reader.offset < body.length ? reader.readColorTransform(false) : undefined;
    return cxform ? { depth, character, matrix, cxform } : { depth, character, matrix };
  }
  if (body.length < 3) return null;
  let offset = 0;
  const flags = body[offset]!;
  offset += 1;
  let flags2 = 0;
  if (tag.code === PLACE_OBJECT3) {
    flags2 = body[offset]!;
    offset += 1;
  }
  const depth = body.readUInt16LE(offset);
  offset += 2;

  const result: PlaceFields = { depth };
  if ((flags & 0x02) !== 0) {
    result.character = body.readUInt16LE(offset);
    offset += 2;
  }
  // The colour transform follows the matrix, so both are read from one cursor.
  const reader = new BitReader(body, offset);
  if ((flags & 0x04) !== 0) result.matrix = reader.readMatrix();
  if ((flags & 0x08) !== 0) result.cxform = reader.readColorTransform(true);
  offset = reader.offset;
  if ((flags & 0x10) !== 0 && offset + 2 <= body.length) {
    result.ratio = body.readUInt16LE(offset) / 65535;
    offset += 2;
  }
  // The name follows the ratio in both forms, unless PlaceObject3 put a class
  // name or an image in front, which this file never does.
  const nameReadable = tag.code === PLACE_OBJECT2 || (flags2 & 0x18) === 0;
  if ((flags & 0x20) !== 0 && nameReadable && offset < body.length) {
    const end = body.indexOf(0, offset);
    result.name = body.toString('latin1', offset, end < 0 ? body.length : end);
  }
  return result;
}

/**
 * Resolve a character into transformed subpaths, descending through nested
 * sprites. Nested clips contribute their first frame, which is what these
 * symbols use.
 */
function flatten(
  characterId: number,
  defs: DefinitionTable,
  transform: Matrix,
  cxform: ColorTransform,
  out: TextureLayer[],
  depth = 0,
  ratio = 0,
): void {
  if (depth > 6) return;
  const def = defs.get(characterId);
  if (!def) return;

  if (SHAPE_TAGS.has(def.code)) {
    const shape = decodeShape(def.code, def.body, ratio);
    if (!shape || shape.paths.length === 0) return;
    // Bake the tint into the colours, so the renderer stays a plain fill.
    const paths = shape.paths.map((path) => {
      const tinted = applyCxform(path.color, path.alpha, cxform);
      return { ...path, color: tinted.color, alpha: tinted.alpha };
    });
    out.push({ matrix: transform, paths });
    return;
  }
  if (def.code !== TagCode.DefineSprite) return;

  // A nested clip contributes its first frame under the combined transform.
  const display = firstFrameOf(def.body, defs);
  for (const placement of display) {
    flatten(
      placement.characterId,
      defs,
      multiply(transform, placement.matrix),
      composeCxform(cxform, placement.cxform),
      out,
      depth + 1,
      placement.ratio,
    );
  }
}

/** Apply a place tag to a display list, keeping whatever the tag leaves unsaid. */
function applyPlace(display: Map<number, Placement>, tag: SwfTag): void {
  const place = parsePlace(tag);
  if (!place) return;
  const existing = display.get(place.depth);
  const characterId = place.character ?? existing?.characterId;
  if (characterId === undefined) return;
  // A new character at a depth starts fresh; a move only changes what it names.
  const base = place.character !== undefined && place.character !== existing?.characterId
    ? undefined
    : existing;
  display.set(place.depth, {
    characterId,
    matrix: place.matrix ?? base?.matrix ?? IDENTITY,
    cxform: place.cxform ?? base?.cxform ?? IDENTITY_CXFORM,
    ratio: place.ratio ?? base?.ratio ?? 0,
    name: place.name ?? base?.name,
  });
}

/**
 * Step a sprite's timeline, returning the display list at every ShowFrame,
 * depths low to high.
 */
function stepTimeline(body: Buffer, firstOnly = false): Placement[][] {
  const display = new Map<number, Placement>();
  const frames: Placement[][] = [];
  const snapshot = (): Placement[] =>
    [...display.keys()].sort((a, b) => a - b).map((d) => display.get(d)!);

  for (const tag of spriteTags(body)) {
    if (tag.code === PLACE_OBJECT || tag.code === PLACE_OBJECT2 || tag.code === PLACE_OBJECT3) {
      applyPlace(display, tag);
    } else if (tag.code === REMOVE_OBJECT2 && tag.body.length >= 2) {
      display.delete(tag.body.readUInt16LE(0));
    } else if (tag.code === REMOVE_OBJECT && tag.body.length >= 4) {
      display.delete(tag.body.readUInt16LE(2));
    } else if (tag.code === SHOW_FRAME) {
      frames.push(snapshot());
      if (firstOnly) return frames;
    }
  }
  // A symbol with no ShowFrame still has content worth keeping.
  if (frames.length === 0 && display.size > 0) frames.push(snapshot());
  return frames;
}

/** Display list as it stands on a sprite's first frame. */
function firstFrameOf(body: Buffer, defs: DefinitionTable): Placement[] {
  void defs;
  return stepTimeline(body, true)[0] ?? [];
}

/**
 * Step a sprite's timeline, emitting one entry per ShowFrame.
 * Depths are drawn low to high, matching Flash's display list.
 *
 * The original's animation primitive steps the symbol and a child instance
 * named `_Contents` together, frame for frame. Several effects (the rocket,
 * the fireball, the bullet puff, the smoke cloud) are one-frame wrappers
 * around such a child, so the child's frames are what gets animated.
 */
function runTimeline(body: Buffer, defs: DefinitionTable): SpriteFrame[] {
  const own = stepTimeline(body);
  let contentsFrames: Placement[][] | null = null;
  const contents = own[0]?.find((placement) => placement.name === CONTENTS_NAME);
  if (contents) {
    const child = defs.get(contents.characterId);
    if (child?.code === TagCode.DefineSprite) {
      const stepped = stepTimeline(child.body);
      if (stepped.length > 1) contentsFrames = stepped;
    }
  }

  const total = Math.max(own.length, contentsFrames?.length ?? 0);
  const frames: SpriteFrame[] = [];
  for (let i = 0; i < total; i++) {
    const layers: TextureLayer[] = [];
    const display = own[Math.min(i, own.length - 1)] ?? [];
    for (const placement of display) {
      if (contentsFrames && placement.name === CONTENTS_NAME) {
        const inner = contentsFrames[Math.min(i, contentsFrames.length - 1)] ?? [];
        for (const child of inner) {
          flatten(
            child.characterId,
            defs,
            multiply(placement.matrix, child.matrix),
            composeCxform(placement.cxform, child.cxform),
            layers,
            1,
            child.ratio,
          );
        }
      } else {
        flatten(placement.characterId, defs, placement.matrix, placement.cxform, layers, 0, placement.ratio);
      }
    }
    frames.push({ layers });
  }
  return frames;
}

/** Index every definition in the file, including those nested inside sprites. */
export function indexDefinitions(tags: SwfTag[]): Map<number, { code: number; body: Buffer }> {
  const defs = new Map<number, { code: number; body: Buffer }>();
  const walk = (list: SwfTag[]): void => {
    for (const tag of list) {
      if (tag.code === TagCode.DefineSprite) {
        defs.set(spriteId(tag.body), { code: tag.code, body: tag.body });
        walk(spriteTags(tag.body));
      } else if (SHAPE_TAGS.has(tag.code) && tag.body.length >= 2) {
        defs.set(tag.body.readUInt16LE(0), { code: tag.code, body: tag.body });
      } else if (BITMAP_TAGS.has(tag.code) && tag.body.length >= 2) {
        defs.set(tag.body.readUInt16LE(0), { code: tag.code, body: tag.body });
      }
    }
  };
  walk(tags);
  return defs;
}

function boundsOf(frames: SpriteFrame[]): SpriteArt['bounds'] {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const frame of frames) {
    for (const layer of frame.layers) {
      const [a, b, c, d, e, f] = layer.matrix;
      for (const path of layer.paths) {
        for (const cmd of path.commands) {
          const x = a * cmd.x + c * cmd.y + e;
          const y = b * cmd.x + d * cmd.y + f;
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
      }
    }
  }
  if (!Number.isFinite(xMin)) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  return { xMin, yMin, xMax, yMax };
}

/** Extract one exported symbol as per-frame vector art. */
export function buildSprite(
  name: string,
  characterId: number,
  defs: DefinitionTable,
): SpriteArt | null {
  const def = defs.get(characterId);
  if (!def) return null;

  let frames: SpriteFrame[];
  if (SHAPE_TAGS.has(def.code)) {
    const layers: TextureLayer[] = [];
    flatten(characterId, defs, IDENTITY, IDENTITY_CXFORM, layers);
    frames = [{ layers }];
  } else if (def.code === TagCode.DefineSprite) {
    frames = runTimeline(def.body, defs);
  } else {
    return null;
  }

  const kept = frames.filter((frame) => frame.layers.length > 0);
  if (kept.length === 0) return null;
  return { name, frames: kept, bounds: boundsOf(kept) };
}

/**
 * Bitmap ids painted by a symbol's first frame, nearest the top of the display
 * list first. Used to find which bitmap a level icon or portrait frame shows.
 */
export function bitmapsInFrame(
  characterId: number,
  defs: DefinitionTable,
  depth = 0,
): number[] {
  if (depth > 6) return [];
  const def = defs.get(characterId);
  if (!def) return [];
  if (SHAPE_TAGS.has(def.code)) return decodeShape(def.code, def.body)?.bitmaps ?? [];
  if (def.code !== TagCode.DefineSprite) return [];
  const out: number[] = [];
  for (const placement of firstFrameOf(def.body, defs)) {
    for (const id of bitmapsInFrame(placement.characterId, defs, depth + 1)) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Per-frame bitmap ids for an animated symbol, e.g. one icon per level. */
export function bitmapsPerFrame(body: Buffer, defs: DefinitionTable): number[][] {
  const display = new Map<number, number>();
  const frames: number[][] = [];
  for (const tag of spriteTags(body)) {
    if (tag.code === PLACE_OBJECT || tag.code === PLACE_OBJECT2 || tag.code === PLACE_OBJECT3) {
      const place = parsePlace(tag);
      if (!place) continue;
      const characterId = place.character ?? display.get(place.depth);
      if (characterId !== undefined) display.set(place.depth, characterId);
    } else if (tag.code === REMOVE_OBJECT2 && tag.body.length >= 2) {
      display.delete(tag.body.readUInt16LE(0));
    } else if (tag.code === REMOVE_OBJECT && tag.body.length >= 4) {
      display.delete(tag.body.readUInt16LE(2));
    } else if (tag.code === SHOW_FRAME) {
      const ids: number[] = [];
      for (const characterId of display.values()) {
        for (const id of bitmapsInFrame(characterId, defs)) if (!ids.includes(id)) ids.push(id);
      }
      frames.push(ids);
    }
  }
  return frames;
}

/**
 * A single flattened texture, used for the character face materials where only
 * one frame is ever needed.
 */
export function buildTexture(
  name: string,
  characterId: number,
  defs: DefinitionTable,
): { name: string; bounds: SpriteArt['bounds']; layers: TextureLayer[] } | null {
  const sprite = buildSprite(name, characterId, defs);
  if (!sprite) return null;
  return { name, bounds: sprite.bounds, layers: sprite.frames[0]!.layers };
}
