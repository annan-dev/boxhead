/**
 * Extracts the original arenas.
 *
 * Each ROOM_Single_* symbol is a MovieClip whose timeline places the level: a
 * floor graphic, a set of Piece.* blocks, and World_Init_* markers giving the
 * player start, zombie and devil spawns, barrels, pickups and destructible wall
 * positions. Reading those placements yields the real layouts rather than
 * hand-authored approximations.
 *
 * The blocks carry a pure-blue (#0000ff) region in the source art. That is the
 * author's footprint marker -- the area the block occupies on the ground -- and
 * it is what collision is built from, with the remaining geometry describing
 * how far the block rises off the floor.
 */
import {
  BitReader,
  IDENTITY_CXFORM,
  applyCxform,
  type ColorTransform,
} from './swf/BitReader.js';
import { spriteTags, TagCode, type SwfTag } from './swf/Reader.js';
import { buildSprite, type DefinitionTable } from './SpriteExtractor.js';
import type { ExtractedRoom, RoomBlock, SpriteFrame, TextureLayer } from '@boxhead/shared';

const TWIPS = 20;
/** Collision grid size. Every piece in the original sits on a 32px lattice. */
export const ROOM_CELL = 32;
/** The footprint marker colour used throughout the source art. */
const FOOTPRINT_COLOR = 0x0000ff;

const PLACE_OBJECT = 4;
const PLACE_OBJECT2 = 26;
const PLACE_OBJECT3 = 70;

type Matrix = [number, number, number, number, number, number];

interface Placement {
  name: string;
  characterId: number;
  matrix: Matrix;
  cxform: ColorTransform;
  depth: number;
}

function readPlacements(body: Buffer, nameOf: (id: number) => string): Placement[] {
  const out: Placement[] = [];
  for (const tag of spriteTags(body)) {
    if (tag.code !== PLACE_OBJECT && tag.code !== PLACE_OBJECT2 && tag.code !== PLACE_OBJECT3) {
      continue;
    }
    const b = tag.body;
    let off = 0;
    let characterId: number;
    let depth: number;
    let matrix: Matrix = [1, 0, 0, 1, 0, 0];

    let cxform: ColorTransform = IDENTITY_CXFORM;
    if (tag.code === PLACE_OBJECT) {
      if (b.length < 4) continue;
      characterId = b.readUInt16LE(0);
      depth = b.readUInt16LE(2);
      const reader = new BitReader(b, 4);
      matrix = reader.readMatrix();
      if (reader.offset < b.length) cxform = reader.readColorTransform(false);
    } else {
      if (b.length < 3) continue;
      const flags = b[off]!;
      off += 1;
      if (tag.code === PLACE_OBJECT3) off += 1;
      depth = b.readUInt16LE(off);
      off += 2;
      if ((flags & 0x02) === 0) continue;
      characterId = b.readUInt16LE(off);
      off += 2;
      const reader = new BitReader(b, off);
      if ((flags & 0x04) !== 0) matrix = reader.readMatrix();
      if ((flags & 0x08) !== 0) cxform = reader.readColorTransform(true);
    }
    out.push({ name: nameOf(characterId), characterId, matrix, cxform, depth });
  }
  return out;
}

interface Rect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** Bounds of a symbol's footprint marker, in its own coordinates (twips). */
function footprintOf(
  characterId: number,
  defs: DefinitionTable,
  cache: Map<number, Rect | null>,
): Rect | null {
  const cached = cache.get(characterId);
  if (cached !== undefined) return cached;

  const art = buildSprite(`_${characterId}`, characterId, defs);
  let result: Rect | null = null;
  if (art) {
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    for (const frame of art.frames) {
      for (const layer of frame.layers) {
        const [a, b, c, d, e, f] = layer.matrix;
        for (const path of layer.paths) {
          if (path.color !== FOOTPRINT_COLOR) continue;
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
    // No marker means the whole symbol is its own footprint.
    result = Number.isFinite(xMin)
      ? { xMin, yMin, xMax, yMax }
      : { xMin: art.bounds.xMin, yMin: art.bounds.yMin, xMax: art.bounds.xMax, yMax: art.bounds.yMax };
  }
  cache.set(characterId, result);
  return result;
}

/** How far a symbol rises above its footprint, in twips. */
function riseOf(
  characterId: number,
  defs: DefinitionTable,
  footprint: Rect,
  cache: Map<number, number>,
): number {
  const cached = cache.get(characterId);
  if (cached !== undefined) return cached;
  const art = buildSprite(`_${characterId}`, characterId, defs);
  // Art extending above the footprint is the block's height; a flat marker gets
  // a default so it still reads as a solid block rather than a painted square.
  const rise = art ? Math.max(0, footprint.yMin - art.bounds.yMin) : 0;
  const result = rise > 4 * TWIPS ? rise : 26 * TWIPS;
  cache.set(characterId, result);
  return result;
}

function transformRect(rect: Rect, m: Matrix): Rect {
  const corners = [
    [rect.xMin, rect.yMin],
    [rect.xMax, rect.yMin],
    [rect.xMin, rect.yMax],
    [rect.xMax, rect.yMax],
  ];
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const [cx, cy] of corners) {
    const x = m[0] * cx! + m[2] * cy! + m[4];
    const y = m[1] * cx! + m[3] * cy! + m[5];
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  return { xMin, yMin, xMax, yMax };
}

export interface RoomExtractOptions {
  id: string;
  index: number;
  name: string;
  characterId: number;
  defs: DefinitionTable;
  nameOf: (id: number) => string;
}

export function extractRoom(options: RoomExtractOptions): ExtractedRoom | null {
  const { id, index, name, characterId, defs, nameOf } = options;
  const def = defs.get(characterId);
  if (!def || def.code !== TagCode.DefineSprite) return null;

  const placements = readPlacements(def.body, nameOf);
  if (placements.length === 0) return null;

  const footprintCache = new Map<number, Rect | null>();
  const riseCache = new Map<number, number>();

  const blocks: Array<RoomBlock & { rect: Rect }> = [];
  const spawns = {
    players: [] as Array<{ x: number; y: number }>,
    zombies: [] as Array<{ x: number; y: number }>,
    devils: [] as Array<{ x: number; y: number }>,
    barrels: [] as Array<{ x: number; y: number }>,
    pickups: [] as Array<{ x: number; y: number }>,
    walls: [] as Array<{ x: number; y: number }>,
  };
  const floorLayers: TextureLayer[] = [];

  for (const placement of placements) {
    const marker = /^World_Init_(\w+)$/.exec(placement.name);
    if (marker) {
      // Markers are invisible in play; only their position matters.
      const point = { x: placement.matrix[4] / TWIPS, y: placement.matrix[5] / TWIPS };
      switch (marker[1]) {
        case 'Player1':
        case 'Player2':
          spawns.players.push(point);
          break;
        case 'Zombie':
          spawns.zombies.push(point);
          break;
        case 'Devil':
          spawns.devils.push(point);
          break;
        case 'Barrel':
          spawns.barrels.push(point);
          break;
        case 'Pickup':
          spawns.pickups.push(point);
          break;
        case 'Wall':
          spawns.walls.push(point);
          break;
        default:
          break;
      }
      continue;
    }

    if (placement.name.startsWith('Piece.')) {
      const footprint = footprintOf(placement.characterId, defs, footprintCache);
      if (!footprint) continue;
      const rect = transformRect(footprint, placement.matrix);
      const rise = riseOf(placement.characterId, defs, footprint, riseCache);
      blocks.push({
        symbol: placement.name,
        x: rect.xMin / TWIPS,
        y: rect.yMin / TWIPS,
        w: (rect.xMax - rect.xMin) / TWIPS,
        h: (rect.yMax - rect.yMin) / TWIPS,
        rise: (rise * Math.abs(placement.matrix[3])) / TWIPS,
        rect,
      });
      continue;
    }

    // Anything else is scenery: the floor plate and its decoration.
    const art = buildSprite(placement.name, placement.characterId, defs);
    const frame = art?.frames[0];
    if (!frame) continue;
    for (const layer of frame.layers) {
      const [a1, b1, c1, d1, e1, f1] = placement.matrix;
      const [a2, b2, c2, d2, e2, f2] = layer.matrix;
      // The room tints its own scenery, so fold that in as well.
      const paths = layer.paths.map((path) => {
        const tinted = applyCxform(path.color, path.alpha, placement.cxform);
        return { ...path, color: tinted.color, alpha: tinted.alpha };
      });
      floorLayers.push({
        matrix: [
          a1 * a2 + c1 * b2,
          b1 * a2 + d1 * b2,
          a1 * c2 + c1 * d2,
          b1 * c2 + d1 * d2,
          a1 * e2 + c1 * f2 + e1,
          b1 * e2 + d1 * f2 + f1,
        ],
        paths,
      });
    }
  }

  // Normalise so the arena starts at the origin, whatever the authoring offsets.
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  const consider = (x: number, y: number): void => {
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  };
  for (const block of blocks) {
    consider(block.x, block.y);
    consider(block.x + block.w, block.y + block.h);
  }
  for (const list of Object.values(spawns)) {
    for (const point of list) consider(point.x, point.y);
  }
  for (const layer of floorLayers) {
    const [a, b, c, d, e, f] = layer.matrix;
    for (const path of layer.paths) {
      for (const cmd of path.commands) {
        consider((a * cmd.x + c * cmd.y + e) / TWIPS, (b * cmd.x + d * cmd.y + f) / TWIPS);
      }
    }
  }
  if (!Number.isFinite(xMin)) return null;

  // A margin keeps geometry off the very edge of the collision grid.
  const margin = ROOM_CELL;
  const offsetX = -xMin + margin;
  const offsetY = -yMin + margin;
  const width = Math.ceil((xMax - xMin + margin * 2) / ROOM_CELL) * ROOM_CELL;
  const height = Math.ceil((yMax - yMin + margin * 2) / ROOM_CELL) * ROOM_CELL;
  const cols = width / ROOM_CELL;
  const rows = height / ROOM_CELL;

  for (const block of blocks) {
    block.x += offsetX;
    block.y += offsetY;
  }
  for (const list of Object.values(spawns)) {
    for (const point of list) {
      point.x += offsetX;
      point.y += offsetY;
    }
  }
  const shift: TextureLayer[] = floorLayers.map((layer) => ({
    paths: layer.paths,
    matrix: [
      layer.matrix[0],
      layer.matrix[1],
      layer.matrix[2],
      layer.matrix[3],
      layer.matrix[4] + offsetX * TWIPS,
      layer.matrix[5] + offsetY * TWIPS,
    ],
  }));

  // Rasterise the footprints into the collision grid.
  const tiles = new Array<number>(cols * rows).fill(0);
  for (const block of blocks) {
    const cx0 = Math.max(0, Math.floor(block.x / ROOM_CELL));
    const cy0 = Math.max(0, Math.floor(block.y / ROOM_CELL));
    const cx1 = Math.min(cols - 1, Math.ceil((block.x + block.w) / ROOM_CELL) - 1);
    const cy1 = Math.min(rows - 1, Math.ceil((block.y + block.h) / ROOM_CELL) - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) tiles[cy * cols + cx] = 1;
    }
  }

  const floor: SpriteFrame = { layers: shift };
  return {
    id,
    index,
    name,
    cell: ROOM_CELL,
    width,
    height,
    cols,
    rows,
    tiles,
    blocks: blocks.map(({ rect: _rect, ...block }) => block),
    floor,
    spawns,
  };
}

/** Every ROOM_Single_* symbol in the file, in order. */
export function extractRooms(
  exportsById: Map<number, string>,
  defs: DefinitionTable,
): ExtractedRoom[] {
  const nameOf = (id: number): string => exportsById.get(id) ?? `id_${id}`;
  const entries = [...exportsById]
    .filter(([, name]) => /^ROOM_Single_\d+$/.test(name))
    .sort((a, b) => a[1].localeCompare(b[1]));

  const rooms: ExtractedRoom[] = [];
  for (const [characterId, symbol] of entries) {
    const index = rooms.length;
    const room = extractRoom({
      id: symbol,
      index,
      name: `Room ${index + 1}`,
      characterId,
      defs,
      nameOf,
    });
    if (room) rooms.push(room);
  }
  return rooms;
}

export type { SwfTag };
