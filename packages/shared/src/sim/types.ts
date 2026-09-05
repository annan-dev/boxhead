/**
 * Entity shapes for the simulation.
 *
 * Entities are plain mutable records held in typed pools rather than a class
 * hierarchy: the simulation runs headless on a server as well as in the
 * browser, and flat records keep it cheap to snapshot and to iterate.
 *
 * Every entity keeps its previous position so rendering can interpolate
 * between the 50Hz simulation and the display refresh rate.
 */
import type { EnemyId } from '../data/enemies.js';
import type { ShotKind, WeaponId } from '../data/weapons.js';
import type { PlayerStats, UpgradeId } from '../data/upgrades.js';

export interface Entity {
  id: number;
  alive: boolean;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  angle: number;
  radius: number;
  /** Height above the floor, for the pseudo-3D draw offset. */
  z: number;
}

export type CreatureState = 'alive' | 'dying' | 'dead' | 'respawning';

export interface Creature extends Entity {
  life: number;
  maxLife: number;
  speed: number;
  mass: number;
  height: number;
  state: CreatureState;
  /** Ticks spent in the current state. */
  stateTicks: number;
  /** Advances once per animation step, driving the walk cycle. */
  animStep: number;
  /** Ticks until the creature can attack again. */
  attackCooldown: number;
  /** Counts down a telegraphed attack; damage lands at zero. */
  windup: number;
  /** True while the creature is moving under its own power. */
  moving: boolean;
  /** Set on the tick the creature takes damage, for the hit animation. */
  hitTicks: number;
  /** True when the last hit came from behind. */
  hitFromRear: boolean;
}

export interface Enemy extends Creature {
  defId: EnemyId;
  /** Player entity id this enemy is chasing, or -1. */
  targetId: number;
  /** Cached line-of-sight result, refreshed on a stagger. */
  hasLos: boolean;
  losTimer: number;
  /** Ticks spent making no progress, which triggers attacking the barricade. */
  stuckTicks: number;
  /** Small per-instance drift so crowds do not march in lockstep. */
  wobblePhase: number;
  /** Cell of a barricade this enemy has decided to break through. */
  chewCx: number;
  chewCy: number;
}

export interface WeaponSlot {
  unlocked: boolean;
  ammo: number;
}

export interface Player extends Creature {
  /** Zero-based player index; also selects the input source. */
  index: number;
  characterId: string;
  weapons: Map<WeaponId, WeaponSlot>;
  current: WeaponId;
  /** Ticks until the weapon can fire again. */
  fireCooldown: number;
  /** Ticks of spawn protection remaining. */
  invincible: number;
  /** Ticks until respawn while down. */
  respawnTimer: number;
  held: Array<{ weapon: WeaponId; upgrade: UpgradeId }>;
  stats: PlayerStats;
  /** True while the fire control was held last tick, for release-fired weapons. */
  firingHeld: boolean;
  kills: number;
}

export interface Shot extends Entity {
  ownerId: number;
  weapon: WeaponId;
  kind: ShotKind;
  damage: number;
  knockback: number;
  /** Ticks remaining before the shot expires. */
  life: number;
  travelled: number;
  maxRange: number;
  pierce: boolean;
  splashRadius: number;
  splashDamage: number;
  /** Ticks until a thrown projectile detonates; -1 when not fused. */
  fuse: number;
  /** Ids already damaged, so a piercing shot hits each target once. */
  hits: Set<number>;
  /** Spawns cluster shells on detonation. */
  cluster: boolean;
}

export type PlaceableType = 'barrel' | 'mine' | 'chargepack';

export interface Placeable extends Entity {
  type: PlaceableType;
  ownerId: number;
  hp: number;
  /** Ticks until it becomes live; mines only. */
  armTime: number;
  /** Ticks until automatic detonation; -1 when triggered instead. */
  fuse: number;
  triggerRadius: number;
  splashRadius: number;
  splashDamage: number;
  cluster: boolean;
  /** Set when something has already scheduled this to blow, preventing loops. */
  detonating: boolean;
}

export type EffectType =
  | 'explosion'
  | 'muzzle'
  | 'blood'
  | 'smoke'
  | 'spark'
  | 'fireball'
  | 'gib';

export interface Effect extends Entity {
  type: EffectType;
  life: number;
  maxLife: number;
  size: number;
  /** Free parameter: rotation for gibs, intensity for explosions. */
  seed: number;
}

export type PickupType = 'life' | 'ammo';

export interface Pickup extends Entity {
  type: PickupType;
  weapon: WeaponId | null;
  amount: number;
  /** Ticks before it disappears; -1 to persist. */
  life: number;
}

/** A permanent floor mark. The client stamps these into its floor layer. */
export interface Decal {
  x: number;
  y: number;
  type: 'blood' | 'scorch' | 'pock';
  size: number;
  seed: number;
  color: string;
}

/** A queued area-of-effect application, resolved on the following tick. */
export interface PendingAffect {
  x: number;
  y: number;
  radius: number;
  damage: number;
  ownerId: number;
  knockback: number;
  cluster: boolean;
  /** Prevents a chain reaction from recursing without bound. */
  depth: number;
}

/** Transient banner text, e.g. a level heading or an upgrade award. */
export interface Message {
  text: string;
  kind: 'level' | 'upgrade' | 'info' | 'critical';
  /** Ticks remaining on screen. */
  life: number;
}

/** A floating score or multi-kill popup. */
export interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
  kind: 'score' | 'combo';
}

/** Audio requests raised by the simulation; the client plays and clears them. */
export interface SoundEvent {
  name: string;
  x: number;
  y: number;
  /** Pitch jitter, 1 is unmodified. */
  rate: number;
}
