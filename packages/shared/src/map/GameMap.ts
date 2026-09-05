/**
 * The arena grid.
 *
 * Rooms are authored as ASCII so they stay readable and diffable, with no asset
 * pipeline. Static geometry lives here; anything that moves is a Thing.
 */
export const CELL_SIZE = 40;

export const Tile = {
  Floor: 0,
  /** Permanent wall; never destructible. */
  Solid: 1,
  /** Player-placed barricade; zombies will chew through it. */
  Breakable: 2,
} as const;
export type TileType = (typeof Tile)[keyof typeof Tile];

export interface RoomDef {
  id: string;
  name: string;
  /**
   * One string per row. '#' solid, '.' floor, 'S' zombie spawn,
   * '1'/'2' player start, 'b' barrel, 'p' pickup.
   */
  tiles: string[];
  floorStyle?: 'concrete' | 'asphalt' | 'tile';
  /** Scales wave difficulty for smaller or larger arenas. */
  levelRamp?: number;
}

export interface SpawnPoints {
  zombies: Array<{ x: number; y: number }>;
  players: Array<{ x: number; y: number }>;
  barrels: Array<{ x: number; y: number }>;
  pickups: Array<{ x: number; y: number }>;
}

export class GameMap {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  /** One TileType per cell, row-major. */
  readonly tiles: Uint8Array;
  /** Hit points for breakable cells; 0 elsewhere. */
  readonly integrity: Uint16Array;
  readonly spawns: SpawnPoints;
  /** Bumped whenever geometry changes, so navigation knows to rebuild. */
  revision = 0;

  constructor(room: RoomDef) {
    this.rows = room.tiles.length;
    this.cols = room.tiles.reduce((max, row) => Math.max(max, row.length), 0);
    this.width = this.cols * CELL_SIZE;
    this.height = this.rows * CELL_SIZE;
    this.tiles = new Uint8Array(this.cols * this.rows);
    this.integrity = new Uint16Array(this.cols * this.rows);
    this.spawns = { zombies: [], players: [], barrels: [], pickups: [] };

    for (let y = 0; y < this.rows; y++) {
      const row = room.tiles[y] ?? '';
      for (let x = 0; x < this.cols; x++) {
        const char = row[x] ?? '#';
        const index = y * this.cols + x;
        const centre = { x: x * CELL_SIZE + CELL_SIZE / 2, y: y * CELL_SIZE + CELL_SIZE / 2 };
        switch (char) {
          case '#':
            this.tiles[index] = Tile.Solid;
            break;
          case 'S':
            this.spawns.zombies.push(centre);
            break;
          case '1':
          case '2':
            this.spawns.players.push(centre);
            break;
          case 'b':
            this.spawns.barrels.push(centre);
            break;
          case 'p':
            this.spawns.pickups.push(centre);
            break;
          default:
            this.tiles[index] = Tile.Floor;
        }
      }
    }
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

  /** True when the cell blocks movement. */
  isBlocked(cx: number, cy: number): boolean {
    return this.tileAt(cx, cy) !== Tile.Floor;
  }

  blockedAtPoint(x: number, y: number): boolean {
    return this.isBlocked(Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE));
  }

  cellOf(x: number, y: number): { cx: number; cy: number } {
    return { cx: Math.floor(x / CELL_SIZE), cy: Math.floor(y / CELL_SIZE) };
  }

  centreOf(cx: number, cy: number): { x: number; y: number } {
    return { x: cx * CELL_SIZE + CELL_SIZE / 2, y: cy * CELL_SIZE + CELL_SIZE / 2 };
  }

  /** Place a player-built barricade. Returns false if the cell is occupied. */
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
