/**
 * World serialisation.
 *
 * This is the seam that makes an authoritative server possible: the server owns
 * a World, and clients receive snapshots of it. The format here is plain JSON
 * rather than a packed binary delta -- correctness first. Swapping in a binary
 * encoder later changes only this file, because everything else already speaks
 * in terms of `WorldSnapshot`.
 *
 * The round-trip guarantee is that restoring a snapshot yields a world whose
 * `stateHash()` matches the original, which the tests assert.
 */
import type { WeaponId } from '../data/weapons.js';
import type { UpgradeId } from '../data/upgrades.js';
import type { EnemyId } from '../data/enemies.js';
import type { CreatureState, PlaceableType, PickupType } from './types.js';
import type { ShotKind } from '../data/weapons.js';

export interface PlayerSnapshot {
  id: number;
  index: number;
  characterId: string;
  x: number;
  y: number;
  angle: number;
  life: number;
  maxLife: number;
  state: CreatureState;
  stateTicks: number;
  animStep: number;
  moving: boolean;
  hitTicks: number;
  hitFromRear: boolean;
  current: WeaponId;
  fireCooldown: number;
  invincible: number;
  respawnTimer: number;
  kills: number;
  firingHeld: boolean;
  weapons: Array<[WeaponId, { unlocked: boolean; ammo: number }]>;
  held: Array<{ weapon: WeaponId; upgrade: UpgradeId }>;
}

export interface EnemySnapshot {
  id: number;
  defId: EnemyId;
  x: number;
  y: number;
  angle: number;
  life: number;
  maxLife: number;
  speed: number;
  state: CreatureState;
  stateTicks: number;
  animStep: number;
  attackCooldown: number;
  windup: number;
  moving: boolean;
  hitTicks: number;
  hitFromRear: boolean;
  targetId: number;
  hasLos: boolean;
  losTimer: number;
  stuckTicks: number;
  wobblePhase: number;
}

export interface ShotSnapshot {
  id: number;
  ownerId: number;
  weapon: WeaponId;
  kind: ShotKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  damage: number;
  knockback: number;
  life: number;
  travelled: number;
  maxRange: number;
  pierce: boolean;
  splashRadius: number;
  splashDamage: number;
  fuse: number;
  cluster: boolean;
  hits: number[];
}

export interface PlaceableSnapshot {
  id: number;
  type: PlaceableType;
  ownerId: number;
  x: number;
  y: number;
  hp: number;
  armTime: number;
  fuse: number;
  triggerRadius: number;
  splashRadius: number;
  splashDamage: number;
  cluster: boolean;
}

export interface PickupSnapshot {
  id: number;
  type: PickupType;
  weapon: WeaponId | null;
  x: number;
  y: number;
  amount: number;
}

export interface WorldSnapshot {
  version: 1;
  tick: number;
  level: number;
  score: number;
  kills: number;
  multiplier: number;
  gameOver: boolean;
  /** Generator state, so the restored world continues the same sequence. */
  rng: [number, number, number, number];
  /** Wave and scoring bookkeeping. */
  progress: {
    spawnedThisLevel: number;
    killsThisLevel: number;
    devilsSpawned: number;
    zombieSpawnTimer: number;
    devilSpawnTimer: number;
    multiplierTicks: number;
    killsTowardMultiplier: number;
    multiKillCount: number;
    multiKillTicks: number;
    waveGrace: number;
    navCursor: number;
  };
  /** Identity allocator, so restored ids stay unique. */
  ids: { next: number; free: number[] };
  /** Tiles change when barricades are built or destroyed. */
  map: { tiles: number[]; integrity: number[]; revision: number };
  players: PlayerSnapshot[];
  enemies: EnemySnapshot[];
  shots: ShotSnapshot[];
  placeables: PlaceableSnapshot[];
  pickups: PickupSnapshot[];
}
