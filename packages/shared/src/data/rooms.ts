/**
 * Arenas, authored as ASCII so they stay readable and diffable.
 *
 *   #  solid wall      .  floor        S  zombie spawn
 *   1  player 1 start  2  player 2     b  barrel      p  pickup
 *
 * Spawn points sit at the edges so waves arrive from off-camera, and interior
 * cover is arranged to give the player something to kite around -- the pillars
 * matter more than the outline.
 */
import type { RoomDef } from '../map/GameMap.js';

export const ROOMS: RoomDef[] = [
  {
    id: 'ROOM_Single_0001',
    name: 'The Yard',
    floorStyle: 'concrete',
    levelRamp: 1,
    tiles: [
      '####################',
      '#S....b........b..S#',
      '#..................#',
      '#..####......####..#',
      '#..#..........p.#..#',
      '#..#............#..#',
      '#.......1..2.......#',
      '#..#............#..#',
      '#..#.p..........#..#',
      '#..####......####..#',
      '#..................#',
      '#S....b........b..S#',
      '####################',
    ],
  },
  {
    id: 'ROOM_Single_0002',
    name: 'Crossroads',
    floorStyle: 'asphalt',
    levelRamp: 1.1,
    tiles: [
      '########....########',
      '#S.....#....#.....S#',
      '#......#....#......#',
      '#..b...#....#...b..#',
      '#......##..##......#',
      '#..................#',
      '....p....12....p....',
      '#..................#',
      '#......##..##......#',
      '#..b...#....#...b..#',
      '#......#....#......#',
      '#S.....#....#.....S#',
      '########....########',
    ],
  },
  {
    id: 'ROOM_Single_0003',
    name: 'The Pit',
    floorStyle: 'tile',
    levelRamp: 1.25,
    tiles: [
      '####################',
      '#S................S#',
      '#..##..........##..#',
      '#..##....p.....##..#',
      '#..................#',
      '#....#.######.#....#',
      '#..b.#...12...#.b..#',
      '#....#.######.#....#',
      '#..................#',
      '#..##.....p....##..#',
      '#..##..........##..#',
      '#S................S#',
      '####################',
    ],
  },
  {
    id: 'ROOM_Single_0004',
    name: 'Corridors',
    floorStyle: 'concrete',
    levelRamp: 1.35,
    tiles: [
      '####################',
      '#S...#........#...S#',
      '#....#..b..b..#....#',
      '#.##.#.######.#.##.#',
      '#.#..............#.#',
      '#.#..##.12.##..#.#.#',
      '#....#......#......#',
      '#.#..##....##..#.#.#',
      '#.#.....p........#.#',
      '#.##.#.######.#.##.#',
      '#....#..b..b..#....#',
      '#S...#........#...S#',
      '####################',
    ],
  },
];

export function roomById(id: string): RoomDef | undefined {
  return ROOMS.find((room) => room.id === id);
}
