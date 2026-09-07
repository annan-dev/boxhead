/**
 * Enemy definitions, from the original's creature classes.
 *
 * The original ships two creature types, zombie and devil, each rendered by
 * swapping a head overlay and a material set onto the shared player rig.
 * Their numbers were recovered from `CThing_Creature_Zombie` and
 * `CThing_Creature_Devil` and converted from 25Hz cell units to 50Hz pixels.
 *
 * Zombies are slow at first: a fifth of the player's pace. What makes them
 * dangerous is the crowd, a 50-point bite, and the per-level speed multiplier
 * (see levels.ts) that has them at five times their starting pace by level 40.
 *
 * The runner and brute are this port's own variants and are not part of the
 * original; they stay defined but out of the spawn mix.
 */

export type EnemyId = 'zombie' | 'runner' | 'brute' | 'devil';

export interface EnemyDef {
  id: EnemyId;
  name: string;
  maxLife: number;
  /** Pixels per tick, before the level multiplier. */
  speed: number;
  /** Per-instance speed jitter, as a fraction, so crowds spread out. */
  speedVariance: number;
  /** Weighting for push-apart; heavier creatures shove lighter ones. */
  mass: number;
  radius: number;
  height: number;
  attack: {
    kind: 'melee' | 'ranged';
    damage: number;
    /** Ticks between attacks. */
    cooldown: number;
    /** Reach beyond the sum of the radii. */
    reach: number;
    /** Telegraph before damage lands. */
    windup: number;
  };
  /** Damage dealt to a barricade per attack. */
  wallDamage: number;
  score: number;
  /** Earliest wave this type can appear. */
  firstLevel: number;
  /** Spawn weighting once unlocked. */
  weight: number;
  /** Rig group supplying the head overlay. */
  headGroup: 'Zombie' | 'Devil';
  /** Texture prefix for the body skin. */
  skin: 'Zombie' | 'Devil';
  /** Tint for blood decals. */
  bloodColor: string;
  /** Visual scale, so brutes read as bigger. */
  drawScale: number;
}

/**
 * The original moves creatures cell to cell (`State_CellToCell_Init`): a
 * straight step costs 1/speed ticks and a diagonal one 1.414/speed, so the
 * ground covered is exactly `speed` cells per original tick either way.
 */
function originalSpeed(cellsPerTick: number): number {
  return +((cellsPerTick * 32) / 2).toFixed(3);
}

/**
 * Attack animations run at a rate tied to the creature's speed
 * (`State_Attack`): `min(k * speed * 25 * 1.5, 1)` frames per original tick,
 * with k = 0.3 for a zombie and 0.2 for a devil. The clips are four frames;
 * the zombie bites when its clip ends, the devil throws on frame three and
 * plays the clip out. `speedCells` is the creature's speed in cells per
 * original tick, level multiplier included.
 */
/**
 * A creature's death (`State_Dying` / `State_Dead`): the five-frame dying
 * clip plays at 0.34 frames per original tick, the corpse then lies for two
 * seconds and fades over the last one, and only then is the thing gone.
 * In this simulation's ticks.
 */
export const DEATH = {
  dyingTicks: Math.round((5 / 0.34) * 2),
  corpseTicks: 50 * 2,
  fadeTicks: 25 * 2,
} as const;

export function attackTiming(id: EnemyId, speedCells: number): { windup: number; total: number } {
  const frames = 4;
  const k = id === 'devil' ? 0.2 : 0.3;
  const rate = Math.min(k * speedCells * 25 * 1.5, 1);
  const total = Math.round((frames / rate) * 2);
  const windup = id === 'devil' ? Math.round((3 / rate) * 2) : total;
  return { windup, total };
}

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  zombie: {
    id: 'zombie',
    name: 'Zombie',
    maxLife: 100,
    speed: originalSpeed(0.02),
    // The original's zombies all move at exactly the same pace.
    speedVariance: 0,
    mass: 1,
    radius: 11,
    height: 26,
    // A zombie attacks the cell ahead once the player stands in it, so the
    // bite reaches about a cell and a quarter from centre to centre. The
    // wind-up comes from `attackTiming`; after the bite the zombie rests ten
    // original ticks (`State_Sleep`) before it moves again.
    attack: { kind: 'melee', damage: 50, cooldown: 20, reach: 19, windup: 32 },
    wallDamage: 50,
    score: 100,
    firstLevel: 1,
    weight: 100,
    headGroup: 'Zombie',
    skin: 'Zombie',
    bloodColor: '#7a0d12',
    drawScale: 1,
  },
  runner: {
    id: 'runner',
    name: 'Runner',
    maxLife: 70,
    speed: originalSpeed(0.035),
    speedVariance: 0.12,
    mass: 0.8,
    radius: 10,
    height: 25,
    attack: { kind: 'melee', damage: 35, cooldown: 40, reach: 6, windup: 12 },
    wallDamage: 35,
    score: 200,
    firstLevel: 6,
    weight: 0, // not in the original; kept for experiments
    headGroup: 'Zombie',
    skin: 'Zombie',
    bloodColor: '#7a0d12',
    drawScale: 0.94,
  },
  brute: {
    id: 'brute',
    name: 'Brute',
    maxLife: 340,
    speed: originalSpeed(0.014),
    speedVariance: 0.1,
    mass: 3,
    radius: 16,
    height: 34,
    attack: { kind: 'melee', damage: 100, cooldown: 70, reach: 9, windup: 24 },
    wallDamage: 150,
    score: 600,
    firstLevel: 10,
    weight: 0, // not in the original; kept for experiments
    headGroup: 'Zombie',
    skin: 'Zombie',
    bloodColor: '#5e0a0f',
    drawScale: 1.32,
  },
  devil: {
    id: 'devil',
    name: 'Devil',
    maxLife: 1000,
    speed: originalSpeed(0.04),
    speedVariance: 0,
    mass: 5,
    radius: 13,
    height: 28,
    // Fires whenever it has line of sight within five cells and is already
    // facing the player's direction; the attack animation is the only pause
    // between shots. Wind-up and cadence come from `attackTiming`.
    attack: { kind: 'ranged', damage: 50, cooldown: 0, reach: 5 * 32, windup: 17 },
    wallDamage: 50,
    score: 1000,
    firstLevel: 2,
    weight: 0, // devils are spawned on their own schedule, not in the zombie mix
    headGroup: 'Devil',
    skin: 'Devil',
    bloodColor: '#8a1b06',
    drawScale: 1.05,
  },
};

/**
 * Devil fireball (`CThing_Shot_FireBall`). The devil never sets an attack
 * speed, so the shot takes the class default of 0.15 cells per original tick
 * and grows by 1.02 every tick; it flies until it hits something. A quarter
 * cell across, it bursts on a half-cell square with the devil's damage. Fired
 * at an object in the devil's way instead, it is a cell across and razes
 * whatever it lands on.
 */
export const FIREBALL = {
  /** Pixels per tick at launch: 0.15 cells per 25Hz tick. */
  speed: (0.15 * 32) / 2,
  /** Growth per tick: 1.02 per original tick. */
  acceleration: Math.sqrt(1.02),
  radius: 8,
  damage: 50,
  /** The burst against a creature: a half-cell square, applied as a circle. */
  splashRadius: 16,
  /** The burst against an object: a full cell. */
  objectSplashRadius: 32,
  /** Damage to walls and barrels in object mode (`DevilAttack` 10000). */
  objectDamage: 10000,
  /** Launched this far ahead of the devil, this high. */
  spawnReach: 1.5,
  spawnZ: 27,
} as const;

/** The four cosmetic player characters; identical stats, different art. */
export interface CharacterDef {
  id: string;
  name: string;
  /** Texture prefix, matching the extracted symbols. */
  skin: string;
  /** Rig group supplying the head; null uses the base rig head. */
  headGroup: string | null;
}

export const CHARACTERS: CharacterDef[] = [
  { id: 'swat', name: 'SWAT', skin: 'Swat', headGroup: null },
  { id: 'bond', name: 'Bond', skin: 'Bond', headGroup: null },
  { id: 'gijoe', name: 'GI Joe', skin: 'GIJOE', headGroup: null },
  { id: 'bambo', name: 'Bambo', skin: 'Bambo', headGroup: 'Player_Alternate1' },
];
