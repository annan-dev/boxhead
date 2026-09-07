/**
 * Rewards, as the original hands them out.
 *
 * Recovered from `CUpgrades.InitLists` and `CUpgrades.ApplyUpgrade_Weapon` in
 * the SWF. The original does not award anything by level: each entry below is
 * granted the moment the score multiplier reaches its threshold, and it is
 * then kept for the rest of the run. Getting the UZI means holding a five-kill
 * streak; the railgun means reaching x70. Banner text is the original's,
 * including its "Infinate" spelling.
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
  | { kind: 'weapon'; multiplier: number; weapon: WeaponId; message: string }
  | { kind: 'upgrade'; multiplier: number; weapon: WeaponId; upgrade: UpgradeId; message: string };

const weapon = (multiplier: number, id: WeaponId, key: string): Award => ({
  kind: 'weapon',
  multiplier,
  weapon: id,
  message: `New Weapon: ${WEAPONS[id].name} (Key ${key})`,
});

const up = (
  multiplier: number,
  id: WeaponId,
  upgrade: UpgradeId,
  label: string,
  prefix?: string,
): Award => ({
  kind: 'upgrade',
  multiplier,
  weapon: id,
  upgrade,
  message: `${prefix ?? WEAPONS[id].name}+: ${label}`,
});

/** The full progression: multiplier threshold, then the award. */
export const AWARD_SEQUENCE: Award[] = [
  up(3, 'pistol', 'FastFire', 'Fast Fire'),
  weapon(5, 'uzi', '2'),
  up(8, 'pistol', 'DoubleDamage', 'Double Damage'),
  weapon(10, 'shotgun', '3'),
  up(13, 'uzi', 'RapidFire', 'Rapid Fire'),
  weapon(15, 'barrel', '4'),
  up(17, 'uzi', 'DoubleAmmo', 'Double Ammo'),
  up(18, 'shotgun', 'FastFire', 'Fast Fire'),
  weapon(20, 'grenade', '5'),
  up(21, 'shotgun', 'DoubleAmmo', 'Double Ammo'),
  up(23, 'uzi', 'LongShot', 'Long Shot'),
  up(26, 'barrel', 'DoubleAmmo', 'Double Ammo'),
  weapon(30, 'fakewall', '6'),
  up(31, 'shotgun', 'WideShot', 'Wide Shot'),
  up(32, 'barrel', 'BigBang', 'Big Bang'),
  up(33, 'grenade', 'ClusterExplode', 'Cluster Explode'),
  up(35, 'shotgun', 'LongShot', 'Long Shot'),
  up(36, 'barrel', 'QuadAmmo', 'Quad Ammo'),
  up(37, 'fakewall', 'DoubleAmmo', 'Double Ammo', 'Fake Wall'),
  up(39, 'uzi', 'QuadAmmo', 'Quad Ammo'),
  weapon(40, 'mine', '7'),
  up(41, 'shotgun', 'QuadAmmo', 'Quad Ammo'),
  up(42, 'grenade', 'DoubleAmmo', 'Double Ammo'),
  up(43, 'shotgun', 'RapidFire', 'Rapid Fire'),
  up(44, 'barrel', 'BiggerBang', 'Bigger Bang'),
  up(45, 'grenade', 'BigBang', 'Big Bang'),
  up(47, 'mine', 'ClusterExplode', 'Cluster Explode'),
  up(48, 'uzi', 'DoubleDamage', 'Double Damage'),
  weapon(50, 'rocket', '8'),
  up(51, 'shotgun', 'WiderShot', 'Wider Shot'),
  up(52, 'grenade', 'QuadAmmo', 'Quad Ammo'),
  up(53, 'fakewall', 'QuadAmmo', 'Quad Ammo', 'Fake Wall'),
  up(54, 'mine', 'DoubleAmmo', 'Double Ammo'),
  weapon(55, 'chargepack', '9'),
  up(56, 'shotgun', 'DoubleDamage', 'Double Damage'),
  up(57, 'grenade', 'BiggerBang', 'Bigger Bang'),
  up(58, 'mine', 'BigBang', 'Big Bang'),
  up(59, 'rocket', 'FastFire', 'Fast Fire'),
  // The original's spelling, preserved.
  up(61, 'uzi', 'InfiniteRange', 'Infinate Range'),
  up(62, 'mine', 'BiggerBang', 'Bigger Bang'),
  up(63, 'chargepack', 'ClusterExplode', 'Cluster Explode', 'Charge Pack'),
  up(64, 'mine', 'QuadAmmo', 'Quad Ammo'),
  up(66, 'rocket', 'DoubleAmmo', 'Double Ammo'),
  up(68, 'chargepack', 'DoubleAmmo', 'Double Ammo', 'Charge Pack'),
  weapon(70, 'railgun', '0'),
  up(72, 'rocket', 'BigBang', 'Big Bang'),
  up(74, 'chargepack', 'BigBang', 'Big Bang', 'Charge Pack'),
  up(76, 'chargepack', 'QuadAmmo', 'Quad Ammo', 'Charge Pack'),
  up(78, 'railgun', 'FastFire', 'Fast Fire'),
  up(80, 'railgun', 'DoubleAmmo', 'Double Ammo'),
  up(85, 'rocket', 'QuadAmmo', 'Quad Ammo'),
  up(90, 'uzi', 'QuadDamage', 'Quad Damage'),
  up(95, 'chargepack', 'BiggerBang', 'Bigger Bang', 'Charge Pack'),
  up(100, 'railgun', 'RapidFire', 'Rapid Fire'),
  up(105, 'rocket', 'BiggerBang', 'Bigger Bang'),
  up(110, 'railgun', 'QuadAmmo', 'Quad Ammo'),
  up(120, 'rocket', 'RapidFire', 'Rapid Fire'),
  up(125, 'railgun', 'LongShot', 'Long Shot'),
];

/** Awards whose threshold lies in (previous, multiplier], in order. */
export function awardsBetween(previous: number, multiplier: number): Award[] {
  return AWARD_SEQUENCE.filter((a) => a.multiplier > previous && a.multiplier <= multiplier);
}

/** The next award still ahead of a multiplier, for the HUD. */
export function nextAward(multiplier: number): Award | undefined {
  return AWARD_SEQUENCE.find((a) => a.multiplier > multiplier);
}

/**
 * Per-weapon effects, recomputed from the held upgrade set. The original's
 * rules: damage and ammo tiers do not stack (the best held one applies),
 * Fast Fire only makes a weapon automatic, Rapid Fire quarters the interval
 * (never below two original ticks) and makes it automatic, the bang tiers
 * and shot widths likewise take the best held.
 */
export interface WeaponStats {
  damageMul: number;
  /** Ticks between shots, or null to use the weapon's own. */
  fireRate: number | null;
  /** Fires while held, regardless of the weapon's own setting. */
  auto: boolean;
  /** 0, 1 (Wide Shot) or 2 (Wider Shot): more, wider shotgun rays. */
  wideShot: number;
  /**
   * Big Bang and Bigger Bang (`CThing_Effect_Explosion.Process_Init`): the
   * blast is not larger, it is followed by two or three more full blasts a
   * cell away, each a few ticks later. This is that count.
   */
  extraBlasts: number;
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
    fireRate: null,
    auto: false,
    wideShot: 0,
    extraBlasts: 0,
    ammoMul: 1,
    rangeMul: 1,
    infiniteAmmo: false,
    cluster: false,
    homing: false,
  };
}

function applyUpgrade(
  stats: WeaponStats,
  upgrade: UpgradeId,
  weapon: WeaponId,
  player: { speedMul: number },
): void {
  switch (upgrade) {
    case 'FastFire':
      stats.auto = true;
      break;
    case 'RapidFire':
      stats.auto = true;
      // Original: round(max(fireRate / 4, 2)) in 25Hz ticks.
      stats.fireRate = Math.round(Math.max(WEAPONS[weapon].fireRate / 4, 4));
      break;
    case 'DoubleDamage':
      stats.damageMul = Math.max(stats.damageMul, 2);
      break;
    case 'QuadDamage':
      stats.damageMul = Math.max(stats.damageMul, 4);
      break;
    case 'FatalDamage':
      stats.damageMul = Math.max(stats.damageMul, 10);
      break;
    case 'DoubleAmmo':
      stats.ammoMul = Math.max(stats.ammoMul, 2);
      break;
    case 'QuadAmmo':
      stats.ammoMul = Math.max(stats.ammoMul, 4);
      break;
    case 'InfiniteAmmo':
      stats.infiniteAmmo = true;
      break;
    case 'WideShot':
      stats.wideShot = Math.max(stats.wideShot, 1);
      break;
    case 'WiderShot':
      stats.wideShot = Math.max(stats.wideShot, 2);
      break;
    case 'LongShot':
      stats.rangeMul = Math.max(stats.rangeMul, 1.5);
      break;
    case 'InfiniteRange':
      // Original: range 100 cells.
      stats.rangeMul = Math.max(stats.rangeMul, 99);
      break;
    case 'BigBang':
      stats.extraBlasts = Math.max(stats.extraBlasts, 2);
      break;
    case 'BiggerBang':
      stats.extraBlasts = Math.max(stats.extraBlasts, 3);
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
    applyUpgrade(stats, entry.upgrade, entry.weapon, player);
  }
  return { speedMul: player.speedMul, perWeapon };
}

export function statsFor(stats: PlayerStats, id: WeaponId): WeaponStats {
  return stats.perWeapon.get(id) ?? identityWeaponStats();
}

/**
 * The banner the original showed on reaching a new level. Its tables end at
 * level 100; past that the heading says so.
 */
export function levelBanner(level: number): string {
  return level > 100 ? `-+-+-+- LEVEL ${level} (FOREVER) -+-+-+-` : `-+-+-+- LEVEL ${level} -+-+-+-`;
}

/** Ammo tiers a weapon may hold; any award to that weapon refills it to capacity. */
export function holdsAmmoTier(held: ReadonlyArray<{ weapon: WeaponId; upgrade: UpgradeId }>, weapon: WeaponId): boolean {
  return held.some((h) => h.weapon === weapon && (h.upgrade === 'DoubleAmmo' || h.upgrade === 'QuadAmmo'));
}
