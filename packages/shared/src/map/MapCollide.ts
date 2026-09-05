/**
 * Collision against the static grid.
 *
 * Movement resolves one axis at a time, so a creature pressed against a wall
 * keeps its tangential speed instead of sticking. That is the difference
 * between a crowd that flows around a barricade and one that piles onto it.
 */
import { CELL_SIZE, GameMap } from './GameMap.js';

export interface MoveResult {
  x: number;
  y: number;
  hitX: boolean;
  hitY: boolean;
}

/** True when a circle overlaps any blocked cell. */
export function circleBlocked(map: GameMap, x: number, y: number, radius: number): boolean {
  const minX = Math.floor((x - radius) / CELL_SIZE);
  const maxX = Math.floor((x + radius) / CELL_SIZE);
  const minY = Math.floor((y - radius) / CELL_SIZE);
  const maxY = Math.floor((y + radius) / CELL_SIZE);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (!map.isBlocked(cx, cy)) continue;
      // Nearest point on the cell box to the circle centre.
      const left = cx * CELL_SIZE;
      const top = cy * CELL_SIZE;
      const nearestX = Math.max(left, Math.min(x, left + CELL_SIZE));
      const nearestY = Math.max(top, Math.min(y, top + CELL_SIZE));
      const dx = x - nearestX;
      const dy = y - nearestY;
      if (dx * dx + dy * dy < radius * radius) return true;
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
  const steps = Math.ceil(length / (CELL_SIZE * 0.5));
  let previousCell = -1;
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const px = x0 + dx * t;
    const py = y0 + dy * t;
    const cx = Math.floor(px / CELL_SIZE);
    const cy = Math.floor(py / CELL_SIZE);
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
