/** Small numeric helpers used throughout the simulation. */

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Move `value` toward `target` by at most `step`. */
export function approach(value: number, target: number, step: number): number {
  if (value < target) return Math.min(value + step, target);
  return Math.max(value - step, target);
}

export function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/** Shortest signed turn from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Rotate `from` toward `to` by at most `step` radians. */
export function turnToward(from: number, to: number, step: number): number {
  const delta = angleDelta(from, to);
  if (Math.abs(delta) <= step) return wrapAngle(to);
  return wrapAngle(from + Math.sign(delta) * step);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(distanceSq(ax, ay, bx, by));
}
