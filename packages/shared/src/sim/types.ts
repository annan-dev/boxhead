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
  /**
   * Shove from the last hit, in pixels per tick, decaying each tick; the
   * creature slides on it and does nothing else while `stun` runs.
   */
  pushX: number;
  pushY: number;
  /** Ticks left without control after a hit: the slide, then a short rest. */
  stun: number;
}

export interface Enemy extends Creature {
  kind: 'enemy';
  defId: EnemyId;
  /** Player entity id this enemy is chasing, or -1. */
  targetId: number;
  /** Cached line-of-sight result, refreshed on a stagger. */
  hasLos: boolean;
  losTimer: number;
  /** Ticks spent making no progress; a devil answers by razing what is in its way. */
  stuckTicks: number;
}

export interface WeaponSlot {
  unlocked: boolean;
  ammo: number;
}

export interface Player extends Creature {
  kind: 'player';
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
  /** Ticks the fire control has been held, which charges a grenade throw. */
  fireHeldTicks: number;
  /**
   * Charge packs alternate between placing and detonating on each press
   * (`CThing_Weapon_ChargePack.Fire`); true when the next press sets them off.
   */
  detonateMode: boolean;
  kills: number;
  /** Deathmatch tally, one per kill credited; unused where the score is shared. */
  score: number;
  /**
   * False for a slot nobody is driving (a free seat on a server). Such a
   * player stays dead, never respawns and is not drawn.
   */
  connected: boolean;
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
  /** Follow-up blasts a cell out (Big Bang / Bigger Bang). */
  extraBlasts: number;
  /** Damage to walls and barrels in the burst, where it differs from `splashDamage`. */
  wallDamage: number;
  /** Vertical speed, for lobbed projectiles; `z` is the height. */
  vz: number;
  /** Resolves its whole range on the tick it is fired, like the original's bullets. */
  hitscan: boolean;
}

export type PlaceableType = 'barrel' | 'mine' | 'chargepack';

export interface Placeable extends Entity {
  kind: 'placeable';
  type: PlaceableType;
  ownerId: number;
  hp: number;
  /** Ticks until it becomes live; mines only. -1 waits for its cell to be clear of bodies. */
  armTime: number;
  /** Ticks until automatic detonation; -1 when triggered instead. */
  fuse: number;
  triggerRadius: number;
  splashRadius: number;
  splashDamage: number;
  cluster: boolean;
  /** Follow-up blasts a cell out (Big Bang / Bigger Bang). */
  extraBlasts: number;
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
  | 'rocketsmoke'
  | 'gib';

export interface Effect extends Entity {
  type: EffectType;
  life: number;
  maxLife: number;
  size: number;
  /** Free parameter: rotation for gibs, intensity for explosions. */
  seed: number;
  /** Optional flavour, e.g. the weapon behind a muzzle flash. */
  variant: string;
}

export type PickupType = 'life' | 'ammo';

export interface Pickup extends Entity {
  kind: 'pickup';
  type: PickupType;
  weapon: WeaponId | null;
  amount: number;
  /** Ticks before it disappears; -1 to persist. */
  life: number;
  /** A room's own crate: taken, it comes back after a while instead of dying. */
  permanent: boolean;
  /** Tick at which a taken permanent crate reappears; 0 while it is out. */
  hiddenUntil: number;
}

/** A permanent floor mark. The client stamps these into its floor layer. */
export interface Decal {
  /** Monotonic; the client stamps everything newer than what it last saw. */
  seq: number;
  /** Tick it was laid down on, so a predicting client can tell a guess from a fact. */
  tick: number;
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
  /** Damage to breakable walls in range; usually the same as `damage`. */
  wallDamage: number;
  ownerId: number;
  cluster: boolean;
  /** Follow-up blasts still to queue when this one resolves. */
  extraBlasts: number;
  /** Ticks to wait before resolving; the visuals appear when it does. */
  delay: number;
  /** The blast's picture and sound are still owed, for a delayed blast. */
  announce: boolean;
  /** Prevents a chain reaction from recursing without bound. */
  depth: number;
  /** What set the blast off, for the run's statistics; null for a devil's fire or a room barrel. */
  weapon: WeaponId | null;
}

/** Tallies kept for the debrief. They never influence the simulation. */
export interface RunStats {
  /** Trigger pulls that loosed a projectile (a shotgun blast counts once). */
  shotsFired: number;
  /** Shots that struck a creature at least once. */
  shotsHit: number;
  longestStreak: number;
  killsByWeapon: Partial<Record<WeaponId, number>>;
}

/** Transient banner text, e.g. a level heading or an upgrade award. */
export interface Message {
  /** Monotonic per world, so a server can forward only what is new. */
  seq: number;
  text: string;
  kind: 'level' | 'upgrade' | 'info' | 'critical';
  /** Ticks remaining on screen. */
  life: number;
}

/** A floating score or multi-kill popup. */
export interface Popup {
  /** Monotonic per world, so a server can forward only what is new. */
  seq: number;
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
  /** Player entity id that caused the sound, or -1; lets a client skip sounds it already predicted. */
  ownerId: number;
}
