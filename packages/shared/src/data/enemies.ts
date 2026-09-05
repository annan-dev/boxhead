/**
 * Enemy definitions.
 *
 * The original ships two creature types, zombie and devil, each rendered by
 * swapping a head overlay and a material set onto the shared player rig. The
 * runner and brute here are zombie variants introduced as levels climb, which
 * keeps later waves from being one texture repeated three hundred times.
 */

export type EnemyId = 'zombie' | 'runner' | 'brute' | 'devil';

export interface EnemyDef {
  id: EnemyId;
  name: string;
  maxLife: number;
  /** Pixels per tick. */
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

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  zombie: {
    id: 'zombie',
    name: 'Zombie',
    maxLife: 100,
    speed: 1.1,
    speedVariance: 0.15,
    mass: 1,
    radius: 11,
    height: 26,
    attack: { kind: 'melee', damage: 12, cooldown: 22, reach: 6, windup: 6 },
    wallDamage: 14,
    score: 10,
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
    speed: 1.95,
    speedVariance: 0.12,
    mass: 0.8,
    radius: 10,
    height: 25,
    attack: { kind: 'melee', damage: 9, cooldown: 16, reach: 6, windup: 4 },
    wallDamage: 10,
    score: 20,
    firstLevel: 6,
    weight: 45,
    headGroup: 'Zombie',
    skin: 'Zombie',
    bloodColor: '#7a0d12',
    drawScale: 0.94,
  },
  brute: {
    id: 'brute',
    name: 'Brute',
    maxLife: 340,
    speed: 0.78,
    speedVariance: 0.1,
    mass: 3,
    radius: 16,
    height: 34,
    attack: { kind: 'melee', damage: 28, cooldown: 34, reach: 9, windup: 10 },
    wallDamage: 45,
    score: 60,
    firstLevel: 10,
    weight: 18,
    headGroup: 'Zombie',
    skin: 'Zombie',
    bloodColor: '#5e0a0f',
    drawScale: 1.32,
  },
  devil: {
    id: 'devil',
    name: 'Devil',
    maxLife: 260,
    speed: 1.45,
    speedVariance: 0.1,
    mass: 2,
    radius: 13,
    height: 28,
    attack: { kind: 'ranged', damage: 30, cooldown: 70, reach: 320, windup: 14 },
    wallDamage: 20,
    score: 50,
    firstLevel: 5,
    weight: 0, // devils are spawned on their own schedule, not in the zombie mix
    headGroup: 'Devil',
    skin: 'Devil',
    bloodColor: '#8a1b06',
    drawScale: 1.05,
  },
};

/** Devil fireball, spawned by a ranged attack. */
export const FIREBALL = {
  speed: 5.2,
  radius: 7,
  damage: 30,
  splashRadius: 46,
  life: 200,
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
