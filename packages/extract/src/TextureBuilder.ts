/**
 * Builds the textures used for a character's box faces.
 *
 * Materials such as `Head_Front` are not flat colours: they reference an
 * exported MovieClip (`Head_Front_MC`) holding the printed detail -- the face,
 * the jacket front, the hair. Each of those clips places one or more shapes,
 * sometimes via a nested clip, so this flattens the placement tree into a list
 * of transformed subpaths.
 */
import { BitReader } from './swf/BitReader.js';
import { decodeShape } from './swf/ShapeDecoder.js';
import { spriteTags, spriteId, TagCode, type SwfTag } from './swf/Reader.js';
import type { Texture, TextureLayer } from '@boxhead/shared';

const SHAPE_TAGS = new Set([2, 22, 32, 83]);
const PLACE_OBJECT2 = 26;
const PLACE_OBJECT3 = 70;

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Standard 2D affine composition: apply `child`, then `parent`. */
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

interface Placement {
  characterId: number;
  matrix: Matrix;
  depth: number;
}

/** Parse the fields of PlaceObject2/3 that matter here. */
function parsePlacement(tag: SwfTag): Placement | null {
  const body = tag.body;
  if (body.length < 3) return null;
  let offset = 0;
  const flags = body[offset]!;
  offset += 1;
  if (tag.code === PLACE_OBJECT3) offset += 1; // second flags byte
  const depth = body.readUInt16LE(offset);
  offset += 2;

  const hasCharacter = (flags & 0x02) !== 0;
  const hasMatrix = (flags & 0x04) !== 0;
  if (!hasCharacter) return null;

  const characterId = body.readUInt16LE(offset);
  offset += 2;

  let matrix: Matrix = IDENTITY;
  if (hasMatrix) {
    const reader = new BitReader(body, offset);
    matrix = reader.readMatrix();
  }
  return { characterId, matrix, depth };
}

export interface DefinitionTable {
  get(id: number): { code: number; body: Buffer } | undefined;
}

/**
 * Flatten one clip into transformed subpaths, following nested placements.
 * `depth` guards against a malformed file describing a placement cycle.
 */
function collectLayers(
  characterId: number,
  defs: DefinitionTable,
  transform: Matrix,
  out: TextureLayer[],
  depth = 0,
): void {
  if (depth > 6) return;
  const def = defs.get(characterId);
  if (!def) return;

  if (SHAPE_TAGS.has(def.code)) {
    const shape = decodeShape(def.code, def.body);
    if (shape && shape.paths.length > 0) {
      out.push({ matrix: transform, paths: shape.paths });
    }
    return;
  }

  if (def.code !== TagCode.DefineSprite) return;

  const placements: Placement[] = [];
  for (const inner of spriteTags(def.body)) {
    if (inner.code !== PLACE_OBJECT2 && inner.code !== PLACE_OBJECT3) continue;
    const placement = parsePlacement(inner);
    if (placement) placements.push(placement);
  }
  // Lower depths draw first, matching Flash's display list.
  placements.sort((a, b) => a.depth - b.depth);
  for (const placement of placements) {
    collectLayers(placement.characterId, defs, multiply(transform, placement.matrix), out, depth + 1);
  }
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
      }
    }
  };
  walk(tags);
  return defs;
}

export function buildTexture(
  name: string,
  characterId: number,
  defs: DefinitionTable,
): Texture | null {
  const layers: TextureLayer[] = [];
  collectLayers(characterId, defs, IDENTITY, layers);
  if (layers.length === 0) return null;

  // Bounds over every transformed anchor point, used to normalise the texture
  // into the unit square the face quad expects.
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const layer of layers) {
    const [a, b, c, d, e, f] = layer.matrix;
    for (const path of layer.paths) {
      for (const cmd of path.commands) {
        const px = a * cmd.x + c * cmd.y + e;
        const py = b * cmd.x + d * cmd.y + f;
        if (px < xMin) xMin = px;
        if (px > xMax) xMax = px;
        if (py < yMin) yMin = py;
        if (py > yMax) yMax = py;
      }
    }
  }
  if (!Number.isFinite(xMin)) return null;

  return { name, bounds: { xMin, yMin, xMax, yMax }, layers };
}
