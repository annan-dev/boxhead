/**
 * Level-up rewards.
 *
 * The award list below is the original's, recovered verbatim from the SWF
 * constant pool and kept in its original order -- including the banner text and
 * its "Infinate" misspelling, which is what players actually saw on screen.
 *
 * The important design rule: an upgrade never mutates a WeaponDef. Each one
 * contributes to a stats block that is recomputed from scratch whenever the
 * held set changes, so upgrades are order-independent, idempotent, and can be
 * unit-tested without constructing a world.
 */
import type { WeaponId } from './weapons.js';
import { WEAPONS } from './weapons.js';

export type UpgradeId =
  | 'FastFire'
  | 'RapidFire'
  | 'DoubleDamage'
  | 'QuadDamage'
  | 'FatalDamage'
  | 'DoubleAmmo'
  | 'QuadAmmo'
  | 'InfiniteAmmo'
  | 'WideShot'
  | 'WiderShot'
  | 'LongShot'
  | 'InfiniteRange'
  | 'BigBang'
  | 'BiggerBang'
  | 'ClusterExplode'
  | 'HomingMissiles'
  | 'SpeedUp';

export type Award =
  | { kind: 'weapon'; weapon: WeaponId; message: string }
  | { kind: 'upgrade'; weapon: WeaponId; upgrade: UpgradeId; message: string };

const weapon = (id: WeaponId, key: string): Award => ({
  kind: 'weapon',
  weapon: id,
  message: `New Weapon: ${WEAPONS[id].name} (Key ${key})`,
});

const up = (id: WeaponId, upgrade: UpgradeId, label: string, prefix?: string): Award => ({
  kind: 'upgrade',
  weapon: id,
  upgrade,
  message: `${prefix ?? WEAPONS[id].name}+: ${label}`,
});

/**
 * The full progression, in the original's order. Levels draw from this list in
 * sequence, so the early game unlocks quickly and the late game settles into
 * damage and ammo multipliers.
 */
export const AWARD_SEQUENCE: Award[] = [
  up('pistol', 'FastFire', 'Fast Fire'),
  weapon('uzi', '2'),
  up('pistol', 'DoubleDamage', 'Double Damage'),
  weapon('shotgun', '3'),
  up('uzi', 'RapidFire', 'Rapid Fire'),
  weapon('barrel', '4'),
  up('uzi', 'DoubleAmmo', 'Double Ammo'),
  up('shotgun', 'FastFire', 'Fast Fire'),
  weapon('grenade', '5'),
  up('shotgun', 'DoubleAmmo', 'Double Ammo'),
  up('uzi', 'LongShot', 'Long Shot'),
  up('barrel', 'DoubleAmmo', 'Double Ammo'),
  weapon('fakewall', '6'),
  up('shotgun', 'WideShot', 'Wide Shot'),
  up('barrel', 'BigBang', 'Big Bang'),
  up('grenade', 'ClusterExplode', 'Cluster Explode'),
  up('shotgun', 'LongShot', 'Long Shot'),
  up('barrel', 'QuadAmmo', 'Quad Ammo'),
  up('fakewall', 'DoubleAmmo', 'Double Ammo', 'Fake Wall'),
  up('uzi', 'QuadAmmo', 'Quad Ammo'),
  weapon('mine', '7'),
  up('shotgun', 'QuadAmmo', 'Quad Ammo'),
  up('grenade', 'DoubleAmmo', 'Double Ammo'),
  up('shotgun', 'RapidFire', 'Rapid Fire'),
  up('barrel', 'BiggerBang', 'Bigger Bang'),
  up('grenade', 'BigBang', 'Big Bang'),
  up('mine', 'ClusterExplode', 'Cluster Explode'),
  up('uzi', 'DoubleDamage', 'Double Damage'),
  weapon('rocket', '8'),
  up('shotgun', 'WiderShot', 'Wider Shot'),
  up('grenade', 'QuadAmmo', 'Quad Ammo'),
  up('fakewall', 'QuadAmmo', 'Quad Ammo', 'Fake Wall'),
  up('mine', 'DoubleAmmo', 'Double Ammo'),
  weapon('chargepack', '9'),
  up('shotgun', 'DoubleDamage', 'Double Damage'),
  up('grenade', 'BiggerBang', 'Bigger Bang'),
  up('mine', 'BigBang', 'Big Bang'),
  up('rocket', 'FastFire', 'Fast Fire'),
  // The original's spelling, preserved.
  up('uzi', 'InfiniteRange', 'Infinate Range'),
  up('mine', 'BiggerBang', 'Bigger Bang'),
  up('chargepack', 'ClusterExplode', 'Cluster Explode', 'Charge Pack'),
  up('mine', 'QuadAmmo', 'Quad Ammo'),
  up('rocket', 'DoubleAmmo', 'Double Ammo'),
  up('chargepack', 'DoubleAmmo', 'Double Ammo', 'Charge Pack'),
  weapon('railgun', '0'),
  up('rocket', 'BigBang', 'Big Bang'),
  up('chargepack', 'BigBang', 'Big Bang', 'Charge Pack'),
  up('chargepack', 'QuadAmmo', 'Quad Ammo', 'Charge Pack'),
  up('railgun', 'FastFire', 'Fast Fire'),
  up('railgun', 'DoubleAmmo', 'Double Ammo'),
  up('rocket', 'QuadAmmo', 'Quad Ammo'),
  up('uzi', 'QuadDamage', 'Quad Damage'),
  up('chargepack', 'BiggerBang', 'Bigger Bang', 'Charge Pack'),
  up('railgun', 'RapidFire', 'Rapid Fire'),
  up('rocket', 'BiggerBang', 'Bigger Bang'),
  up('railgun', 'QuadAmmo', 'Quad Ammo'),
  up('rocket', 'RapidFire', 'Rapid Fire'),
  up('railgun', 'LongShot', 'Long Shot'),
];

/** Awards granted on reaching a level. Level 1 is the starting state. */
export function awardsForLevel(level: number): Award[] {
  if (level < 2) return [];
  // Two awards per level keeps the original's brisk early unlock pace.
  const start = (level - 2) * 2;
  return AWARD_SEQUENCE.slice(start, start + 2);
}

/** Per-weapon multipliers, recomputed from the held upgrade set. */
export interface WeaponStats {
  damageMul: number;
  fireRateMul: number;
  spreadMul: number;
  shotsAdd: number;
  splashRadiusMul: number;
  ammoMul: number;
  rangeMul: number;
  infiniteAmmo: boolean;
  cluster: boolean;
  homing: boolean;
}

export interface PlayerStats {
  speedMul: number;
  perWeapon: Map<WeaponId, WeaponStats>;
}

function identityWeaponStats(): WeaponStats {
  return {
    damageMul: 1,
    fireRateMul: 1,
    spreadMul: 1,
    shotsAdd: 0,
    splashRadiusMul: 1,
    ammoMul: 1,
    rangeMul: 1,
    infiniteAmmo: false,
    cluster: false,
    homing: false,
  };
}

function applyUpgrade(stats: WeaponStats, upgrade: UpgradeId, player: { speedMul: number }): void {
  switch (upgrade) {
    case 'FastFire':
      stats.fireRateMul *= 0.8;
      break;
    case 'RapidFire':
      stats.fireRateMul *= 0.6;
      break;
    case 'DoubleDamage':
      stats.damageMul *= 2;
      break;
    case 'QuadDamage':
      stats.damageMul *= 4;
      break;
    case 'FatalDamage':
      stats.damageMul *= 8;
      break;
    case 'DoubleAmmo':
      stats.ammoMul *= 2;
      break;
    case 'QuadAmmo':
      stats.ammoMul *= 4;
      break;
    case 'InfiniteAmmo':
      stats.infiniteAmmo = true;
      break;
    case 'WideShot':
      stats.spreadMul *= 1.5;
      stats.shotsAdd += 2;
      break;
    case 'WiderShot':
      stats.spreadMul *= 2.2;
      stats.shotsAdd += 4;
      break;
    case 'LongShot':
      stats.rangeMul *= 1.6;
      break;
    case 'InfiniteRange':
      stats.rangeMul *= 99;
      break;
    case 'BigBang':
      stats.splashRadiusMul *= 1.4;
      break;
    case 'BiggerBang':
      stats.splashRadiusMul *= 2;
      break;
    case 'ClusterExplode':
      stats.cluster = true;
      break;
    case 'HomingMissiles':
      stats.homing = true;
      break;
    case 'SpeedUp':
      player.speedMul *= 1.15;
      break;
  }
}

/**
 * Rebuild the stats block from the full held set. Always call this rather than
 * mutating incrementally, so the result never depends on award order.
 */
export function computeStats(held: ReadonlyArray<{ weapon: WeaponId; upgrade: UpgradeId }>): PlayerStats {
  const perWeapon = new Map<WeaponId, WeaponStats>();
  const player = { speedMul: 1 };
  for (const entry of held) {
    let stats = perWeapon.get(entry.weapon);
    if (!stats) {
      stats = identityWeaponStats();
      perWeapon.set(entry.weapon, stats);
    }
    applyUpgrade(stats, entry.upgrade, player);
  }
  return { speedMul: player.speedMul, perWeapon };
}

export function statsFor(stats: PlayerStats, id: WeaponId): WeaponStats {
  return stats.perWeapon.get(id) ?? identityWeaponStats();
}

/** The banner the original showed on reaching a new level. */
export function levelBanner(level: number): string {
  return `-+-+-+- LEVEL ${level} -+-+-+-`;
}
