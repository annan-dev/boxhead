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
import { roomFromAscii, type AsciiRoom } from '../map/GameMap.js';
import type { ExtractedRoom } from '../art/ArtTypes.js';

const FALLBACK: AsciiRoom[] = [
  {
    id: 'ROOM_Single_0001',
    name: 'The Yard',
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

/**
 * Text-authored arenas, used by the tests and by hosts that have no extracted
 * art pack. The real game loads the original 18 rooms from the art pack.
 */
export const ROOMS: ExtractedRoom[] = FALLBACK.map((room, index) => ({
  ...roomFromAscii(room),
  index,
}));

export function roomById(id: string): ExtractedRoom | undefined {
  return ROOMS.find((room) => room.id === id);
}
