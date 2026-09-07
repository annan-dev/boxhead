/**
 * Which arenas the server simulates.
 *
 * Browser clients play the 18 rooms extracted from the original SWF into
 * `assets/art.json`. A server that ran the ASCII fallback rooms instead would
 * be simulating a different map from every client that connects to it, and
 * no client could ever restore its snapshots. So the server loads the same
 * art pack when it can find one, and only falls back to ASCII when it cannot.
 *
 * The server never draws, so the floor art (by far the largest part of a room)
 * is dropped before the rooms are handed out. The collision grid, spawns and
 * blocks are what the simulation reads, and those are kept intact.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOMS } from '@boxhead/shared';
import type { ArtPack, ExtractedRoom } from '@boxhead/shared';

/** Walk up from this module until a directory holding `assets/art.json` appears. */
function findArtPack(): string | null {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'assets', 'art.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function stripArt(room: ExtractedRoom): ExtractedRoom {
  return { ...room, floor: { layers: [] } };
}

export function loadRooms(log: (line: string) => void = console.log): ExtractedRoom[] {
  const path = process.env.BOXHEAD_ART ? resolve(process.env.BOXHEAD_ART) : findArtPack();
  if (path && existsSync(path)) {
    try {
      const pack = JSON.parse(readFileSync(path, 'utf8')) as Partial<ArtPack>;
      if (Array.isArray(pack.rooms) && pack.rooms.length > 0) {
        log(`rooms: ${pack.rooms.length} from ${path}`);
        return pack.rooms.map(stripArt);
      }
      log(`rooms: ${path} has no rooms, using the built-in ASCII set`);
    } catch (error) {
      log(`rooms: could not read ${path} (${(error as Error).message}), using the built-in ASCII set`);
    }
  } else {
    log('rooms: no art pack found, using the built-in ASCII set');
  }
  return ROOMS.map(stripArt);
}
