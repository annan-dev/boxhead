/**
 * Navigation as a shared flow field.
 *
 * Every zombie steering toward the same player wants the same path, so one
 * Dijkstra sweep from the player serves all of them: per-zombie cost becomes a
 * single array lookup, independent of how many zombies exist.
 *
 * All edge weights are small integers, so a bucket queue replaces a heap and
 * the sweep runs in linear time.
 *
 * Barricades are as impassable as walls here: the original's zombies never
 * attack an object, they path around it or wait, and only devils raze what
 * stands in their way (`CThing_Creature_Devil.State_GotoPlayer`).
 */
import { GameMap, Tile } from './GameMap.js';

const COST_FLOOR = 10;
const COST_DIAGONAL = 14; // 10 * sqrt(2), rounded
const UNREACHABLE = 0xffff;

/** Neighbour offsets: 4 orthogonal first, then 4 diagonal, in +/- pairs. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, COST_FLOOR],
  [-1, 0, COST_FLOOR],
  [0, 1, COST_FLOOR],
  [0, -1, COST_FLOOR],
  [1, 1, COST_DIAGONAL],
  [-1, -1, COST_DIAGONAL],
  [1, -1, COST_DIAGONAL],
  [-1, 1, COST_DIAGONAL],
];

export class MapNav {
  /** Accumulated travel cost to the target, per cell. */
  readonly cost: Uint16Array;
  /** Index into NEIGHBOURS giving the cheapest step toward the target. */
  readonly flow: Int8Array;
  private readonly buckets: number[][] = [];
  private builtRevision = -1;
  private targetCell = -1;

  constructor(private readonly map: GameMap) {
    this.cost = new Uint16Array(map.cols * map.rows).fill(UNREACHABLE);
    this.flow = new Int8Array(map.cols * map.rows).fill(-1);
  }

  /** True when the field already reflects this target and current geometry. */
  isCurrent(cx: number, cy: number): boolean {
    return this.builtRevision === this.map.revision && this.targetCell === this.map.index(cx, cy);
  }

  /** What the field was built toward, so a snapshot can reproduce it. */
  getTarget(): { targetCell: number; revision: number } {
    return { targetCell: this.targetCell, revision: this.builtRevision };
  }

  /** Rebuild toward a snapshotted target, or forget it when it is stale. */
  setTarget(targetCell: number, revision: number): void {
    if (targetCell < 0 || revision !== this.map.revision) {
      this.cost.fill(UNREACHABLE);
      this.flow.fill(-1);
      this.builtRevision = -1;
      this.targetCell = -1;
      return;
    }
    this.build(targetCell % this.map.cols, (targetCell / this.map.cols) | 0);
  }

  private enterCost(cx: number, cy: number): number {
    const tile = this.map.tileAt(cx, cy);
    if (tile !== Tile.Floor) return -1;
    return COST_FLOOR;
  }

  /** Recompute the field outward from a target cell. */
  build(targetCx: number, targetCy: number): void {
    const map = this.map;
    if (!map.inBounds(targetCx, targetCy)) return;

    this.cost.fill(UNREACHABLE);
    this.flow.fill(-1);
    this.buckets.length = 0;

    const start = map.index(targetCx, targetCy);
    this.cost[start] = 0;
    this.push(0, start);

    let level = 0;
    while (level < this.buckets.length) {
      const bucket = this.buckets[level];
      if (!bucket || bucket.length === 0) {
        level += 1;
        continue;
      }
      const index = bucket.pop()!;
      const current = this.cost[index]!;
      // A cell may be queued several times; skip the stale entries.
      if (current !== level) continue;

      const cx = index % map.cols;
      const cy = (index / map.cols) | 0;

      for (let n = 0; n < NEIGHBOURS.length; n++) {
        const offset = NEIGHBOURS[n]!;
        const nx = cx + offset[0];
        const ny = cy + offset[1];
        if (!map.inBounds(nx, ny)) continue;

        // No diagonal past a blocked orthogonal neighbour: the original's
        // `Nav_VD` drops both adjacent diagonals whenever a straight step is
        // blocked, so a crowd never squeezes through a corner.
        if (offset[0] !== 0 && offset[1] !== 0) {
          const blockedX = map.tileAt(cx + offset[0], cy) !== Tile.Floor;
          const blockedY = map.tileAt(cx, cy + offset[1]) !== Tile.Floor;
          if (blockedX || blockedY) continue;
        }

        const enter = this.enterCost(nx, ny);
        if (enter < 0) continue;

        const candidate = current + Math.max(offset[2], enter);
        if (candidate >= UNREACHABLE) continue;
        const neighbourIndex = map.index(nx, ny);
        if (candidate < this.cost[neighbourIndex]!) {
          this.cost[neighbourIndex] = candidate;
          // Store the step that walks back toward the target.
          this.flow[neighbourIndex] = n ^ 1;
          this.push(candidate, neighbourIndex);
        }
      }
    }

    this.builtRevision = map.revision;
    this.targetCell = start;
  }

  private push(cost: number, index: number): void {
    let bucket = this.buckets[cost];
    if (!bucket) {
      bucket = [];
      this.buckets[cost] = bucket;
    }
    bucket.push(index);
  }

  /** Unit direction a creature should move to approach the target. */
  directionAt(cx: number, cy: number): { x: number; y: number } | null {
    if (!this.map.inBounds(cx, cy)) return null;
    const step = this.flow[this.map.index(cx, cy)]!;
    if (step < 0) return null;
    const offset = NEIGHBOURS[step]!;
    const length = Math.hypot(offset[0], offset[1]) || 1;
    return { x: offset[0] / length, y: offset[1] / length };
  }

  costAt(cx: number, cy: number): number {
    if (!this.map.inBounds(cx, cy)) return UNREACHABLE;
    return this.cost[this.map.index(cx, cy)]!;
  }

  isReachable(cx: number, cy: number): boolean {
    return this.costAt(cx, cy) < UNREACHABLE;
  }
}
