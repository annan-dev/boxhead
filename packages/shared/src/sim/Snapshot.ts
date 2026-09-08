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
import type { CreatureState, EffectType, PendingAffect, PlaceableType, PickupType } from './types.js';
import type { ShotKind } from '../data/weapons.js';
import type { GameMode } from '../net/Protocol.js';

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
  pushX: number;
  pushY: number;
  stun: number;
  current: WeaponId;
  fireCooldown: number;
  invincible: number;
  respawnTimer: number;
  kills: number;
  score: number;
  firingHeld: boolean;
  fireHeldTicks: number;
  detonateMode: boolean;
  connected: boolean;
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
  pushX: number;
  pushY: number;
  stun: number;
  targetId: number;
  hasLos: boolean;
  losTimer: number;
  stuckTicks: number;
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
  extraBlasts: number;
  wallDamage: number;
  hits: number[];
  z: number;
  vz: number;
  hitscan: boolean;
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
  extraBlasts: number;
  detonating: boolean;
}

export interface PickupSnapshot {
  id: number;
  type: PickupType;
  weapon: WeaponId | null;
  x: number;
  y: number;
  amount: number;
  life: number;
  permanent: boolean;
  hiddenUntil: number;
}

/**
 * Effects are cosmetic, but they draw ids from the same allocator as
 * everything else. Leaving them out would make a restored world release ids
 * in a different order from the original and drift from it.
 */
export interface EffectSnapshot {
  id: number;
  type: EffectType;
  x: number;
  y: number;
  angle: number;
  life: number;
  maxLife: number;
  size: number;
  seed: number;
  variant: string;
  /** Drift, for rocket smoke. */
  vx: number;
  vy: number;
}

export interface NavSnapshot {
  /** Cell the flow field was last built toward, or -1. */
  targetCell: number;
  /** Map revision the field reflects. */
  revision: number;
}

export interface WorldSnapshot {
  version: 2;
  tick: number;
  mode: GameMode;
  level: number;
  score: number;
  kills: number;
  multiplier: number;
  gameOver: boolean;
  /** Tick the run ended on, or -1 while it is still going. */
  gameOverTick: number;
  /** Player index that won a deathmatch, or -1. */
  winnerIndex: number;
  /** Generator state, so the restored world continues the same sequence. */
  rng: [number, number, number, number];
  /** Wave and scoring bookkeeping. */
  progress: {
    spawnedThisLevel: number;
    devilsSpawned: number;
    zombieSpawnTimer: number;
    devilSpawnTimer: number;
    multiplierTicks: number;
    /** Highest multiplier reached; every award up to it has been granted. */
    peakMultiplier: number;
    streak: number;
    streakTicks: number;
    waveGrace: number;
    navCursor: number;
  };
  /** Identity allocator, so restored ids stay unique. */
  ids: { next: number; free: number[] };
  /**
   * Tiles change when barricades are built or destroyed. A sender that knows
   * the receiver already holds this revision may omit the arrays; restoring
   * such a snapshot onto a map at a different revision is an error.
   */
  map: { tiles?: number[]; integrity?: number[]; revision: number; integrityRevision: number };
  players: PlayerSnapshot[];
  enemies: EnemySnapshot[];
  shots: ShotSnapshot[];
  placeables: PlaceableSnapshot[];
  pickups: PickupSnapshot[];
  effects: EffectSnapshot[];
  /** Area effects queued for the next tick, e.g. mid chain-reaction. */
  affects: PendingAffect[];
  /** One per player, in player order. */
  navs: NavSnapshot[];
}

export interface SnapshotOptions {
  /** Include the tile arrays; default true. */
  includeMap?: boolean;
}

export class SnapshotError extends Error {}
