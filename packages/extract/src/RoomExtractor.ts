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

export function readPlacements(body: Buffer, nameOf: (id: number) => string): Placement[] {
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

type Polygon = Array<[number, number]>;

/** A path's outline in world pixels; curve control points are dropped. */
function polygonOf(layer: TextureLayer, path: TextureLayer['paths'][number]): Polygon {
  const [a, b, c, d, e, f] = layer.matrix;
  const poly: Polygon = [];
  for (const cmd of path.commands) {
    poly.push([(a * cmd.x + c * cmd.y + e) / TWIPS, (b * cmd.x + d * cmd.y + f) / TWIPS]);
  }
  return poly;
}

function polygonArea(poly: Polygon): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

export function pointInPolygon(x: number, y: number, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The ground the arena is painted on: the largest scenery path, plus every
 * other path in the same colour, so a floor built from several plates is
 * walkable across all of them.
 */
export function floorPlates(layers: TextureLayer[]): Polygon[] {
  let best: { color: number; area: number } | null = null;
  const candidates: Array<{ color: number; poly: Polygon }> = [];
  for (const layer of layers) {
    for (const path of layer.paths) {
      const poly = polygonOf(layer, path);
      if (poly.length < 3) continue;
      const area = polygonArea(poly);
      candidates.push({ color: path.color, poly });
      if (!best || area > best.area) best = { color: path.color, area };
    }
  }
  if (!best) return [];
  const color = best.color;
  return candidates.filter((c) => c.color === color).map((c) => c.poly);
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
  let offsetX = -xMin + margin;
  let offsetY = -yMin + margin;

  // The wall blocks were laid out on the cell grid; the painted floor and the
  // markers were not, so normalising to their extent leaves the blocks a
  // fraction of a cell off. A block straddling cells claims all of them, which
  // fattens every wall and closes one-cell gaps. Shift the arena so the blocks
  // land back on the grid: take the offset most blocks share.
  const snap = (values: number[]): number => {
    if (values.length === 0) return 0;
    const residues = values.map((v) => ((v % ROOM_CELL) + ROOM_CELL) % ROOM_CELL).sort((a, b) => a - b);
    const median = residues[Math.floor(residues.length / 2)]!;
    // Nudge forward onto the grid, never back into the margin.
    return (ROOM_CELL - median) % ROOM_CELL;
  };
  const snapX = snap(blocks.map((block) => block.x + offsetX));
  const snapY = snap(blocks.map((block) => block.y + offsetY));
  if (snapX < ROOM_CELL - 0.5) offsetX += snapX;
  if (snapY < ROOM_CELL - 0.5) offsetY += snapY;

  const width = Math.ceil((xMax + offsetX + margin) / ROOM_CELL) * ROOM_CELL;
  const height = Math.ceil((yMax + offsetY + margin) / ROOM_CELL) * ROOM_CELL;
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

  // Rasterise the footprints into the collision grid. The floor plate is the
  // arena's real edge: the original keeps bodies on the painted ground, so any
  // cell whose centre lies off the plate is solid, invisibly.
  const tiles = new Array<number>(cols * rows).fill(0);
  const plates = floorPlates(shift);
  if (plates.length > 0) {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = cx * ROOM_CELL + ROOM_CELL / 2;
        const y = cy * ROOM_CELL + ROOM_CELL / 2;
        if (!plates.some((poly) => pointInPolygon(x, y, poly))) tiles[cy * cols + cx] = 1;
      }
    }
  }
  for (const block of blocks) {
    // A few pixels of slack: sizes come out of the art at 63.999, and a handful
    // of pieces were authored a few pixels off the grid. A sliver of overlap
    // must not claim a whole cell.
    const slack = 6;
    const cx0 = Math.max(0, Math.floor((block.x + slack) / ROOM_CELL));
    const cy0 = Math.max(0, Math.floor((block.y + slack) / ROOM_CELL));
    const cx1 = Math.min(cols - 1, Math.ceil((block.x + block.w - slack) / ROOM_CELL) - 1);
    const cy1 = Math.min(rows - 1, Math.ceil((block.y + block.h - slack) / ROOM_CELL) - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) tiles[cy * cols + cx] = 1;
    }
  }
  // A marker must always sit on walkable ground, whatever the art or a
  // block's footprint says: the original spawns there regardless, and a
  // start point inside a wall would trap the player.
  for (const list of Object.values(spawns)) {
    for (const point of list) {
      const cx = Math.floor(point.x / ROOM_CELL);
      const cy = Math.floor(point.y / ROOM_CELL);
      if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) tiles[cy * cols + cx] = 0;
    }
  }

  // The painted floor's extent; the camera is held inside it.
  let floorBounds = { x: 0, y: 0, w: width, h: height };
  if (plates.length > 0) {
    let fx0 = Infinity;
    let fy0 = Infinity;
    let fx1 = -Infinity;
    let fy1 = -Infinity;
    for (const poly of plates) {
      for (const [px, py] of poly) {
        if (px < fx0) fx0 = px;
        if (px > fx1) fx1 = px;
        if (py < fy0) fy0 = py;
        if (py > fy1) fy1 = py;
      }
    }
    floorBounds = { x: fx0, y: fy0, w: fx1 - fx0, h: fy1 - fy0 };

    // The original's map is the room's area divided into cells, and
    // `CMap.InitCells` flags the outermost ring of those cells solid
    // (`mCollide_EdgeOfMap | mCollide_Solid`). Several rooms put spawn markers
    // in that ring, behind a line of prebuilt walls: the zombies spawn in the
    // border and the wall is the last walkable square, exactly as the
    // original plays it. The room's origin is the SWF's (0,0), which the
    // offsets above moved onto the grid; its extent is the painted floor.
    const originCx = Math.round(offsetX / ROOM_CELL);
    const originCy = Math.round(offsetY / ROOM_CELL);
    const areaCols = Math.round((fx1 - offsetX) / ROOM_CELL);
    const areaRows = Math.round((fy1 - offsetY) / ROOM_CELL);
    for (let cy = 0; cy < areaRows; cy++) {
      for (let cx = 0; cx < areaCols; cx++) {
        if (cx !== 0 && cy !== 0 && cx !== areaCols - 1 && cy !== areaRows - 1) continue;
        const tx = originCx + cx;
        const ty = originCy + cy;
        if (tx >= 0 && ty >= 0 && tx < cols && ty < rows) tiles[ty * cols + tx] = 1;
      }
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
    floorBounds,
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
