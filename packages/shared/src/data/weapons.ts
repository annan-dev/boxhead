/**
 * The arsenal, with the original's numbers.
 *
 * Slots and names come from the upgrade banners in the SWF's constant pool;
 * fire rates, ammo, damage and ranges were recovered from each
 * `CThing_Weapon_*` constructor, and the projectile behaviour from the
 * `CThing_Shot_*` classes. Original fire rates are 25Hz ticks and ranges are
 * cells, converted here to 50Hz ticks and pixels.
 *
 * Bullets in the original are hitscan: a line is cast to the weapon's range
 * on the tick of firing and drawn for a moment. `hitscan` weapons here do the
 * same, sweeping their whole range in a single step.
 *
 * Definitions are frozen. Upgrades never mutate them -- they contribute to a
 * separate stats block that is recomputed from scratch, which keeps upgrades
 * order-independent and testable. See upgrades.ts.
 */
import { ORIGINAL_CELL, ORIGINAL_TICK_RATIO } from './tuning.js';

export type WeaponId =
  | 'pistol'
  | 'uzi'
  | 'shotgun'
  | 'barrel'
  | 'grenade'
  | 'fakewall'
  | 'mine'
  | 'rocket'
  | 'chargepack'
  | 'railgun';

export type ShotKind = 'bullet' | 'pellet' | 'rocket' | 'grenade' | 'railgun' | 'fireball' | 'place';

export interface WeaponDef {
  id: WeaponId;
  /** Display name, as used in the upgrade banners. */
  name: string;
  /** Short label for the weapon strip. */
  shortName: string;
  /** Keyboard slot, 1-9 then 0. */
  slot: number;
  /** Ticks between shots. */
  fireRate: number;
  /** Fires continuously while held. */
  auto: boolean;
  /** Fires on release rather than press, charging while held (grenades). */
  onRelease: boolean;
  /** Ammo granted when the weapon is acquired or picked up. */
  totalAmmo: number;
  infiniteAmmo: boolean;
  /** Projectiles per trigger pull. */
  shots: number;
  /** Half-angle of the firing cone, in radians. */
  spread: number;
  damage: number;
  /** Pixels before the projectile expires. */
  range: number;
  /** Pixels per tick. */
  speed: number;
  kind: ShotKind;
  knockback: number;
  /** Screen shake added on firing. */
  shake: number;
  /** The whole range resolves on the tick of firing. */
  hitscan?: boolean;
  /**
   * Blast on detonation. Radius follows the original's damage-based formula
   * and is never scaled; the bang upgrades add further blasts instead.
   */
  splash?: { radius: number; damage: number };
  /** Ticks before a thrown or placed object detonates. */
  fuse?: number;
  /** Ticks before a mine becomes live. */
  armTime?: number;
  /** Proximity radius that sets off a mine. */
  triggerRadius?: number;
  /** Passes through targets rather than stopping at the first. */
  pierce?: boolean;
  /** Places a world object instead of firing a projectile. */
  places?: 'barrel' | 'mine' | 'fakewall' | 'chargepack';
}

const ticks = (original: number): number => original * ORIGINAL_TICK_RATIO;
const cells = (original: number): number => original * ORIGINAL_CELL;

/**
 * `CThing_Effect_Explosion`: a blast reaches two cells, plus half a percent of
 * a cell for every point of damage above 100.
 */
export function explosionRadius(damage: number): number {
  return cells(2 + Math.max(0, damage - 100) * 0.005);
}

/** Splash damage tiers by distance: full inside half the radius, then 75%, then 50%. */
export function explosionFalloff(distanceRatio: number): number {
  if (distanceRatio <= 0.5) return 1;
  if (distanceRatio <= 0.75) return 0.75;
  return 0.5;
}

const blast = (damage: number): { radius: number; damage: number } => ({
  radius: explosionRadius(damage),
  damage,
});

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    shortName: 'PSTL',
    slot: 1,
    fireRate: ticks(8),
    auto: false,
    onRelease: false,
    totalAmmo: 0,
    infiniteAmmo: true,
    shots: 1,
    spread: 0,
    damage: 26,
    range: cells(8),
    speed: cells(8),
    kind: 'bullet',
    knockback: 1.1,
    shake: 1.2,
    hitscan: true,
  },
  uzi: {
    id: 'uzi',
    name: 'UZI',
    shortName: 'UZI',
    slot: 2,
    fireRate: ticks(4),
    auto: true,
    onRelease: false,
    totalAmmo: 100,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 35,
    range: cells(8),
    speed: cells(8),
    kind: 'bullet',
    knockback: 0.6,
    shake: 0.8,
    hitscan: true,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    shortName: 'SHTG',
    slot: 3,
    fireRate: ticks(12),
    auto: false,
    onRelease: false,
    totalAmmo: 20,
    infiniteAmmo: false,
    // Three rays: straight ahead and 1.25 degrees to either side.
    shots: 3,
    spread: (1.25 * Math.PI) / 180,
    damage: 51,
    range: cells(7),
    speed: cells(7),
    kind: 'pellet',
    knockback: 2.4,
    shake: 4,
    hitscan: true,
  },
  barrel: {
    id: 'barrel',
    name: 'Barrel',
    shortName: 'BRRL',
    slot: 4,
    fireRate: ticks(1),
    auto: false,
    onRelease: false,
    totalAmmo: 10,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 0,
    range: 0,
    speed: 0,
    kind: 'place',
    knockback: 0,
    shake: 0,
    places: 'barrel',
    splash: blast(150),
  },
  grenade: {
    id: 'grenade',
    name: 'Grenade',
    shortName: 'GRND',
    slot: 5,
    fireRate: ticks(12),
    auto: false,
    onRelease: true,
    totalAmmo: 20,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 0,
    range: 9999,
    // Throw power scales with hold time; this is the full-power pace.
    speed: cells(0.75) / ORIGINAL_TICK_RATIO,
    kind: 'grenade',
    knockback: 0,
    shake: 0,
    fuse: ticks(60),
    splash: blast(150),
  },
  fakewall: {
    id: 'fakewall',
    name: 'Fake walls',
    shortName: 'WALL',
    slot: 6,
    fireRate: ticks(1),
    auto: false,
    onRelease: false,
    totalAmmo: 5,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 0,
    range: 0,
    speed: 0,
    kind: 'place',
    knockback: 0,
    shake: 0,
    places: 'fakewall',
  },
  mine: {
    id: 'mine',
    name: 'Claymore',
    shortName: 'MINE',
    slot: 7,
    fireRate: ticks(1),
    auto: false,
    onRelease: false,
    totalAmmo: 10,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 0,
    range: 0,
    speed: 0,
    kind: 'place',
    knockback: 0,
    shake: 0,
    places: 'mine',
    armTime: 0,
    triggerRadius: 20,
    // Triggered by a body on its cell, then two seconds of beeping.
    fuse: ticks(50),
    splash: blast(100),
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket',
    shortName: 'RCKT',
    slot: 8,
    fireRate: ticks(12),
    auto: false,
    onRelease: false,
    totalAmmo: 20,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 0,
    range: 9999,
    // Launches at half a cell per original tick and accelerates in flight.
    speed: cells(0.5) / ORIGINAL_TICK_RATIO,
    kind: 'rocket',
    knockback: 3,
    shake: 6,
    splash: blast(250),
  },
  chargepack: {
    id: 'chargepack',
    name: 'Chargepack',
    shortName: 'CHRG',
    slot: 9,
    fireRate: ticks(1),
    auto: false,
    onRelease: false,
    totalAmmo: 10,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 0,
    range: 0,
    speed: 0,
    kind: 'place',
    knockback: 0,
    shake: 0,
    places: 'chargepack',
    // Detonated by hand: pressing fire again sets every pack off.
    fuse: ticks(2.5),
    splash: blast(150),
  },
  railgun: {
    id: 'railgun',
    name: 'Railgun',
    shortName: 'RAIL',
    slot: 0,
    fireRate: ticks(5),
    auto: false,
    onRelease: false,
    totalAmmo: 15,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 100,
    range: cells(10),
    speed: cells(10),
    kind: 'railgun',
    knockback: 4,
    shake: 8,
    hitscan: true,
    pierce: true,
  },
};

/** Slot order used by the weapon strip and the number keys. */
export const WEAPON_ORDER: WeaponId[] = [
  'pistol',
  'uzi',
  'shotgun',
  'barrel',
  'grenade',
  'fakewall',
  'mine',
  'rocket',
  'chargepack',
  'railgun',
];

/** Which rig overlay a weapon uses; several share the same held pose. */
export const WEAPON_RIG: Record<WeaponId, string> = {
  pistol: 'Player_Handgun',
  uzi: 'Player_UZI',
  shotgun: 'Player_Shotgun',
  barrel: 'Player_Handgun',
  grenade: 'Player_Handgun',
  fakewall: 'Player_Handgun',
  mine: 'Player_Handgun',
  rocket: 'Player_Rocket',
  chargepack: 'Player_Handgun',
  railgun: 'Player_Railgun',
};

export function weaponBySlot(slot: number): WeaponDef | undefined {
  return WEAPON_ORDER.map((id) => WEAPONS[id]).find((w) => w.slot === slot);
}

/** Barricade hit points (original: 1000; twenty zombie bites). */
export const FAKE_WALL_HP = 1000;

/** Grenade flight: a lob that falls and bounces, in pixels and ticks. */
export const GRENADE = {
  /** Launch height. */
  startZ: 40,
  /** Upward pace at launch; the original's 0.5 cells per 25Hz tick. */
  launchVz: cells(0.5) / ORIGINAL_TICK_RATIO,
  /** Gravity per tick. */
  gravity: (cells(0.06) / ORIGINAL_TICK_RATIO) / ORIGINAL_TICK_RATIO,
  /** Velocity kept on a floor bounce. */
  floorBounce: 0.5,
  /** Velocity kept on a wall bounce. */
  wallBounce: 0.25,
  /**
   * On the ground the original halves the whole velocity every tick
   * (`Process_Normal`: `delta.ScaleN(0.5)` while `z + dz < 0`), so a grenade
   * stops within a few ticks of landing. Per simulation tick.
   */
  groundDrag: Math.sqrt(0.5),
  /**
   * Hold time, in ticks, at which the throw reaches full power: the original
   * clamps seconds held to 0.25..0.75 (`CThing_Weapon_Grenade.Fire`).
   */
  chargeTicks: Math.round(0.75 * 25 * ORIGINAL_TICK_RATIO),
  minPower: 0.25 / 0.75,
} as const;

/**
 * Cluster Explode (`CThing_Effect_Explosion.Process_Init`): the blast throws
 * four shells, one per quadrant with a little jitter, that fly like slow
 * grenades and burst with the parent's full damage when their fuse runs out.
 * All from `CThing_Shot_ClusterShell`, in 25Hz ticks and cells.
 */
export const CLUSTER_SHELL = {
  count: 4,
  /** Angular jitter either side of each quadrant, in radians (22.5 degrees). */
  jitter: (22.5 * Math.PI) / 180,
  /** Horizontal pace at launch: 0.05 + random 0.05 cells per original tick. */
  minSpeed: cells(0.05) / ORIGINAL_TICK_RATIO,
  maxSpeed: cells(0.1) / ORIGINAL_TICK_RATIO,
  /** Upward pace at launch, half a cell per original tick. */
  launchVz: cells(0.5) / ORIGINAL_TICK_RATIO,
  /** Fuse: 16 plus random 0..7 original ticks. */
  minFuse: ticks(16),
  maxFuse: ticks(23),
} as const;

/**
 * Big Bang / Bigger Bang: the extra blasts land one cell out from the first,
 * spread evenly around it with a little jitter, each 2..5 original ticks
 * later, and never spawn extras of their own.
 */
export const EXTRA_BLAST = {
  distance: cells(1),
  minDelay: ticks(2),
  maxDelay: ticks(5),
} as const;

/**
 * A barrel caught in a blast goes up on its own next process step, which is
 * one original tick after the blast that reached it.
 */
export const CHAIN_DELAY_TICKS = ticks(1);

/**
 * Barrels the room starts with are built without a damage argument, and the
 * class defaults them to 100 (`CThing_Object_Barrel` constructor); placed
 * barrels carry the weapon's 150.
 */
export const ROOM_BARREL_DAMAGE = 100;

/** Rocket flight: accelerates every tick (original: x1.1 per 25Hz tick). */
export const ROCKET_ACCELERATION = Math.sqrt(1.1);

/**
 * Rocket exhaust. The original drops one smoke puff at the rocket every 25Hz
 * tick; each drifts back at half a cell per tick, gaining x1.2 per tick, and
 * plays its six-frame clip once.
 */
export const ROCKET_SMOKE = {
  /** Ticks between puffs. */
  every: ORIGINAL_TICK_RATIO,
  /** Puff lifetime in ticks: six original frames. */
  life: 6 * ORIGINAL_TICK_RATIO,
  /** Initial drift, backwards along the rocket's path, in pixels per tick. */
  speed: cells(0.5) / ORIGINAL_TICK_RATIO,
  /** Drift growth per tick. */
  growth: Math.sqrt(1.2),
} as const;

/**
 * Effect lifetimes in ticks, from the original's clip lengths and play rates:
 * a muzzle flash is one 25Hz frame, an explosion runs its 18 frames at 2.5
 * per tick, a bullet puff and a smoke cloud play one frame per tick, and a
 * hitscan tracer lingers two ticks.
 */
export const EFFECT_TICKS = {
  muzzle: 1 * ORIGINAL_TICK_RATIO,
  explosion: Math.ceil(18 / 2.5) * ORIGINAL_TICK_RATIO,
  bulletHit: 13 * ORIGINAL_TICK_RATIO,
  smokeCloud: 15 * ORIGINAL_TICK_RATIO,
  blood: 10 * ORIGINAL_TICK_RATIO,
  tracer: 2 * ORIGINAL_TICK_RATIO,
} as const;
