/**
 * Wave pacing and scoring, as the original computes them.
 *
 * Recovered from `CUpgrades.InitLists` and `CUpgrades.Process` in the SWF.
 * Every level's wave is a formula of the level number, so progression runs
 * indefinitely. The score multiplier is the heart of the original's design:
 * it climbs one step per kill, drains on a window that shrinks as it climbs,
 * and every weapon and upgrade is awarded at a multiplier threshold (see
 * upgrades.ts), never by level. Levels only make the waves bigger and faster.
 *
 * Original tick values are at 25Hz; everything here is in this simulation's
 * 50Hz ticks.
 */
import type { EnemyId } from './enemies.js';
import { ENEMIES } from './enemies.js';
import { ORIGINAL_TICK_RATIO } from './tuning.js';

export interface LevelDef {
  level: number;
  /** Total zombies released this wave: 10, 15, 20, ... */
  zombieTotal: number;
  /** Ticks between zombie spawns: one a second at level 1, near-instant by 25. */
  zombieSpawnRate: number;
  /** Zombies alive at once; the original also caps this at 60 for the renderer. */
  maxAlive: number;
  devilTotal: number;
  /** Devils alive at once. */
  devilMaxAlive: number;
  /**
   * Ticks between devil spawns. The original counts this down ten times faster
   * while zombies are still queued, so devils join the wave early.
   */
  devilSpawnRate: number;
  /** Speed multiplier applied to every zombie and devil spawned this level. */
  speedMul: number;
  /** Spawn weighting across the zombie variants. */
  mix: Array<{ id: EnemyId; weight: number }>;
}

/** The original's tables stop here; later levels repeat the last entry. */
export const LAST_TABLE_LEVEL = 100;

export function levelDef(level: number): LevelDef {
  const shown = Math.max(1, Math.floor(level));
  const n = Math.min(shown, LAST_TABLE_LEVEL);
  const mix: Array<{ id: EnemyId; weight: number }> = [];
  for (const enemy of Object.values(ENEMIES)) {
    if (enemy.weight <= 0 || n < enemy.firstLevel) continue;
    mix.push({ id: enemy.id, weight: enemy.weight });
  }

  // Devils start on level 2 and grow by a quarter of one per level in total,
  // three tenths per level in concurrency (capped at five). The original
  // accumulates these in floating point, so the sums are formed the same way:
  // at level 12 the tenths land just under four and the cap stays at three.
  let devilTotalAcc = 1;
  let devilAliveAcc = 1;
  for (let i = 2; i < n; i++) {
    devilTotalAcc += 0.25;
    devilAliveAcc += 0.3;
  }
  const devilTotal = n < 2 ? 0 : Math.floor(devilTotalAcc);
  const devilMaxAlive = n < 2 ? 0 : Math.floor(Math.min(5, devilAliveAcc));

  return {
    level: shown,
    zombieTotal: 10 + 5 * (n - 1),
    zombieSpawnRate: Math.max(26 - n, 1) * ORIGINAL_TICK_RATIO,
    maxAlive: Math.min(10 + 5 * (n - 1), 60),
    devilTotal,
    devilMaxAlive,
    devilSpawnRate: Math.max(250 - (n - 1), 25) * ORIGINAL_TICK_RATIO,
    speedMul: Math.min(1 + n / 10, 5),
    mix,
  };
}

/** Kills needed to clear a level: the whole wave must die. */
export function killsToClear(level: number): number {
  const def = levelDef(level);
  return def.zombieTotal + def.devilTotal;
}

export const SCORING = {
  /** The multiplier never climbs past this. */
  maxMultiplier: 999,
  /** A crate drops on every fifth kill of an unbroken quick-kill streak. */
  pickupEveryStreakKills: 5,
  /**
   * Ticks a dropped crate stays before fading (original: 10 seconds). Real
   * seconds: the original reads its frame rate live here, so the game speed
   * setting does not stretch it. See `World.realTicks`.
   */
  pickupLifeTicks: 10 * 25 * ORIGINAL_TICK_RATIO,
  /**
   * Ticks before a room's own crate reappears after being taken: 10 seconds
   * in single player and co-op, 30 in deathmatch (`CThing_Object_Pickup.PickedUp`).
   */
  pickupRespawnTicks: 10 * 25 * ORIGINAL_TICK_RATIO,
  pickupRespawnTicksDeathmatch: 30 * 25 * ORIGINAL_TICK_RATIO,
  /**
   * The original tests its countdowns before decrementing and fires only once
   * they were already below zero, so every window runs two original ticks
   * longer than `GetTicks` says.
   */
  countdownLagTicks: 2 * ORIGINAL_TICK_RATIO,
} as const;

/**
 * Ticks the multiplier holds at a given value before dropping one step
 * (`CUpgrades.GetTicks`): three seconds at x1, shrinking on a 2.5-power curve
 * to a tenth of a second by x100. High multipliers demand relentless killing.
 *
 * The original computes `3 + (3 * mFPS - 3) * k` with the live frame rate, so
 * the window is a span of real time whatever the game speed; `speedFactor`
 * is that rate divided by 25.
 */
export function multiplierWindow(multiplier: number, speedFactor = 1): number {
  const index = Math.min(Math.max(1, multiplier), 100);
  const k = Math.pow(101 - index, 2.5) / 100000;
  const original = 3 + (3 * 25 * speedFactor - 3) * k;
  return Math.max(1, Math.round(original * ORIGINAL_TICK_RATIO));
}

/** The streak counter that paces crate drops runs on a sixth of that window. */
export function streakWindow(streak: number, speedFactor = 1): number {
  return Math.max(1, Math.round(multiplierWindow(streak, speedFactor) / 6));
}
