/**
 * The arena grid.
 *
 * Levels come from the original game: each ROOM_Single_* symbol is a MovieClip
 * placing solid blocks and spawn markers, and the extractor rasterises those
 * placements into the tile grid used here. `roomFromAscii` builds the same
 * structure from a text layout, which is what the tests and the server use when
 * no art pack is present.
 */
import type { ExtractedRoom, RoomBlock, TextureLayer } from '../art/ArtTypes.js';

/** Default collision cell; the original places everything on a 32px lattice. */
export const CELL_SIZE = 32;

export const Tile = {
  Floor: 0,
  /** Permanent geometry from the room layout. */
  Solid: 1,
  /** Player-placed barricade; zombies will chew through it. */
  Breakable: 2,
} as const;
export type TileType = (typeof Tile)[keyof typeof Tile];

export interface SpawnPoints {
  zombies: Array<{ x: number; y: number }>;
  devils: Array<{ x: number; y: number }>;
  players: Array<{ x: number; y: number }>;
  barrels: Array<{ x: number; y: number }>;
  pickups: Array<{ x: number; y: number }>;
  walls: Array<{ x: number; y: number }>;
}

export class GameMap {
  readonly id: string;
  readonly name: string;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly tiles: Uint8Array;
  /** Hit points for breakable cells; 0 elsewhere. */
  readonly integrity: Uint16Array;
  readonly spawns: SpawnPoints;
  /** Solid blocks with their heights, for drawing the arena in 3D. */
  readonly blocks: readonly RoomBlock[];
  /** The arena's ground art, already positioned in world space. */
  readonly floorLayers: readonly TextureLayer[];
  /** Bumped whenever geometry changes, so navigation knows to rebuild. */
  revision = 0;

  constructor(room: ExtractedRoom) {
    this.id = room.id;
    this.name = room.name;
    this.cell = room.cell;
    this.cols = room.cols;
    this.rows = room.rows;
    this.width = room.width;
    this.height = room.height;
    this.tiles = Uint8Array.from(room.tiles);
    this.integrity = new Uint16Array(this.cols * this.rows);
    this.blocks = room.blocks;
    this.floorLayers = room.floor.layers;
    this.spawns = {
      zombies: room.spawns.zombies.map((p) => ({ ...p })),
      devils: room.spawns.devils.map((p) => ({ ...p })),
      players: room.spawns.players.map((p) => ({ ...p })),
      barrels: room.spawns.barrels.map((p) => ({ ...p })),
      pickups: room.spawns.pickups.map((p) => ({ ...p })),
      walls: room.spawns.walls.map((p) => ({ ...p })),
    };
  }

  index(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  tileAt(cx: number, cy: number): TileType {
    if (!this.inBounds(cx, cy)) return Tile.Solid;
    return this.tiles[cy * this.cols + cx] as TileType;
  }

  isBlocked(cx: number, cy: number): boolean {
    return this.tileAt(cx, cy) !== Tile.Floor;
  }

  blockedAtPoint(x: number, y: number): boolean {
    return this.isBlocked(Math.floor(x / this.cell), Math.floor(y / this.cell));
  }

  cellOf(x: number, y: number): { cx: number; cy: number } {
    return { cx: Math.floor(x / this.cell), cy: Math.floor(y / this.cell) };
  }

  centreOf(cx: number, cy: number): { x: number; y: number } {
    return { x: cx * this.cell + this.cell / 2, y: cy * this.cell + this.cell / 2 };
  }

  /** Place a barricade. Returns false when the cell is already occupied. */
  buildWall(cx: number, cy: number, hp: number): boolean {
    if (!this.inBounds(cx, cy) || this.tileAt(cx, cy) !== Tile.Floor) return false;
    this.tiles[this.index(cx, cy)] = Tile.Breakable;
    this.integrity[this.index(cx, cy)] = hp;
    this.revision += 1;
    return true;
  }

  /** Apply damage to a breakable cell; returns true when it is destroyed. */
  damageWall(cx: number, cy: number, amount: number): boolean {
    if (this.tileAt(cx, cy) !== Tile.Breakable) return false;
    const index = this.index(cx, cy);
    const remaining = (this.integrity[index] ?? 0) - amount;
    if (remaining > 0) {
      this.integrity[index] = remaining;
      return false;
    }
    this.tiles[index] = Tile.Floor;
    this.integrity[index] = 0;
    this.revision += 1;
    return true;
  }
}

/**
 * A text-authored arena, for tests and for hosts without the extracted art.
 *
 *   #  solid   .  floor   S  zombie spawn   D  devil spawn
 *   1  player start       b  barrel         p  pickup
 */
export interface AsciiRoom {
  id: string;
  name: string;
  tiles: string[];
  cell?: number;
}

export function roomFromAscii(room: AsciiRoom): ExtractedRoom {
  const cell = room.cell ?? CELL_SIZE;
  const rows = room.tiles.length;
  const cols = room.tiles.reduce((max, row) => Math.max(max, row.length), 0);
  const tiles = new Array<number>(cols * rows).fill(0);
  const spawns: ExtractedRoom['spawns'] = {
    players: [],
    zombies: [],
    devils: [],
    barrels: [],
    pickups: [],
    walls: [],
  };
  const blocks: RoomBlock[] = [];

  for (let y = 0; y < rows; y++) {
    const line = room.tiles[y] ?? '';
    for (let x = 0; x < cols; x++) {
      const char = line[x] ?? '#';
      const centre = { x: x * cell + cell / 2, y: y * cell + cell / 2 };
      if (char === '#') {
        tiles[y * cols + x] = 1;
        blocks.push({ symbol: 'Piece.Cube1', x: x * cell, y: y * cell, w: cell, h: cell, rise: 26 });
      } else if (char === 'S') spawns.zombies.push(centre);
      else if (char === 'D') spawns.devils.push(centre);
      else if (char === '1' || char === '2') spawns.players.push(centre);
      else if (char === 'b') spawns.barrels.push(centre);
      else if (char === 'p') spawns.pickups.push(centre);
    }
  }

  return {
    id: room.id,
    index: 0,
    name: room.name,
    cell,
    width: cols * cell,
    height: rows * cell,
    cols,
    rows,
    tiles,
    blocks,
    floor: { layers: [] },
    spawns,
  };
}
