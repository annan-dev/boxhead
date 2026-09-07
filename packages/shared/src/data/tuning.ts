/**
 * Global simulation constants.
 *
 * Durations are in ticks and distances in pixels. This simulation steps at
 * 50Hz; the original's game logic ran at 25Hz (`CMain.mFPS = 25`) on a 32px
 * cell grid, so every figure recovered from it is converted here: original
 * ticks are doubled and original cell units are multiplied by 32.
 */

/** Milliseconds per simulation step. */
export const TICK_MS = 20;
export const TICKS_PER_SECOND = 1000 / TICK_MS;

/** Our ticks per original game tick (50Hz against the original's 25Hz). */
export const ORIGINAL_TICK_RATIO = 2;
/** The original's cell size; its distances are expressed in cells. */
export const ORIGINAL_CELL = 32;

/** Broad-phase cell size; roughly twice the largest creature radius. */
export const HASH_CELL = 48;

/** Upper bound on live entities, which sizes the spatial hash arrays. */
export const MAX_THINGS = 4096;

export const PLAYER = {
  radius: 10,
  height: 26,
  /** Original: 0.16 cells per 25Hz tick, i.e. 128 px/s. */
  speed: 2.56,
  mass: 2,
  /** Original: 200. */
  maxLife: 200,
  /** Original: life regenerates to full over 30 seconds. */
  regenPerTick: 200 / (TICKS_PER_SECOND * 30),
  /** Ticks the body lies still after the fall (original `State_Dead`: 50 at 25Hz). */
  deadTicks: 100,
  /** Ticks before a downed player returns (original `State_Respawn`: 25 at 25Hz). */
  respawnTicks: 50,
  /** Ticks of invulnerability after the first spawn (original: 200 at 25Hz). */
  spawnInvincibleTicks: 400,
  /**
   * Ticks of invulnerability after a respawn (original: 25 at 25Hz outside
   * deathmatch; deathmatch uses five times that, see modes.ts).
   */
  respawnInvincibleTicks: 50,
  /**
   * A zombie bite shoves the player (`CThing_Creature.ProcessAffects`):
   * 0.3 cells on the first original tick, decaying by 0.65 a tick, with the
   * controls dead until the slide stops and for three ticks after.
   */
  biteShove: 0.3 * ORIGINAL_CELL,
} as const;

/**
 * Being hit stops a creature (`State_BulletHit`): the shove starts at
 * `max(damage * 0.4 / 32, 0.3)` cells for a bullet (`min` for a blast),
 * divided by mass, decays by 0.65 per original tick until it is under a
 * hundredth of a cell, and the creature then rests three more ticks.
 */
export const HIT_STUN = {
  /** Shove decay per original tick. */
  decay: 0.65,
  /** Shove below which the slide counts as over, in pixels per original tick. */
  rest: 0.01 * ORIGINAL_CELL,
  /** Ticks of rest after the slide, in this simulation's ticks. */
  sleepTicks: 3 * ORIGINAL_TICK_RATIO,
  /** Minimum (bullet) / maximum (blast) shove, in cells. */
  baseCells: 0.3,
  /** Cells of shove per point of damage. */
  perDamage: 0.4 / 32,
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
} as const;

export const DECALS = {
  /** Marks retained before the oldest are recycled. */
  max: 900,
} as const;

/**
 * The original's difficulty presets (`CUpgrades.SetDifficulty`): a higher
 * setting starts the run at a later level with the multiplier, and therefore
 * every upgrade below it, already banked.
 */
export interface DifficultyDef {
  id: string;
  name: string;
  startLevel: number;
  startMultiplier: number;
}

export const DIFFICULTIES: DifficultyDef[] = [
  { id: 'beginner', name: 'Beginner', startLevel: 1, startMultiplier: 1 },
  { id: 'intermediate', name: 'Intermediate', startLevel: 10, startMultiplier: 10 },
  { id: 'expert', name: 'Expert', startLevel: 20, startMultiplier: 30 },
  { id: 'nightmare', name: 'Nightmare', startLevel: 35, startMultiplier: 50 },
];

/**
 * The original's Slow / Normal / Fast setting (`CMain.State_InitWorld`):
 * the logic rate becomes 25 * factor, so the whole game runs at that pace.
 */
export interface GameSpeedDef {
  id: string;
  name: string;
  factor: number;
}

export const GAME_SPEEDS: GameSpeedDef[] = [
  { id: 'slow', name: 'Slow', factor: 0.5 },
  { id: 'normal', name: 'Normal', factor: 1 },
  { id: 'fast', name: 'Fast', factor: 2 },
];
