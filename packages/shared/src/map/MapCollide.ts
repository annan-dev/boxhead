/**
 * Collision against the static grid.
 *
 * Movement resolves one axis at a time, so a creature pressed against a wall
 * keeps its tangential speed instead of sticking. That is the difference
 * between a crowd that flows around a barricade and one that piles onto it.
 */
import { Tile, type GameMap } from './GameMap.js';

export interface MoveResult {
  x: number;
  y: number;
  hitX: boolean;
  hitY: boolean;
}

/** True when a circle overlaps one specific cell's box. */
export function circleOverlapsCell(
  map: GameMap,
  x: number,
  y: number,
  radius: number,
  cx: number,
  cy: number,
): boolean {
  const cell = map.cell;
  // Nearest point on the cell box to the circle centre.
  const left = cx * cell;
  const top = cy * cell;
  const nearestX = Math.max(left, Math.min(x, left + cell));
  const nearestY = Math.max(top, Math.min(y, top + cell));
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

/** True when a circle overlaps any blocked cell. */
export function circleBlocked(map: GameMap, x: number, y: number, radius: number): boolean {
  const cell = map.cell;
  const minX = Math.floor((x - radius) / cell);
  const maxX = Math.floor((x + radius) / cell);
  const minY = Math.floor((y - radius) / cell);
  const maxY = Math.floor((y + radius) / cell);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (!map.isBlocked(cx, cy)) continue;
      if (circleOverlapsCell(map, x, y, radius, cx, cy)) return true;
    }
  }
  return false;
}

/** Move a circle, resolving each axis independently so it slides on contact. */
export function moveCircle(
  map: GameMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
): MoveResult {
  let nextX = x;
  let nextY = y;
  let hitX = false;
  let hitY = false;

  if (dx !== 0) {
    const candidate = nextX + dx;
    if (circleBlocked(map, candidate, nextY, radius)) hitX = true;
    else nextX = candidate;
  }
  if (dy !== 0) {
    const candidate = nextY + dy;
    if (circleBlocked(map, nextX, candidate, radius)) hitY = true;
    else nextY = candidate;
  }

  // Keep bodies inside the arena even if geometry changed under them.
  nextX = Math.max(radius, Math.min(map.width - radius, nextX));
  nextY = Math.max(radius, Math.min(map.height - radius, nextY));
  return { x: nextX, y: nextY, hitX, hitY };
}

export interface RayHit {
  x: number;
  y: number;
  cx: number;
  cy: number;
  distance: number;
}

/**
 * Walk a segment through the grid, stopping at the first blocked cell.
 * Serves both bullet sweeps and line-of-sight tests.
 */
export function raycast(
  map: GameMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): RayHit | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  // Half-cell sampling: accurate enough at 40px cells and considerably cheaper
  // than a full DDA, which matters because every bullet sweeps every tick.
  const steps = Math.ceil(length / (map.cell * 0.5));
  let previousCell = -1;
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const px = x0 + dx * t;
    const py = y0 + dy * t;
    const cx = Math.floor(px / map.cell);
    const cy = Math.floor(py / map.cell);
    const cell = cy * map.cols + cx;
    if (cell === previousCell) continue;
    previousCell = cell;
    if (map.isBlocked(cx, cy)) {
      return { x: px, y: py, cx, cy, distance: length * t };
    }
  }
  return null;
}

/** True when nothing static blocks the straight line between two points. */
export function hasLineOfSight(
  map: GameMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  return raycast(map, x0, y0, x1, y1) === null;
}

/**
 * Sight as the original's creatures have it: only solid map cells block it.
 * Barricades sit on the cell as objects, which the original's line test
 * (`mCollide_NonShootable`, solid cells only) does not count, so a devil can
 * see and fire through a fake wall; the fireball then bursts on it.
 */
export function hasSightThroughObjects(
  map: GameMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length === 0) return true;
  const steps = Math.ceil(length / (map.cell * 0.5));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const cx = Math.floor((x0 + dx * t) / map.cell);
    const cy = Math.floor((y0 + dy * t) / map.cell);
    if (map.tileAt(cx, cy) === Tile.Solid) return false;
  }
  return true;
}
