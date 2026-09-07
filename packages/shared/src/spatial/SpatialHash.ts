/**
 * Uniform-grid broad phase -- the equivalent of the original's "mapwho".
 *
 * Storage is three Int32Arrays forming intrusive linked lists, so inserting,
 * moving and querying never allocate. That matters: this is touched by every
 * creature every tick, plus every shot sweep and every explosion.
 */
export class SpatialHash {
  private readonly head: Int32Array;
  private readonly next: Int32Array;
  private readonly cellOf: Int32Array;
  /** Per-id visit stamp for segment queries, so de-duplication never allocates. */
  private readonly seenStamp: Uint32Array;
  private stamp = 0;
  readonly cols: number;
  readonly rows: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cellSize: number,
    readonly capacity: number,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
    this.cellOf = new Int32Array(capacity).fill(-1);
    this.seenStamp = new Uint32Array(capacity);
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return cy * this.cols + cx;
  }

  clear(): void {
    this.head.fill(-1);
    this.next.fill(-1);
    this.cellOf.fill(-1);
  }

  insert(id: number, x: number, y: number): void {
    const cell = this.cellIndex(x, y);
    this.cellOf[id] = cell;
    this.next[id] = this.head[cell]!;
    this.head[cell] = id;
  }

  remove(id: number): void {
    const cell = this.cellOf[id]!;
    if (cell < 0) return;
    let current = this.head[cell]!;
    if (current === id) {
      this.head[cell] = this.next[id]!;
    } else {
      while (current !== -1) {
        const following = this.next[current]!;
        if (following === id) {
          this.next[current] = this.next[id]!;
          break;
        }
        current = following;
      }
    }
    this.cellOf[id] = -1;
    this.next[id] = -1;
  }

  /** Cheap when the entity has not crossed a cell boundary, which is the norm. */
  move(id: number, x: number, y: number): void {
    const cell = this.cellIndex(x, y);
    if (cell === this.cellOf[id]) return;
    this.remove(id);
    this.insert(id, x, y);
  }

  /**
   * Ids whose cell overlaps the circle, written into `out` in ascending id
   * order. Returns the count; callers must still do the exact distance test.
   *
   * The order matters: callers draw random numbers per hit, so it must not
   * depend on the order things happened to be inserted, which differs between
   * a world that played out live and one restored from a snapshot.
   */
  queryCircle(x: number, y: number, radius: number, out: Int32Array): number {
    const count = this.collectCircle(x, y, radius, out);
    if (count > 1) out.subarray(0, count).sort();
    return count;
  }

  private collectCircle(x: number, y: number, radius: number, out: Int32Array): number {
    const minX = Math.max(0, Math.floor((x - radius) / this.cellSize));
    const maxX = Math.min(this.cols - 1, Math.floor((x + radius) / this.cellSize));
    const minY = Math.max(0, Math.floor((y - radius) / this.cellSize));
    const maxY = Math.min(this.rows - 1, Math.floor((y + radius) / this.cellSize));
    let count = 0;
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        let id = this.head[cy * this.cols + cx]!;
        while (id !== -1) {
          if (count >= out.length) return count;
          out[count] = id;
          count += 1;
          id = this.next[id]!;
        }
      }
    }
    return count;
  }

  /**
   * Ids in cells the segment passes through, for swept projectiles, in
   * ascending id order (see `queryCircle` for why).
   * Walks the cells with a DDA rather than testing the whole bounding box.
   */
  querySegment(x0: number, y0: number, x1: number, y1: number, out: Int32Array): number {
    const count = this.collectSegment(x0, y0, x1, y1, out);
    if (count > 1) out.subarray(0, count).sort();
    return count;
  }

  private collectSegment(x0: number, y0: number, x1: number, y1: number, out: Int32Array): number {
    let count = 0;
    this.stamp += 1;
    if (this.stamp === 0xffffffff) {
      this.seenStamp.fill(0);
      this.stamp = 1;
    }
    const seen = this.stamp;
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / (this.cellSize * 0.5)),
    );
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(px / this.cellSize)));
      const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(py / this.cellSize)));
      // Include the 8 neighbours so entities straddling a boundary are caught.
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        for (let nx = cx - 1; nx <= cx + 1; nx++) {
          if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
          let id = this.head[ny * this.cols + nx]!;
          while (id !== -1) {
            if (this.seenStamp[id] !== seen) {
              this.seenStamp[id] = seen;
              if (count >= out.length) return count;
              out[count] = id;
              count += 1;
            }
            id = this.next[id]!;
          }
        }
      }
    }
    return count;
  }
}
