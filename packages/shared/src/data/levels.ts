/**
 * Wave pacing and scoring.
 *
 * The original tracks Zombie_TotalCount / Zombie_SpawnRate and the devil
 * equivalents per level, and layers a multi-kill multiplier on top. Both are
 * reproduced here as functions of level so progression continues indefinitely
 * rather than running off the end of a table.
 */
import type { EnemyId } from './enemies.js';
import { ENEMIES } from './enemies.js';

export interface LevelDef {
  level: number;
  /** Total zombies released this wave. */
  zombieTotal: number;
  /** Ticks between zombie spawns. */
  zombieSpawnRate: number;
  devilTotal: number;
  devilSpawnRate: number;
  /** Spawn weighting across the unlocked zombie variants. */
  mix: Array<{ id: EnemyId; weight: number }>;
  /** Concurrency cap; the rest queue until something dies. */
  maxAlive: number;
}

export function levelDef(level: number, ramp = 1): LevelDef {
  const n = Math.max(1, level);
  const zombieTotal = Math.round((8 + n * 3.2 + Math.pow(n, 1.45)) * ramp);
  const zombieSpawnRate = Math.max(5, Math.round(48 - n * 2.1));
  const devilTotal = n < ENEMIES.devil.firstLevel ? 0 : Math.floor((n - 4) * 0.85);
  const devilSpawnRate = Math.max(35, 160 - n * 5);

  const mix: Array<{ id: EnemyId; weight: number }> = [];
  for (const enemy of Object.values(ENEMIES)) {
    if (enemy.weight <= 0 || n < enemy.firstLevel) continue;
    mix.push({ id: enemy.id, weight: enemy.weight });
  }

  return {
    level: n,
    zombieTotal,
    zombieSpawnRate,
    devilTotal,
    devilSpawnRate,
    mix,
    maxAlive: Math.min(200, 45 + n * 7),
  };
}

/** Kills needed to clear a level; the wave total, so every spawn must die. */
export function killsToClear(level: number, ramp = 1): number {
  const def = levelDef(level, ramp);
  return def.zombieTotal + def.devilTotal;
}

export const SCORING = {
  /** Kills within this window count toward a multi-kill. */
  multiKillWindow: 40,
  /** Bonus by multi-kill size; index 0 and 1 are the ordinary case. */
  multiKillBonus: [1, 1, 1.5, 2, 3, 4, 6],
  /** Kills needed to raise the running multiplier by one. */
  killsPerMultiplier: 10,
  maxMultiplier: 8,
  /** Base ticks before the multiplier decays; tightens as levels rise. */
  multiplierWindow: 200,
} as const;

export function multiKillBonus(count: number): number {
  const table = SCORING.multiKillBonus;
  return table[Math.min(count, table.length - 1)] ?? 1;
}

export function multiKillLabel(count: number): string | null {
  if (count === 2) return 'DOUBLE KILL';
  if (count === 3) return 'TRIPLE KILL';
  if (count >= 4) return 'MULTI KILL!';
  return null;
}

/** The decay window shortens with level, so late waves demand faster kills. */
export function multiplierWindow(level: number): number {
  return SCORING.multiplierWindow - Math.min(120, level * 4);
}
