/**
 * The arsenal.
 *
 * Weapon slots and names come straight out of the original's bytecode: the
 * upgrade banners it ships name each key, from "New Weapon: UZI (Key 2)"
 * through "New Weapon: Railgun (Key 0)".
 *
 * Definitions are frozen. Upgrades never mutate them -- they contribute
 * multipliers to a separate stats block that is recomputed from scratch, which
 * keeps upgrades order-independent and testable. See upgrades.ts.
 */

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

export type ShotKind = 'bullet' | 'pellet' | 'rocket' | 'grenade' | 'railgun' | 'place';

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
  /** Fires on release rather than press (grenade charging). */
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

/**
 * Ordered by slot. Values are tuned so the pistol reads as deliberate, the UZI
 * as a hose, and the shotgun as a panic button.
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    shortName: 'PSTL',
    slot: 1,
    fireRate: 9,
    auto: true,
    onRelease: false,
    totalAmmo: 0,
    infiniteAmmo: true,
    shots: 1,
    spread: 0.015,
    damage: 34,
    range: 420,
    speed: 18,
    kind: 'bullet',
    knockback: 1.1,
    shake: 1.2,
  },
  uzi: {
    id: 'uzi',
    name: 'UZI',
    shortName: 'UZI',
    slot: 2,
    fireRate: 3,
    auto: true,
    onRelease: false,
    totalAmmo: 250,
    infiniteAmmo: false,
    shots: 1,
    spread: 0.07,
    damage: 18,
    range: 380,
    speed: 20,
    kind: 'bullet',
    knockback: 0.6,
    shake: 0.8,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    shortName: 'SHTG',
    slot: 3,
    fireRate: 22,
    auto: true,
    onRelease: false,
    totalAmmo: 40,
    infiniteAmmo: false,
    shots: 6,
    spread: 0.3,
    damage: 22,
    range: 250,
    speed: 16,
    kind: 'pellet',
    knockback: 2.4,
    shake: 4,
  },
  barrel: {
    id: 'barrel',
    name: 'Barrel',
    shortName: 'BRRL',
    slot: 4,
    fireRate: 25,
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
    splash: { radius: 110, damage: 220 },
  },
  grenade: {
    id: 'grenade',
    name: 'Grenade',
    shortName: 'GRND',
    slot: 5,
    fireRate: 30,
    auto: false,
    onRelease: true,
    totalAmmo: 15,
    infiniteAmmo: false,
    shots: 1,
    spread: 0.02,
    damage: 0,
    range: 600,
    speed: 7,
    kind: 'grenade',
    knockback: 0,
    shake: 0,
    fuse: 90,
    splash: { radius: 100, damage: 250 },
  },
  fakewall: {
    id: 'fakewall',
    name: 'Fake walls',
    shortName: 'WALL',
    slot: 6,
    fireRate: 12,
    auto: false,
    onRelease: false,
    totalAmmo: 25,
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
    fireRate: 25,
    auto: false,
    onRelease: false,
    totalAmmo: 12,
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
    armTime: 25,
    triggerRadius: 45,
    splash: { radius: 85, damage: 300 },
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket',
    shortName: 'RCKT',
    slot: 8,
    fireRate: 32,
    auto: false,
    onRelease: false,
    totalAmmo: 20,
    infiniteAmmo: false,
    shots: 1,
    spread: 0.01,
    damage: 120,
    range: 700,
    speed: 11,
    kind: 'rocket',
    knockback: 3,
    shake: 6,
    splash: { radius: 120, damage: 180 },
  },
  chargepack: {
    id: 'chargepack',
    name: 'Chargepack',
    shortName: 'CHRG',
    slot: 9,
    fireRate: 30,
    auto: false,
    onRelease: false,
    totalAmmo: 6,
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
    fuse: 150,
    splash: { radius: 175, damage: 600 },
  },
  railgun: {
    id: 'railgun',
    name: 'Railgun',
    shortName: 'RAIL',
    slot: 0,
    fireRate: 45,
    auto: false,
    onRelease: false,
    totalAmmo: 12,
    infiniteAmmo: false,
    shots: 1,
    spread: 0,
    damage: 400,
    range: 900,
    speed: 46,
    kind: 'railgun',
    knockback: 4,
    shake: 8,
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

/** Barricade hit points, used when a fake wall is placed. */
export const FAKE_WALL_HP = 300;
