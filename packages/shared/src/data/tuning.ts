/**
 * Global simulation constants.
 *
 * Durations are in ticks and distances in pixels. The original ran at 50fps, so
 * one tick is 20ms and a speed of 1.7 means 85 pixels per second.
 */

/** Milliseconds per simulation step. Matches the original's 50fps. */
export const TICK_MS = 20;
export const TICKS_PER_SECOND = 1000 / TICK_MS;

/** Broad-phase cell size; roughly twice the largest creature radius. */
export const HASH_CELL = 48;

/** Upper bound on live entities, which sizes the spatial hash arrays. */
export const MAX_THINGS = 4096;

export const PLAYER = {
  radius: 10,
  height: 26,
  speed: 1.7,
  mass: 2,
  maxLife: 100,
  /** Ticks before a downed player returns. */
  respawnTicks: 100,
  /** Ticks of invulnerability after spawning. */
  spawnInvincibleTicks: 100,
} as const;

/** Creature separation: how firmly bodies push each other apart. */
export const SEPARATION = {
  /** Fraction of the overlap resolved per tick. */
  strength: 0.5,
  /** Iterations per tick; more is stiffer but costlier. */
  iterations: 2,
} as const;

export const CAMERA = {
  /** Half-size of the rectangle the player can move in before the camera follows. */
  deadzoneX: 45,
  deadzoneY: 35,
  /** Fraction of the remaining distance closed per tick. */
  follow: 0.18,
  shakeDecay: 0.86,
  brightnessDecay: 0.06,
} as const;

/** Ticks the whole simulation freezes on a satisfying kill. */
export const HIT_STOP_TICKS = 2;

export const DECALS = {
  /** Stamps applied per tick, so a heavy firefight cannot spike frame time. */
  perTick: 6,
  /** Stamps retained per map cell before old ones are recycled. */
  perCell: 4,
  max: 900,
} as const;
