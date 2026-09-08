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

/** How tall a player-built barricade stands, in world pixels: one cube's worth. */
export const FAKE_WALL_HEIGHT = 26;

export const Tile = {
  Floor: 0,
  /** Permanent geometry from the room layout. */
  Solid: 1,
  /** Player-placed barricade; solid until shot or blasted down. */
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
  /**
   * Cells holding a solid object (a barrel), which navigation must route
   * around exactly as the original's `mCollide_Object` flag made it do.
   * Movement collision does not read this; barrels push bodies themselves.
   */
  readonly occupied: Uint8Array;
  readonly spawns: SpawnPoints;
  /** Solid blocks with their heights, for drawing the arena in 3D. */
  readonly blocks: readonly RoomBlock[];
  /**
   * How tall each solid cell stands: the rise of the block on it, or
   * Infinity for a solid cell no block covers (the arena's edge), which a
   * lobbed grenade can never clear.
   */
  private readonly heights: Float32Array;
  /** The arena's ground art, already positioned in world space. */
  readonly floorLayers: readonly TextureLayer[];
  /** Bumped whenever geometry changes, so navigation knows to rebuild. */
  revision = 0;
  /**
   * Bumped whenever a breakable cell takes damage as well as when geometry
   * changes; a sender uses it to know whether a receiver's tile arrays are
   * stale without triggering navigation rebuilds on every chew.
   */
  integrityRevision = 0;

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
    this.occupied = new Uint8Array(this.cols * this.rows);
    this.blocks = room.blocks;
    this.heights = new Float32Array(this.cols * this.rows).fill(Infinity);
    for (const block of room.blocks) {
      const x0 = Math.max(0, Math.floor((block.x + 4) / this.cell));
      const y0 = Math.max(0, Math.floor((block.y + 4) / this.cell));
      const x1 = Math.min(this.cols - 1, Math.floor((block.x + block.w - 4) / this.cell));
      const y1 = Math.min(this.rows - 1, Math.floor((block.y + block.h - 4) / this.cell));
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const i = cy * this.cols + cx;
          this.heights[i] = Number.isFinite(this.heights[i]!) ? Math.max(this.heights[i]!, block.rise) : block.rise;
        }
      }
    }
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

  /** True when a creature may path through the cell: open floor with no object on it. */
  passable(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    const index = cy * this.cols + cx;
    return this.tiles[index] === Tile.Floor && this.occupied[index] === 0;
  }

  /** Mark or clear an object on a cell; navigation rebuilds on the change. */
  setOccupied(cx: number, cy: number, on: boolean): void {
    if (!this.inBounds(cx, cy)) return;
    const index = cy * this.cols + cx;
    const value = on ? 1 : 0;
    if (this.occupied[index] === value) return;
    this.occupied[index] = value;
    this.revision += 1;
  }

  isBlocked(cx: number, cy: number): boolean {
    return this.tileAt(cx, cy) !== Tile.Floor;
  }

  /**
   * Height of what stands on a cell, for things that fly: 0 on open floor,
   * a block's rise, a barricade's height, Infinity beyond the arena.
   */
  obstacleHeight(cx: number, cy: number): number {
    const tile = this.tileAt(cx, cy);
    if (tile === Tile.Floor) return 0;
    if (tile === Tile.Breakable) return FAKE_WALL_HEIGHT;
    if (!this.inBounds(cx, cy)) return Infinity;
    return this.heights[cy * this.cols + cx]!;
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
    this.integrityRevision += 1;
    return true;
  }

  /** Apply damage to a breakable cell; returns true when it is destroyed. */
  damageWall(cx: number, cy: number, amount: number): boolean {
    if (this.tileAt(cx, cy) !== Tile.Breakable) return false;
    const index = this.index(cx, cy);
    const remaining = (this.integrity[index] ?? 0) - amount;
    this.integrityRevision += 1;
    if (remaining > 0) {
      this.integrity[index] = remaining;
      return false;
    }
    this.tiles[index] = Tile.Floor;
    this.integrity[index] = 0;
    this.revision += 1;
    return true;
  }

  /**
   * Identity of the arena as loaded, before any play. Two hosts whose maps
   * hash alike can exchange snapshots; the check catches a client and server
   * built from different art packs before a restore fails on a size mismatch.
   */
  layoutHash(): number {
    let hash = 0x811c9dc5;
    const mix = (value: number): void => {
      hash ^= value | 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    };
    mix(this.cols);
    mix(this.rows);
    mix(this.cell);
    for (const tile of this.tiles) mix(tile === Tile.Breakable ? Tile.Floor : tile);
    for (const list of [this.spawns.players, this.spawns.zombies, this.spawns.devils, this.spawns.barrels, this.spawns.pickups, this.spawns.walls]) {
      mix(list.length);
      for (const spot of list) {
        mix(Math.round(spot.x));
        mix(Math.round(spot.y));
      }
    }
    return hash >>> 0;
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
    floorBounds: { x: 0, y: 0, w: cols * cell, h: rows * cell },
    spawns,
  };
}
