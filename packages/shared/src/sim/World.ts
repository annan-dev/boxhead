/**
 * The simulation.
 *
 * Headless and deterministic: no DOM, no canvas, no wall-clock reads, and every
 * random draw comes from a seeded generator. The same module runs in the
 * browser for single player today and can run as the authority on a server
 * later, with clients predicting against it -- which is why input arrives as
 * commands and why state is kept flat and snapshot-friendly.
 *
 * Ordering is explicit. `step` runs a fixed list of phases, and the phase list
 * is the single source of truth for what happens when; bugs that come from
 * emergent ordering are the hardest kind to reproduce, so there is none of it.
 */
import { CELL_SIZE, GameMap, Tile, type RoomDef } from '../map/GameMap.js';
import { MapNav } from '../map/MapNav.js';
import { circleBlocked, hasLineOfSight, moveCircle, raycast } from '../map/MapCollide.js';
import { SpatialHash } from '../spatial/SpatialHash.js';
import { Rng } from '../math/Rng.js';
import { clamp, distanceSq, TAU } from '../math/MathUtil.js';
import { ENEMIES, FIREBALL, type EnemyId } from '../data/enemies.js';
import {
  FAKE_WALL_HP,
  WEAPONS,
  WEAPON_ORDER,
  weaponBySlot,
  type WeaponDef,
  type WeaponId,
} from '../data/weapons.js';
import {
  awardsForLevel,
  computeStats,
  levelBanner,
  statsFor,
  type UpgradeId,
} from '../data/upgrades.js';
import {
  levelDef,
  multiKillBonus,
  multiKillLabel,
  multiplierWindow,
  SCORING,
  type LevelDef,
} from '../data/levels.js';
import { HASH_CELL, MAX_THINGS, PLAYER, SEPARATION, DECALS } from '../data/tuning.js';
import type {
  Decal,
  Effect,
  Enemy,
  Message,
  PendingAffect,
  Pickup,
  Placeable,
  Player,
  Popup,
  Shot,
  SoundEvent,
  WeaponSlot,
} from './types.js';
import type { WorldSnapshot } from './Snapshot.js';

/** One tick of intent from one player. Local input and network input share it. */
export interface InputCommand {
  /** Desired movement, each in -1..1. */
  moveX: number;
  moveY: number;
  /** Aim point in world coordinates. */
  aimX: number;
  aimY: number;
  fire: boolean;
  /** Weapon number key, 1-9 then 0, or null. */
  weaponSlot: number | null;
  nextWeapon: boolean;
  prevWeapon: boolean;
}

export function emptyCommand(): InputCommand {
  return {
    moveX: 0,
    moveY: 0,
    aimX: 0,
    aimY: 0,
    fire: false,
    weaponSlot: null,
    nextWeapon: false,
    prevWeapon: false,
  };
}

export interface WorldOptions {
  room: RoomDef;
  seed?: number;
  playerCount?: number;
  characters?: string[];
}

const MAX_AFFECT_DEPTH = 4;
/** Ticks a fully-released wave may linger before the next one starts anyway. */
const WAVE_GRACE_TICKS = 1200;
/** Scratch buffer for spatial queries; reused so queries never allocate. */
const QUERY_BUFFER = new Int32Array(512);

export class World {
  readonly map: GameMap;
  readonly rng: Rng;
  readonly hash: SpatialHash;
  /** One flow field per player, rebuilt round-robin. */
  private readonly navs: MapNav[] = [];

  readonly players: Player[] = [];
  readonly enemies: Enemy[] = [];
  readonly shots: Shot[] = [];
  readonly placeables: Placeable[] = [];
  readonly effects: Effect[] = [];
  readonly pickups: Pickup[] = [];

  /** Append-only; the client drains these into its floor layer. */
  readonly decals: Decal[] = [];
  readonly messages: Message[] = [];
  readonly popups: Popup[] = [];
  /** Drained by the client each frame. */
  readonly sounds: SoundEvent[] = [];

  tick = 0;
  level = 1;
  score = 0;
  kills = 0;
  multiplier = 1;
  gameOver = false;

  /** Screen shake amplitude; draw-only, never fed back into the simulation. */
  shake = 0;
  /** White flash intensity, 0-1. */
  flash = 0;

  private levelInfo: LevelDef;
  private spawnedThisLevel = 0;
  private killsThisLevel = 0;
  private devilsSpawned = 0;
  private zombieSpawnTimer = 0;
  private devilSpawnTimer = 0;
  private multiplierTicks = 0;
  private killsTowardMultiplier = 0;
  private multiKillCount = 0;
  private multiKillTicks = 0;
  private navCursor = 0;
  private waveGrace = 0;

  private nextId = 0;
  private readonly freeIds: number[] = [];
  private pendingAffects: PendingAffect[] = [];
  private readonly ramp: number;

  constructor(options: WorldOptions) {
    this.map = new GameMap(options.room);
    this.rng = new Rng(options.seed ?? 0x5eed);
    this.hash = new SpatialHash(this.map.width, this.map.height, HASH_CELL, MAX_THINGS);
    this.ramp = options.room.levelRamp ?? 1;
    this.levelInfo = levelDef(1, this.ramp);

    const count = options.playerCount ?? 1;
    for (let i = 0; i < count; i++) {
      this.navs.push(new MapNav(this.map));
      this.spawnPlayer(i, options.characters?.[i] ?? 'swat');
    }
    for (const spot of this.map.spawns.barrels) {
      this.addPlaceable('barrel', spot.x, spot.y, -1);
    }
    for (const spot of this.map.spawns.pickups) {
      this.addPickup(spot.x, spot.y);
    }
    this.pushMessage(levelBanner(1), 'level');
  }

  // ---- identity -----------------------------------------------------------

  private allocId(): number {
    const reused = this.freeIds.pop();
    if (reused !== undefined) return reused;
    if (this.nextId >= MAX_THINGS) return -1;
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private releaseId(id: number): void {
    if (id < 0) return;
    this.hash.remove(id);
    this.freeIds.push(id);
  }

  // ---- construction helpers ----------------------------------------------

  private spawnPlayer(index: number, characterId: string): void {
    const spot = this.map.spawns.players[index] ??
      this.map.spawns.players[0] ?? { x: this.map.width / 2, y: this.map.height / 2 };
    const id = this.allocId();
    const weapons = new Map<WeaponId, WeaponSlot>();
    for (const weaponId of WEAPON_ORDER) {
      weapons.set(weaponId, { unlocked: weaponId === 'pistol', ammo: 0 });
    }
    const player: Player = {
      id,
      alive: true,
      x: spot.x,
      y: spot.y,
      prevX: spot.x,
      prevY: spot.y,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: PLAYER.radius,
      z: 0,
      life: PLAYER.maxLife,
      maxLife: PLAYER.maxLife,
      speed: PLAYER.speed,
      mass: PLAYER.mass,
      height: PLAYER.height,
      state: 'alive',
      stateTicks: 0,
      animStep: 0,
      attackCooldown: 0,
      windup: 0,
      moving: false,
      hitTicks: 0,
      hitFromRear: false,
      index,
      characterId,
      weapons,
      current: 'pistol',
      fireCooldown: 0,
      invincible: PLAYER.spawnInvincibleTicks,
      respawnTimer: 0,
      held: [],
      stats: computeStats([]),
      firingHeld: false,
      kills: 0,
    };
    this.players.push(player);
    this.hash.insert(id, player.x, player.y);
  }

  private addEnemy(defId: EnemyId, x: number, y: number): Enemy | null {
    const id = this.allocId();
    if (id < 0) return null;
    const def = ENEMIES[defId];
    const speed = def.speed * (1 + this.rng.range(-def.speedVariance, def.speedVariance));
    const enemy: Enemy = {
      id,
      alive: true,
      x,
      y,
      prevX: x,
      prevY: y,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: def.radius,
      z: 0,
      life: def.maxLife,
      maxLife: def.maxLife,
      speed,
      mass: def.mass,
      height: def.height,
      state: 'alive',
      stateTicks: 0,
      animStep: 0,
      attackCooldown: this.rng.int(0, def.attack.cooldown),
      windup: 0,
      moving: false,
      hitTicks: 0,
      hitFromRear: false,
      defId,
      targetId: -1,
      hasLos: false,
      losTimer: this.rng.int(0, 3),
      stuckTicks: 0,
      wobblePhase: this.rng.range(0, TAU),
      chewCx: -1,
      chewCy: -1,
    };
    this.enemies.push(enemy);
    this.hash.insert(id, x, y);
    return enemy;
  }

  private addPlaceable(
    type: Placeable['type'],
    x: number,
    y: number,
    ownerId: number,
    stats?: { splashRadius: number; splashDamage: number; cluster: boolean },
  ): void {
    const id = this.allocId();
    if (id < 0) return;
    const weapon = WEAPONS[type === 'barrel' ? 'barrel' : type === 'mine' ? 'mine' : 'chargepack'];
    const placeable: Placeable = {
      id,
      alive: true,
      x,
      y,
      prevX: x,
      prevY: y,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: type === 'barrel' ? 13 : 10,
      z: 0,
      type,
      ownerId,
      hp: type === 'barrel' ? 40 : 25,
      armTime: weapon.armTime ?? 0,
      fuse: type === 'chargepack' ? (weapon.fuse ?? 150) : -1,
      triggerRadius: weapon.triggerRadius ?? 0,
      splashRadius: stats?.splashRadius ?? weapon.splash?.radius ?? 100,
      splashDamage: stats?.splashDamage ?? weapon.splash?.damage ?? 150,
      cluster: stats?.cluster ?? false,
      detonating: false,
    };
    this.placeables.push(placeable);
    this.hash.insert(id, x, y);
  }

  private addPickup(x: number, y: number): void {
    const id = this.allocId();
    if (id < 0) return;
    // Weight toward ammo; health is the scarce resource that keeps runs tense.
    const isLife = this.rng.bool(0.25);
    const weapon = isLife ? null : (this.rng.pick(WEAPON_ORDER.slice(1)) ?? 'uzi');
    this.pickups.push({
      id,
      alive: true,
      x,
      y,
      prevX: x,
      prevY: y,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: 12,
      z: 0,
      type: isLife ? 'life' : 'ammo',
      weapon,
      amount: isLife ? 25 : 0,
      life: -1,
    });
    this.hash.insert(id, x, y);
  }

  addEffect(type: Effect['type'], x: number, y: number, size: number, life: number): void {
    const id = this.allocId();
    if (id < 0) return;
    this.effects.push({
      id,
      alive: true,
      x,
      y,
      prevX: x,
      prevY: y,
      vx: 0,
      vy: 0,
      angle: this.rng.range(0, TAU),
      radius: size,
      z: 0,
      type,
      life,
      maxLife: life,
      size,
      seed: this.rng.next(),
    });
  }

  private addDecal(type: Decal['type'], x: number, y: number, size: number, color: string): void {
    if (this.decals.length >= DECALS.max) this.decals.shift();
    this.decals.push({ x, y, type, size, seed: this.rng.next(), color });
  }

  private playSound(name: string, x: number, y: number, rate = 1): void {
    // Capped so a chain explosion cannot flood the client with requests.
    if (this.sounds.length < 48) this.sounds.push({ name, x, y, rate });
  }

  pushMessage(text: string, kind: Message['kind'], life = 130): void {
    this.messages.push({ text, kind, life });
    if (this.messages.length > 6) this.messages.shift();
  }

  private pushPopup(x: number, y: number, text: string, kind: Popup['kind']): void {
    if (this.popups.length > 24) this.popups.shift();
    this.popups.push({ x, y, text, life: 45, kind });
  }

  // ---- the tick -----------------------------------------------------------

  /** Advance the simulation by exactly one fixed step. */
  step(commands: InputCommand[]): void {
    this.tick += 1;

    for (const entity of this.iterateAll()) {
      entity.prevX = entity.x;
      entity.prevY = entity.y;
    }

    this.phaseNav();
    this.phaseSpawn();
    this.phasePlayers(commands);
    this.phaseEnemies();
    this.phaseMovement();
    this.phaseSeparation();
    this.phaseShots();
    this.phasePlaceables();
    this.phaseAffects();
    this.phasePickups();
    this.phaseEffects();
    this.phaseScore();
    this.phasePrune();
  }

  private *iterateAll(): Generator<{ prevX: number; prevY: number; x: number; y: number }> {
    yield* this.players;
    yield* this.enemies;
    yield* this.shots;
    yield* this.effects;
  }

  /**
   * Rebuild one player's flow field per tick, round-robin. With two players a
   * field is at most two ticks stale, which is imperceptible, and the cost
   * stays flat regardless of how many enemies are chasing.
   */
  private phaseNav(): void {
    if (this.players.length === 0) return;
    this.navCursor = (this.navCursor + 1) % this.players.length;
    const player = this.players[this.navCursor]!;
    const nav = this.navs[this.navCursor]!;
    const cell = this.map.cellOf(player.x, player.y);
    if (player.state !== 'alive') return;
    if (nav.isCurrent(cell.cx, cell.cy)) return;
    nav.build(cell.cx, cell.cy);
  }

  private phaseSpawn(): void {
    if (this.gameOver) return;
    const info = this.levelInfo;
    const alive = this.enemies.filter((e) => e.state === 'alive').length;

    if (this.spawnedThisLevel < info.zombieTotal && alive < info.maxAlive) {
      this.zombieSpawnTimer -= 1;
      if (this.zombieSpawnTimer <= 0) {
        this.zombieSpawnTimer = info.zombieSpawnRate;
        const weights = info.mix.map((m) => m.weight);
        const chosen = info.mix[this.rng.weighted(weights)]?.id ?? 'zombie';
        if (this.spawnAtEdge(chosen)) this.spawnedThisLevel += 1;
      }
    }

    if (this.devilsSpawned < info.devilTotal && alive < info.maxAlive) {
      this.devilSpawnTimer -= 1;
      if (this.devilSpawnTimer <= 0) {
        this.devilSpawnTimer = info.devilSpawnRate;
        if (this.spawnAtEdge('devil')) this.devilsSpawned += 1;
      }
    }
  }

  /** Place an enemy on a spawn point, preferring one no player can see. */
  private spawnAtEdge(defId: EnemyId): boolean {
    const spots = this.map.spawns.zombies;
    if (spots.length === 0) return false;
    const start = this.rng.int(0, spots.length - 1);
    for (let i = 0; i < spots.length; i++) {
      const spot = spots[(start + i) % spots.length]!;
      const visible = this.players.some(
        (p) =>
          p.state === 'alive' &&
          distanceSq(p.x, p.y, spot.x, spot.y) < 360 * 360 &&
          hasLineOfSight(this.map, p.x, p.y, spot.x, spot.y),
      );
      if (visible) continue;
      const jitterX = spot.x + this.rng.range(-8, 8);
      const jitterY = spot.y + this.rng.range(-8, 8);
      return this.addEnemy(defId, jitterX, jitterY) !== null;
    }
    // Every spawn is watched; use one anyway rather than stalling the wave.
    const fallback = spots[start]!;
    return this.addEnemy(defId, fallback.x, fallback.y) !== null;
  }

  private phasePlayers(commands: InputCommand[]): void {
    for (const player of this.players) {
      const command = commands[player.index] ?? emptyCommand();

      if (player.state === 'dying') {
        player.stateTicks += 1;
        if (player.stateTicks > 40) {
          player.state = 'dead';
          player.stateTicks = 0;
          player.respawnTimer = PLAYER.respawnTicks;
        }
        continue;
      }
      if (player.state === 'dead') {
        player.respawnTimer -= 1;
        if (player.respawnTimer <= 0) this.respawn(player);
        continue;
      }

      if (player.invincible > 0) player.invincible -= 1;
      if (player.hitTicks > 0) player.hitTicks -= 1;
      if (player.fireCooldown > 0) player.fireCooldown -= 1;

      // Aim follows the pointer; movement is independent of facing.
      player.angle = Math.atan2(command.aimY - player.y, command.aimX - player.x);

      const stats = player.stats;
      const speed = player.speed * stats.speedMul;
      let dx = command.moveX;
      let dy = command.moveY;
      const length = Math.hypot(dx, dy);
      if (length > 1) {
        dx /= length;
        dy /= length;
      }
      player.vx = dx * speed;
      player.vy = dy * speed;
      player.moving = length > 0.01;
      if (player.moving) player.animStep += 1;

      this.applyWeaponSwitch(player, command);
      this.applyFire(player, command);
    }
  }

  private applyWeaponSwitch(player: Player, command: InputCommand): void {
    if (command.weaponSlot !== null) {
      const def = weaponBySlot(command.weaponSlot);
      if (def && player.weapons.get(def.id)?.unlocked) {
        this.selectWeapon(player, def.id);
      }
      return;
    }
    if (command.nextWeapon || command.prevWeapon) {
      const unlocked = WEAPON_ORDER.filter((id) => player.weapons.get(id)?.unlocked);
      if (unlocked.length === 0) return;
      const at = unlocked.indexOf(player.current);
      const shift = command.nextWeapon ? 1 : -1;
      const next = unlocked[(at + shift + unlocked.length) % unlocked.length]!;
      this.selectWeapon(player, next);
    }
  }

  private selectWeapon(player: Player, id: WeaponId): void {
    if (player.current === id) return;
    player.current = id;
    player.fireCooldown = Math.max(player.fireCooldown, 5);
    this.pushMessage(`${WEAPONS[id].name} selected!`, 'info', 70);
    this.playSound('CLICK', player.x, player.y);
  }

  private applyFire(player: Player, command: InputCommand): void {
    const def = WEAPONS[player.current];
    const stats = statsFor(player.stats, player.current);
    const slot = player.weapons.get(player.current)!;

    // Release-fired weapons (the grenade) throw when the control comes up.
    const triggered = def.onRelease
      ? player.firingHeld && !command.fire
      : def.auto
        ? command.fire
        : command.fire && !player.firingHeld;
    player.firingHeld = command.fire;

    if (!triggered || player.fireCooldown > 0) return;

    const infinite = def.infiniteAmmo || stats.infiniteAmmo;
    if (!infinite && slot.ammo <= 0) {
      this.pushMessage(`${def.name} is out of ammo!`, 'critical', 80);
      player.fireCooldown = 20;
      return;
    }

    player.fireCooldown = Math.max(1, Math.round(def.fireRate * stats.fireRateMul));
    if (!infinite) slot.ammo -= 1;

    if (def.places) {
      this.placeObject(player, def, stats.splashRadiusMul, stats.cluster);
      return;
    }
    this.fireProjectiles(player, def, stats);
    this.shake += def.shake;
  }

  private placeObject(
    player: Player,
    def: WeaponDef,
    splashMul: number,
    cluster: boolean,
  ): void {
    const distance = player.radius + 22;
    const x = player.x + Math.cos(player.angle) * distance;
    const y = player.y + Math.sin(player.angle) * distance;

    if (def.places === 'fakewall') {
      const cell = this.map.cellOf(x, y);
      if (this.map.buildWall(cell.cx, cell.cy, FAKE_WALL_HP)) {
        this.playSound('Object.Barrel.Place', x, y);
      }
      return;
    }
    if (this.map.blockedAtPoint(x, y)) return;
    const type = def.places === 'barrel' ? 'barrel' : def.places === 'mine' ? 'mine' : 'chargepack';
    this.addPlaceable(type, x, y, player.id, {
      splashRadius: (def.splash?.radius ?? 100) * splashMul,
      splashDamage: def.splash?.damage ?? 150,
      cluster,
    });
    this.playSound(type === 'mine' ? 'Weapon.Mine.Place' : 'Object.Barrel.Place', x, y);
  }

  private fireProjectiles(
    player: Player,
    def: WeaponDef,
    stats: ReturnType<typeof statsFor>,
  ): void {
    const count = def.shots + stats.shotsAdd;
    const spread = def.spread * stats.spreadMul;
    const muzzle = player.radius + 12;
    const originX = player.x + Math.cos(player.angle) * muzzle;
    const originY = player.y + Math.sin(player.angle) * muzzle;

    for (let i = 0; i < count; i++) {
      const angle = player.angle + (count === 1 ? this.rng.range(-spread, spread) : this.rng.range(-spread, spread));
      const id = this.allocId();
      if (id < 0) return;
      const shot: Shot = {
        id,
        alive: true,
        x: originX,
        y: originY,
        prevX: originX,
        prevY: originY,
        vx: Math.cos(angle) * def.speed,
        vy: Math.sin(angle) * def.speed,
        angle,
        radius: 3,
        z: 12,
        ownerId: player.id,
        weapon: def.id,
        kind: def.kind,
        damage: def.damage * stats.damageMul,
        knockback: def.knockback,
        life: def.kind === 'grenade' ? (def.fuse ?? 90) : 300,
        travelled: 0,
        maxRange: def.range * stats.rangeMul,
        pierce: def.pierce ?? false,
        splashRadius: (def.splash?.radius ?? 0) * stats.splashRadiusMul,
        splashDamage: def.splash?.damage ?? 0,
        fuse: def.kind === 'grenade' ? (def.fuse ?? 90) : -1,
        hits: new Set<number>(),
        cluster: stats.cluster,
      };
      this.shots.push(shot);
    }

    this.addEffect('muzzle', originX, originY, 14, 4);
    this.playSound(this.fireSound(def.id), player.x, player.y, this.rng.range(0.94, 1.06));
  }

  private fireSound(id: WeaponId): string {
    switch (id) {
      case 'uzi':
        return 'Weapon.UZI.Fire';
      case 'shotgun':
        return 'Weapon.ShotGun.Fire';
      case 'rocket':
        return 'Weapon.Rocket.Fire';
      case 'railgun':
        return 'Weapon.Railgun.Fire';
      default:
        return 'Weapon.Pistol.Fire';
    }
  }

  private respawn(player: Player): void {
    const spot = this.map.spawns.players[player.index] ??
      this.map.spawns.players[0] ?? { x: this.map.width / 2, y: this.map.height / 2 };
    player.x = spot.x;
    player.y = spot.y;
    player.prevX = spot.x;
    player.prevY = spot.y;
    player.life = player.maxLife;
    player.state = 'alive';
    player.stateTicks = 0;
    player.invincible = PLAYER.spawnInvincibleTicks;
    this.hash.move(player.id, player.x, player.y);
  }

  // ---- enemies ------------------------------------------------------------

  private phaseEnemies(): void {
    for (const enemy of this.enemies) {
      if (enemy.state === 'dying') {
        enemy.stateTicks += 1;
        if (enemy.stateTicks > 45) enemy.state = 'dead';
        continue;
      }
      if (enemy.state !== 'alive') continue;

      if (enemy.hitTicks > 0) enemy.hitTicks -= 1;
      if (enemy.attackCooldown > 0) enemy.attackCooldown -= 1;

      const def = ENEMIES[enemy.defId];
      const target = this.nearestPlayer(enemy);
      enemy.targetId = target?.id ?? -1;
      if (!target) {
        enemy.vx = 0;
        enemy.vy = 0;
        enemy.moving = false;
        continue;
      }

      // Line of sight is refreshed on a stagger so the cost is spread across
      // ticks rather than spiking when a wave lands together.
      enemy.losTimer -= 1;
      if (enemy.losTimer <= 0) {
        enemy.losTimer = 4;
        const range = def.attack.kind === 'ranged' ? def.attack.reach + 60 : 340;
        enemy.hasLos =
          distanceSq(enemy.x, enemy.y, target.x, target.y) < range * range &&
          hasLineOfSight(this.map, enemy.x, enemy.y, target.x, target.y);
      }

      if (enemy.windup > 0) {
        enemy.windup -= 1;
        enemy.vx = 0;
        enemy.vy = 0;
        enemy.moving = false;
        if (enemy.windup === 0) this.resolveEnemyAttack(enemy, target);
        continue;
      }

      const toTargetX = target.x - enemy.x;
      const toTargetY = target.y - enemy.y;
      const distanceToTarget = Math.hypot(toTargetX, toTargetY) || 1;
      const reach = enemy.radius + target.radius + def.attack.reach;

      if (def.attack.kind === 'melee' && distanceToTarget <= reach) {
        if (enemy.attackCooldown <= 0) {
          enemy.windup = def.attack.windup;
          enemy.attackCooldown = def.attack.cooldown;
        }
        enemy.vx = 0;
        enemy.vy = 0;
        enemy.moving = false;
        enemy.angle = Math.atan2(toTargetY, toTargetX);
        continue;
      }
      if (def.attack.kind === 'ranged' && enemy.hasLos && distanceToTarget < def.attack.reach) {
        if (enemy.attackCooldown <= 0) {
          enemy.windup = def.attack.windup;
          enemy.attackCooldown = def.attack.cooldown;
          enemy.vx = 0;
          enemy.vy = 0;
          enemy.moving = false;
          enemy.angle = Math.atan2(toTargetY, toTargetX);
          continue;
        }
        // Hold position and strafe rather than closing all the way in.
        const strafe = Math.sin(this.tick * 0.03 + enemy.wobblePhase);
        enemy.vx = (-toTargetY / distanceToTarget) * enemy.speed * strafe;
        enemy.vy = (toTargetX / distanceToTarget) * enemy.speed * strafe;
        enemy.moving = true;
        enemy.angle = Math.atan2(toTargetY, toTargetX);
        enemy.animStep += 1;
        continue;
      }

      // Steer: straight at the target when visible, otherwise down the field.
      let dirX: number;
      let dirY: number;
      if (enemy.hasLos) {
        dirX = toTargetX / distanceToTarget;
        dirY = toTargetY / distanceToTarget;
      } else {
        const nav = this.navFor(target);
        const cell = this.map.cellOf(enemy.x, enemy.y);
        const flow = nav?.directionAt(cell.cx, cell.cy);
        if (flow) {
          dirX = flow.x;
          dirY = flow.y;
        } else {
          dirX = toTargetX / distanceToTarget;
          dirY = toTargetY / distanceToTarget;
        }
      }

      const separation = this.separationFor(enemy);
      dirX += separation.x;
      dirY += separation.y;

      // A touch of drift stops crowds forming single-file columns.
      const wobble = Math.sin(this.tick * 0.06 + enemy.wobblePhase) * 0.12;
      const cos = Math.cos(wobble);
      const sin = Math.sin(wobble);
      const steerX = dirX * cos - dirY * sin;
      const steerY = dirX * sin + dirY * cos;
      const steerLength = Math.hypot(steerX, steerY) || 1;

      enemy.vx = (steerX / steerLength) * enemy.speed;
      enemy.vy = (steerY / steerLength) * enemy.speed;
      enemy.angle = Math.atan2(enemy.vy, enemy.vx);
      enemy.moving = true;
      enemy.animStep += 1;
    }
  }

  private navFor(player: Player): MapNav | null {
    const index = this.players.indexOf(player);
    return index >= 0 ? (this.navs[index] ?? null) : null;
  }

  private nearestPlayer(enemy: Enemy): Player | null {
    let best: Player | null = null;
    let bestDistance = Infinity;
    for (const player of this.players) {
      if (player.state !== 'alive') continue;
      const d = distanceSq(enemy.x, enemy.y, player.x, player.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = player;
      }
    }
    return best;
  }

  /** Repulsion from nearby bodies, so a crowd spreads into a wall of zombies. */
  private separationFor(enemy: Enemy): { x: number; y: number } {
    const count = this.hash.queryCircle(enemy.x, enemy.y, enemy.radius + 20, QUERY_BUFFER);
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < count; i++) {
      const other = this.enemyById(QUERY_BUFFER[i]!);
      if (!other || other === enemy || other.state !== 'alive') continue;
      const dx = enemy.x - other.x;
      const dy = enemy.y - other.y;
      const distanceSquared = dx * dx + dy * dy;
      const want = enemy.radius + other.radius + 4;
      if (distanceSquared > want * want || distanceSquared === 0) continue;
      const d = Math.sqrt(distanceSquared);
      sumX += (dx / d) * (1 - d / want);
      sumY += (dy / d) * (1 - d / want);
    }
    // Capped so separation nudges the path without overriding it.
    const length = Math.hypot(sumX, sumY);
    if (length > 0.4) {
      sumX = (sumX / length) * 0.4;
      sumY = (sumY / length) * 0.4;
    }
    return { x: sumX, y: sumY };
  }

  private enemyById(id: number): Enemy | undefined {
    return this.enemies.find((e) => e.id === id);
  }

  private resolveEnemyAttack(enemy: Enemy, target: Player): void {
    const def = ENEMIES[enemy.defId];
    if (def.attack.kind === 'ranged') {
      const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
      const id = this.allocId();
      if (id < 0) return;
      this.shots.push({
        id,
        alive: true,
        x: enemy.x + Math.cos(angle) * (enemy.radius + 8),
        y: enemy.y + Math.sin(angle) * (enemy.radius + 8),
        prevX: enemy.x,
        prevY: enemy.y,
        vx: Math.cos(angle) * FIREBALL.speed,
        vy: Math.sin(angle) * FIREBALL.speed,
        angle,
        radius: FIREBALL.radius,
        z: 14,
        // Negative owner marks an enemy projectile, which only harms players.
        ownerId: -2,
        weapon: 'pistol',
        kind: 'bullet',
        damage: FIREBALL.damage,
        knockback: 1,
        life: FIREBALL.life,
        travelled: 0,
        maxRange: 900,
        pierce: false,
        splashRadius: FIREBALL.splashRadius,
        splashDamage: FIREBALL.damage,
        fuse: -1,
        hits: new Set<number>(),
        cluster: false,
      });
      this.playSound('Creature.Zombie.Attack', enemy.x, enemy.y, 0.8);
      return;
    }

    const reach = enemy.radius + target.radius + def.attack.reach + 4;
    if (distanceSq(enemy.x, enemy.y, target.x, target.y) <= reach * reach) {
      this.damagePlayer(target, def.attack.damage, enemy.x, enemy.y);
      this.playSound('Creature.Zombie.Attack', enemy.x, enemy.y, this.rng.range(0.9, 1.1));
    }
  }

  // ---- movement -----------------------------------------------------------

  private phaseMovement(): void {
    for (const player of this.players) {
      if (player.state !== 'alive') continue;
      const moved = moveCircle(this.map, player.x, player.y, player.vx, player.vy, player.radius);
      player.x = moved.x;
      player.y = moved.y;
      this.hash.move(player.id, player.x, player.y);
    }

    for (const enemy of this.enemies) {
      if (enemy.state !== 'alive') continue;
      const beforeX = enemy.x;
      const beforeY = enemy.y;
      const moved = moveCircle(this.map, enemy.x, enemy.y, enemy.vx, enemy.vy, enemy.radius);
      enemy.x = moved.x;
      enemy.y = moved.y;
      this.hash.move(enemy.id, enemy.x, enemy.y);

      // Wedged against a barricade: start chewing through it. This is what
      // makes player-built walls buy time rather than lasting forever.
      const progress = Math.hypot(enemy.x - beforeX, enemy.y - beforeY);
      if (enemy.moving && progress < enemy.speed * 0.25) {
        enemy.stuckTicks += 1;
        if (enemy.stuckTicks > 12) {
          this.chewObstacle(enemy);
          enemy.stuckTicks = 0;
        }
      } else {
        enemy.stuckTicks = 0;
      }
    }

    for (const shot of this.shots) {
      if (!shot.alive) continue;
      shot.x += shot.vx;
      shot.y += shot.vy;
      shot.travelled += Math.hypot(shot.vx, shot.vy);
    }
  }

  /** Attack whatever static or placed obstacle is directly ahead. */
  private chewObstacle(enemy: Enemy): void {
    const def = ENEMIES[enemy.defId];
    const ahead = enemy.radius + 14;
    const x = enemy.x + Math.cos(enemy.angle) * ahead;
    const y = enemy.y + Math.sin(enemy.angle) * ahead;
    const cell = this.map.cellOf(x, y);

    if (this.map.tileAt(cell.cx, cell.cy) === Tile.Breakable) {
      if (this.map.damageWall(cell.cx, cell.cy, def.wallDamage)) {
        const centre = this.map.centreOf(cell.cx, cell.cy);
        this.addEffect('smoke', centre.x, centre.y, 26, 22);
        this.playSound('Shot.HitWall.1', centre.x, centre.y);
      }
      return;
    }

    for (const placeable of this.placeables) {
      if (!placeable.alive) continue;
      const reach = enemy.radius + placeable.radius + 6;
      if (distanceSq(enemy.x, enemy.y, placeable.x, placeable.y) > reach * reach) continue;
      placeable.hp -= def.wallDamage;
      if (placeable.hp <= 0) this.detonate(placeable, 0);
      return;
    }
  }

  /**
   * Push overlapping bodies apart so crowds jam rather than interpenetrate.
   *
   * Displacement goes through map collision. Applying it directly would let a
   * dense crowd shove a body inside a wall, where every subsequent move is
   * blocked and it is stuck for good -- which soft-locks a wave, since a level
   * only clears once every spawn has died.
   */
  private phaseSeparation(): void {
    for (let pass = 0; pass < SEPARATION.iterations; pass++) {
      for (const enemy of this.enemies) {
        if (enemy.state !== 'alive') continue;
        const count = this.hash.queryCircle(enemy.x, enemy.y, enemy.radius + 24, QUERY_BUFFER);

        let pushX = 0;
        let pushY = 0;
        for (let i = 0; i < count; i++) {
          const id = QUERY_BUFFER[i]!;
          if (id === enemy.id) continue;
          const other = this.enemyById(id);
          if (!other || other.state !== 'alive') continue;

          const dx = other.x - enemy.x;
          const dy = other.y - enemy.y;
          const want = enemy.radius + other.radius;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= want * want || distanceSquared === 0) continue;

          const d = Math.sqrt(distanceSquared);
          const overlap = (want - d) * SEPARATION.strength;
          // Heavier bodies give ground more slowly.
          const share = other.mass / (enemy.mass + other.mass);
          pushX -= (dx / d) * overlap * share;
          pushY -= (dy / d) * overlap * share;
        }

        if (pushX !== 0 || pushY !== 0) {
          const moved = moveCircle(this.map, enemy.x, enemy.y, pushX, pushY, enemy.radius);
          enemy.x = moved.x;
          enemy.y = moved.y;
        }
        this.unstick(enemy);
        this.hash.move(enemy.id, enemy.x, enemy.y);
      }
    }
  }

  /**
   * Recover a body that has ended up inside geometry, which can still happen
   * when a wall is built on top of it. Without this the creature is immobile
   * and unkillable, and the wave can never finish.
   */
  private unstick(creature: Enemy | Player): void {
    if (!circleBlocked(this.map, creature.x, creature.y, creature.radius)) return;
    const cell = this.map.cellOf(creature.x, creature.y);
    let bestX = creature.x;
    let bestY = creature.y;
    let bestDistance = Infinity;
    // Search outward for the nearest open cell centre and step toward it.
    for (let radius = 1; radius <= 3 && bestDistance === Infinity; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const cx = cell.cx + dx;
          const cy = cell.cy + dy;
          if (!this.map.inBounds(cx, cy) || this.map.isBlocked(cx, cy)) continue;
          const centre = this.map.centreOf(cx, cy);
          if (circleBlocked(this.map, centre.x, centre.y, creature.radius)) continue;
          const d = distanceSq(creature.x, creature.y, centre.x, centre.y);
          if (d < bestDistance) {
            bestDistance = d;
            bestX = centre.x;
            bestY = centre.y;
          }
        }
      }
    }
    creature.x = bestX;
    creature.y = bestY;
  }

  // ---- projectiles --------------------------------------------------------

  private phaseShots(): void {
    for (const shot of this.shots) {
      if (!shot.alive) continue;

      shot.life -= 1;
      if (shot.fuse > 0) {
        shot.fuse -= 1;
        if (shot.fuse === 0) {
          this.explode(shot.x, shot.y, shot.splashRadius, shot.splashDamage, shot.ownerId, shot.cluster, 0);
          shot.alive = false;
          continue;
        }
      }
      if (shot.life <= 0 || shot.travelled > shot.maxRange) {
        if (shot.splashRadius > 0 && shot.kind !== 'grenade') {
          this.explode(shot.x, shot.y, shot.splashRadius, shot.splashDamage, shot.ownerId, shot.cluster, 0);
        }
        shot.alive = false;
        continue;
      }

      // Sweep the segment travelled this tick so fast shots cannot tunnel.
      const wall = raycast(this.map, shot.prevX, shot.prevY, shot.x, shot.y);
      const hit = this.sweepTargets(shot, wall?.distance ?? Infinity);

      if (hit) continue;
      if (wall) {
        if (shot.kind === 'grenade') {
          // Grenades bounce instead of stopping.
          shot.x = shot.prevX;
          shot.y = shot.prevY;
          shot.vx *= -0.45;
          shot.vy *= -0.45;
          this.playSound('Shot.Grenade.Bounce', shot.x, shot.y);
          continue;
        }
        if (shot.splashRadius > 0) {
          this.explode(wall.x, wall.y, shot.splashRadius, shot.splashDamage, shot.ownerId, shot.cluster, 0);
        } else {
          this.addEffect('spark', wall.x, wall.y, 8, 6);
          this.addDecal('pock', wall.x, wall.y, 4, '#1d1d1f');
          this.playSound('Shot.HitWall.1', wall.x, wall.y, this.rng.range(0.9, 1.1));
        }
        shot.alive = false;
      }
    }
  }

  /**
   * Test a shot's swept segment against creatures.
   * Returns true when the shot was consumed.
   */
  private sweepTargets(shot: Shot, wallDistance: number): boolean {
    const enemyProjectile = shot.ownerId === -2;
    const count = this.hash.querySegment(shot.prevX, shot.prevY, shot.x, shot.y, QUERY_BUFFER);

    let closest: { creature: Enemy | Player; distance: number } | null = null;
    for (let i = 0; i < count; i++) {
      const id = QUERY_BUFFER[i]!;
      if (shot.hits.has(id)) continue;

      const creature: Enemy | Player | undefined = enemyProjectile
        ? this.players.find((p) => p.id === id)
        : this.enemyById(id);
      if (!creature || creature.state !== 'alive') continue;
      if (enemyProjectile && (creature as Player).invincible > 0) continue;

      const distance = this.segmentHitDistance(shot, creature.x, creature.y, creature.radius);
      if (distance === null || distance > wallDistance) continue;
      if (!closest || distance < closest.distance) closest = { creature, distance };
    }

    if (!closest) return false;
    const { creature } = closest;
    shot.hits.add(creature.id);

    if (shot.splashRadius > 0) {
      this.explode(creature.x, creature.y, shot.splashRadius, shot.splashDamage, shot.ownerId, shot.cluster, 0);
      shot.alive = false;
      return true;
    }

    if (enemyProjectile) {
      this.damagePlayer(creature as Player, shot.damage, shot.x, shot.y);
    } else {
      this.damageEnemy(creature as Enemy, shot.damage, shot.angle, shot.knockback, shot.ownerId);
    }

    if (!shot.pierce) {
      shot.alive = false;
      return true;
    }
    return false;
  }

  /** Distance along the shot's segment at which it first touches a circle. */
  private segmentHitDistance(shot: Shot, cx: number, cy: number, radius: number): number | null {
    const dx = shot.x - shot.prevX;
    const dy = shot.y - shot.prevY;
    const length = Math.hypot(dx, dy);
    if (length === 0) return null;
    const nx = dx / length;
    const ny = dy / length;
    const toX = cx - shot.prevX;
    const toY = cy - shot.prevY;
    const along = toX * nx + toY * ny;
    const clampedAlong = clamp(along, 0, length);
    const nearestX = shot.prevX + nx * clampedAlong;
    const nearestY = shot.prevY + ny * clampedAlong;
    const reach = radius + shot.radius;
    if (distanceSq(nearestX, nearestY, cx, cy) > reach * reach) return null;
    return clampedAlong;
  }

  // ---- placed objects -----------------------------------------------------

  private phasePlaceables(): void {
    for (const placeable of this.placeables) {
      if (!placeable.alive) continue;
      if (placeable.armTime > 0) placeable.armTime -= 1;

      if (placeable.fuse > 0) {
        placeable.fuse -= 1;
        if (placeable.fuse === 0) {
          this.detonate(placeable, 0);
          continue;
        }
      }

      if (placeable.type === 'mine' && placeable.armTime <= 0) {
        const count = this.hash.queryCircle(
          placeable.x,
          placeable.y,
          placeable.triggerRadius,
          QUERY_BUFFER,
        );
        for (let i = 0; i < count; i++) {
          const enemy = this.enemyById(QUERY_BUFFER[i]!);
          if (!enemy || enemy.state !== 'alive') continue;
          const reach = placeable.triggerRadius + enemy.radius;
          if (distanceSq(placeable.x, placeable.y, enemy.x, enemy.y) > reach * reach) continue;
          this.detonate(placeable, 0);
          break;
        }
      }
    }
  }

  private detonate(placeable: Placeable, depth: number): void {
    if (!placeable.alive || placeable.detonating) return;
    placeable.detonating = true;
    placeable.alive = false;
    this.explode(
      placeable.x,
      placeable.y,
      placeable.splashRadius,
      placeable.splashDamage,
      placeable.ownerId,
      placeable.cluster,
      depth,
    );
  }

  /**
   * Queue an area effect. It resolves on the following tick, so chains stagger
   * the way the original's did instead of resolving in one indivisible instant.
   */
  private explode(
    x: number,
    y: number,
    radius: number,
    damage: number,
    ownerId: number,
    cluster: boolean,
    depth: number,
  ): void {
    if (depth > MAX_AFFECT_DEPTH) return;
    this.pendingAffects.push({ x, y, radius, damage, ownerId, knockback: 4, cluster, depth });
    this.addEffect('explosion', x, y, radius, 22);
    this.addDecal('scorch', x, y, radius * 0.75, '#101014');
    this.playSound('Effect.Explosion', x, y, this.rng.range(0.9, 1.1));
    this.shake += Math.min(14, radius / 12);
    this.flash = Math.min(1, this.flash + 0.25);
  }

  private phaseAffects(): void {
    if (this.pendingAffects.length === 0) return;
    const affects = this.pendingAffects;
    this.pendingAffects = [];

    for (const affect of affects) {
      const count = this.hash.queryCircle(affect.x, affect.y, affect.radius, QUERY_BUFFER);
      for (let i = 0; i < count; i++) {
        const id = QUERY_BUFFER[i]!;
        const enemy = this.enemyById(id);
        if (enemy && enemy.state === 'alive') {
          const d = Math.hypot(enemy.x - affect.x, enemy.y - affect.y);
          if (d > affect.radius) continue;
          // Linear falloff keeps the blast readable at its edge.
          const falloff = 1 - d / affect.radius;
          const angle = Math.atan2(enemy.y - affect.y, enemy.x - affect.x);
          this.damageEnemy(enemy, affect.damage * falloff, angle, affect.knockback * falloff, affect.ownerId);
          continue;
        }
        const player = this.players.find((p) => p.id === id);
        if (player && player.state === 'alive' && player.invincible <= 0) {
          const d = Math.hypot(player.x - affect.x, player.y - affect.y);
          if (d > affect.radius) continue;
          // Self-inflicted blasts hurt, but at a reduced rate.
          const falloff = 1 - d / affect.radius;
          this.damagePlayer(player, affect.damage * falloff * 0.35, affect.x, affect.y);
        }
      }

      // Chain into anything explosive caught in the blast.
      for (const placeable of this.placeables) {
        if (!placeable.alive || placeable.detonating) continue;
        if (distanceSq(placeable.x, placeable.y, affect.x, affect.y) > affect.radius * affect.radius) {
          continue;
        }
        this.detonate(placeable, affect.depth + 1);
      }

      if (affect.cluster && affect.depth < MAX_AFFECT_DEPTH) {
        this.spawnClusterShells(affect);
      }
    }
  }

  private spawnClusterShells(affect: PendingAffect): void {
    const shells = 6;
    for (let i = 0; i < shells; i++) {
      const angle = (i / shells) * TAU + this.rng.range(-0.2, 0.2);
      const distance = affect.radius * 0.7;
      this.explode(
        affect.x + Math.cos(angle) * distance,
        affect.y + Math.sin(angle) * distance,
        affect.radius * 0.45,
        affect.damage * 0.4,
        affect.ownerId,
        false,
        affect.depth + 1,
      );
    }
  }

  // ---- damage -------------------------------------------------------------

  private damageEnemy(
    enemy: Enemy,
    amount: number,
    angle: number,
    knockback: number,
    ownerId: number,
  ): void {
    if (enemy.state !== 'alive') return;
    const def = ENEMIES[enemy.defId];
    enemy.life -= amount;
    enemy.hitTicks = 8;
    enemy.hitFromRear = Math.cos(angle - enemy.angle) > 0;

    // Knockback scales with damage, which is most of why shooting feels good.
    const push = Math.min(6, knockback * (1 + amount / 120)) / Math.max(0.4, enemy.mass);
    enemy.x += Math.cos(angle) * push;
    enemy.y += Math.sin(angle) * push;
    this.hash.move(enemy.id, enemy.x, enemy.y);

    this.addEffect('blood', enemy.x, enemy.y, 10, 10);
    this.addDecal('blood', enemy.x, enemy.y, this.rng.range(6, 11), def.bloodColor);

    if (enemy.life > 0) {
      if (this.rng.bool(0.25)) {
        this.playSound('Creature.Zombie.Hit', enemy.x, enemy.y, this.rng.range(0.9, 1.1));
      }
      return;
    }

    enemy.state = 'dying';
    enemy.stateTicks = 0;
    enemy.vx = 0;
    enemy.vy = 0;
    this.addDecal('blood', enemy.x, enemy.y, this.rng.range(14, 20), def.bloodColor);
    this.addEffect('gib', enemy.x, enemy.y, 14, 30);
    this.playSound('Creature.HitFloor', enemy.x, enemy.y, this.rng.range(0.9, 1.1));
    this.registerKill(enemy, ownerId);
  }

  private damagePlayer(player: Player, amount: number, fromX: number, fromY: number): void {
    if (player.state !== 'alive' || player.invincible > 0) return;
    player.life -= amount;
    player.hitTicks = 10;
    const angle = Math.atan2(player.y - fromY, player.x - fromX);
    player.hitFromRear = Math.cos(angle - player.angle) > 0;
    this.shake += 2.5;
    this.addDecal('blood', player.x, player.y, this.rng.range(5, 9), '#7a0d12');

    if (player.life > 0) return;
    player.life = 0;
    player.state = 'dying';
    player.stateTicks = 0;
    this.playSound('Creature.Player.Scream.1', player.x, player.y);
    this.pushMessage('You died', 'critical', 150);
    if (this.players.every((p) => p.state !== 'alive')) this.gameOver = true;
  }

  private registerKill(enemy: Enemy, ownerId: number): void {
    const def = ENEMIES[enemy.defId];
    this.kills += 1;
    this.killsThisLevel += 1;

    // Multi-kill: kills landing inside a short window compound.
    if (this.multiKillTicks > 0) this.multiKillCount += 1;
    else this.multiKillCount = 1;
    this.multiKillTicks = SCORING.multiKillWindow;

    this.killsTowardMultiplier += 1;
    if (this.killsTowardMultiplier >= SCORING.killsPerMultiplier) {
      this.killsTowardMultiplier = 0;
      this.multiplier = Math.min(SCORING.maxMultiplier, this.multiplier + 1);
    }
    this.multiplierTicks = multiplierWindow(this.level);

    const bonus = multiKillBonus(this.multiKillCount);
    const gained = Math.round(def.score * this.multiplier * bonus);
    this.score += gained;

    const owner = this.players.find((p) => p.id === ownerId);
    if (owner) owner.kills += 1;

    this.pushPopup(enemy.x, enemy.y - 20, `+${gained}`, 'score');
    const label = multiKillLabel(this.multiKillCount);
    if (label) this.pushPopup(enemy.x, enemy.y - 34, label, 'combo');

    // Occasional drops are the only source of health, which keeps runs tense.
    if (this.rng.bool(0.06)) this.addPickup(enemy.x, enemy.y);
  }

  // ---- pickups, effects, scoring ------------------------------------------

  private phasePickups(): void {
    for (const pickup of this.pickups) {
      if (!pickup.alive) continue;
      for (const player of this.players) {
        if (player.state !== 'alive') continue;
        const reach = pickup.radius + player.radius;
        if (distanceSq(pickup.x, pickup.y, player.x, player.y) > reach * reach) continue;

        if (pickup.type === 'life') {
          player.life = Math.min(player.maxLife, player.life + pickup.amount);
          this.pushMessage('Life up!', 'info', 70);
        } else if (pickup.weapon) {
          const slot = player.weapons.get(pickup.weapon)!;
          const stats = statsFor(player.stats, pickup.weapon);
          const def = WEAPONS[pickup.weapon];
          slot.ammo += Math.round(def.totalAmmo * 0.5 * stats.ammoMul);
          if (!slot.unlocked) slot.unlocked = true;
          this.pushMessage(`Picked up ${def.name}`, 'info', 70);
        }
        pickup.alive = false;
        this.playSound('Object.Pickup', pickup.x, pickup.y);
        break;
      }
    }
  }

  private phaseEffects(): void {
    for (const effect of this.effects) {
      if (!effect.alive) continue;
      effect.life -= 1;
      if (effect.life <= 0) effect.alive = false;
    }
    for (const message of this.messages) message.life -= 1;
    for (const popup of this.popups) {
      popup.life -= 1;
      popup.y -= 0.4;
    }
    this.shake *= 0.86;
    if (this.shake < 0.2) this.shake = 0;
    this.flash = Math.max(0, this.flash - 0.06);
  }

  private phaseScore(): void {
    if (this.multiKillTicks > 0) {
      this.multiKillTicks -= 1;
      if (this.multiKillTicks === 0) this.multiKillCount = 0;
    }
    if (this.multiplierTicks > 0) {
      this.multiplierTicks -= 1;
      if (this.multiplierTicks === 0 && this.multiplier > 1) {
        this.multiplier -= 1;
        this.multiplierTicks = multiplierWindow(this.level);
      }
    }

    // A level clears once its wave has been fully released and dealt with.
    const waveReleased =
      this.spawnedThisLevel >= this.levelInfo.zombieTotal &&
      this.devilsSpawned >= this.levelInfo.devilTotal;
    if (!waveReleased) return;

    const remaining = this.enemies.filter((e) => e.state === 'alive').length;
    if (remaining === 0) {
      this.advanceLevel();
      return;
    }

    // A straggler must not be able to stall the run forever -- one enemy that
    // has holed up somewhere the player will not go would otherwise block
    // progression permanently. After a grace period the next wave starts and
    // the leftovers simply join it.
    this.waveGrace += 1;
    if (this.waveGrace > WAVE_GRACE_TICKS) this.advanceLevel();
  }

  private advanceLevel(): void {
    this.level += 1;
    this.levelInfo = levelDef(this.level, this.ramp);
    this.killsThisLevel = 0;
    this.spawnedThisLevel = 0;
    this.devilsSpawned = 0;
    this.waveGrace = 0;
    this.zombieSpawnTimer = 0;
    this.devilSpawnTimer = this.levelInfo.devilSpawnRate;
    this.pushMessage(levelBanner(this.level), 'level', 160);
    this.playSound('World.End', this.players[0]?.x ?? 0, this.players[0]?.y ?? 0);

    for (const award of awardsForLevel(this.level)) {
      for (const player of this.players) this.grantAward(player, award);
    }
  }

  private grantAward(
    player: Player,
    award: { kind: string; weapon: WeaponId; upgrade?: UpgradeId; message: string },
  ): void {
    if (award.kind === 'weapon') {
      const slot = player.weapons.get(award.weapon)!;
      slot.unlocked = true;
      const stats = statsFor(player.stats, award.weapon);
      slot.ammo += Math.round(WEAPONS[award.weapon].totalAmmo * stats.ammoMul);
    } else if (award.upgrade) {
      player.held.push({ weapon: award.weapon, upgrade: award.upgrade });
      // Recompute from the full set so awards stay order-independent.
      player.stats = computeStats(player.held);
      if (award.upgrade === 'DoubleAmmo' || award.upgrade === 'QuadAmmo') {
        const slot = player.weapons.get(award.weapon)!;
        slot.ammo += WEAPONS[award.weapon].totalAmmo;
      }
    }
    this.pushMessage(award.message, 'upgrade', 150);
  }

  /** Drop dead entities and reclaim their ids. */
  private phasePrune(): void {
    const sweep = <T extends { alive: boolean; id: number }>(list: T[]): void => {
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i]!;
        if (entry.alive) continue;
        this.releaseId(entry.id);
        list.splice(i, 1);
      }
    };

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      if (enemy.state !== 'dead') continue;
      this.releaseId(enemy.id);
      this.enemies.splice(i, 1);
    }
    sweep(this.shots);
    sweep(this.placeables);
    sweep(this.effects);
    sweep(this.pickups);

    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.life <= 0) this.messages.splice(i, 1);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      if (this.popups[i]!.life <= 0) this.popups.splice(i, 1);
    }
  }

  // ---- inspection ---------------------------------------------------------

  /** Ammo in the active weapon, or -1 when it is unlimited. */
  ammoFor(player: Player): number {
    const def = WEAPONS[player.current];
    const stats = statsFor(player.stats, player.current);
    if (def.infiniteAmmo || stats.infiniteAmmo) return -1;
    return player.weapons.get(player.current)?.ammo ?? 0;
  }

  /** Cheap structural hash, used to assert determinism across runs and hosts. */
  stateHash(): number {
    let hash = 0x811c9dc5;
    const mix = (value: number): void => {
      hash ^= Math.round(value * 1000) | 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    };
    mix(this.tick);
    mix(this.score);
    mix(this.level);
    mix(this.enemies.length);
    for (const player of this.players) {
      mix(player.x);
      mix(player.y);
      mix(player.life);
    }
    for (const enemy of this.enemies) {
      mix(enemy.x);
      mix(enemy.y);
      mix(enemy.life);
    }
    return hash >>> 0;
  }

  /** Cells occupied by player-built barricades, for the renderer. */
  breakableCells(): Array<{ cx: number; cy: number; hp: number }> {
    const out: Array<{ cx: number; cy: number; hp: number }> = [];
    for (let cy = 0; cy < this.map.rows; cy++) {
      for (let cx = 0; cx < this.map.cols; cx++) {
        if (this.map.tileAt(cx, cy) !== Tile.Breakable) continue;
        out.push({ cx, cy, hp: this.map.integrity[this.map.index(cx, cy)] ?? 0 });
      }
    }
    return out;
  }

  // ---- serialisation ------------------------------------------------------

  /**
   * Capture the full simulation state.
   *
   * Cosmetic collections (effects, popups, decals, queued sounds) are left out:
   * they regenerate from play and a joining client does not need the history.
   */
  snapshot(): WorldSnapshot {
    return {
      version: 1,
      tick: this.tick,
      level: this.level,
      score: this.score,
      kills: this.kills,
      multiplier: this.multiplier,
      gameOver: this.gameOver,
      rng: this.rng.getState(),
      progress: {
        spawnedThisLevel: this.spawnedThisLevel,
        killsThisLevel: this.killsThisLevel,
        devilsSpawned: this.devilsSpawned,
        zombieSpawnTimer: this.zombieSpawnTimer,
        devilSpawnTimer: this.devilSpawnTimer,
        multiplierTicks: this.multiplierTicks,
        killsTowardMultiplier: this.killsTowardMultiplier,
        multiKillCount: this.multiKillCount,
        multiKillTicks: this.multiKillTicks,
        waveGrace: this.waveGrace,
        navCursor: this.navCursor,
      },
      ids: { next: this.nextId, free: [...this.freeIds] },
      map: {
        tiles: Array.from(this.map.tiles),
        integrity: Array.from(this.map.integrity),
        revision: this.map.revision,
      },
      players: this.players.map((p) => ({
        id: p.id,
        index: p.index,
        characterId: p.characterId,
        x: p.x,
        y: p.y,
        angle: p.angle,
        life: p.life,
        maxLife: p.maxLife,
        state: p.state,
        stateTicks: p.stateTicks,
        animStep: p.animStep,
        moving: p.moving,
        hitTicks: p.hitTicks,
        hitFromRear: p.hitFromRear,
        current: p.current,
        fireCooldown: p.fireCooldown,
        invincible: p.invincible,
        respawnTimer: p.respawnTimer,
        kills: p.kills,
        firingHeld: p.firingHeld,
        weapons: [...p.weapons].map(([id, slot]) => [id, { ...slot }] as [WeaponId, WeaponSlot]),
        held: p.held.map((h) => ({ ...h })),
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id,
        defId: e.defId,
        x: e.x,
        y: e.y,
        angle: e.angle,
        life: e.life,
        maxLife: e.maxLife,
        speed: e.speed,
        state: e.state,
        stateTicks: e.stateTicks,
        animStep: e.animStep,
        attackCooldown: e.attackCooldown,
        windup: e.windup,
        moving: e.moving,
        hitTicks: e.hitTicks,
        hitFromRear: e.hitFromRear,
        targetId: e.targetId,
        hasLos: e.hasLos,
        losTimer: e.losTimer,
        stuckTicks: e.stuckTicks,
        wobblePhase: e.wobblePhase,
      })),
      shots: this.shots.map((s) => ({
        id: s.id,
        ownerId: s.ownerId,
        weapon: s.weapon,
        kind: s.kind,
        x: s.x,
        y: s.y,
        vx: s.vx,
        vy: s.vy,
        angle: s.angle,
        damage: s.damage,
        knockback: s.knockback,
        life: s.life,
        travelled: s.travelled,
        maxRange: s.maxRange,
        pierce: s.pierce,
        splashRadius: s.splashRadius,
        splashDamage: s.splashDamage,
        fuse: s.fuse,
        cluster: s.cluster,
        hits: [...s.hits],
      })),
      placeables: this.placeables.map((p) => ({
        id: p.id,
        type: p.type,
        ownerId: p.ownerId,
        x: p.x,
        y: p.y,
        hp: p.hp,
        armTime: p.armTime,
        fuse: p.fuse,
        triggerRadius: p.triggerRadius,
        splashRadius: p.splashRadius,
        splashDamage: p.splashDamage,
        cluster: p.cluster,
      })),
      pickups: this.pickups.map((p) => ({
        id: p.id,
        type: p.type,
        weapon: p.weapon,
        x: p.x,
        y: p.y,
        amount: p.amount,
      })),
    };
  }

  /** Replace this world's state with a snapshot. */
  restore(snapshot: WorldSnapshot): void {
    this.tick = snapshot.tick;
    this.level = snapshot.level;
    this.score = snapshot.score;
    this.kills = snapshot.kills;
    this.multiplier = snapshot.multiplier;
    this.gameOver = snapshot.gameOver;
    this.rng.setState(snapshot.rng);
    this.levelInfo = levelDef(snapshot.level, this.ramp);

    const progress = snapshot.progress;
    this.spawnedThisLevel = progress.spawnedThisLevel;
    this.killsThisLevel = progress.killsThisLevel;
    this.devilsSpawned = progress.devilsSpawned;
    this.zombieSpawnTimer = progress.zombieSpawnTimer;
    this.devilSpawnTimer = progress.devilSpawnTimer;
    this.multiplierTicks = progress.multiplierTicks;
    this.killsTowardMultiplier = progress.killsTowardMultiplier;
    this.multiKillCount = progress.multiKillCount;
    this.multiKillTicks = progress.multiKillTicks;
    this.waveGrace = progress.waveGrace;
    this.navCursor = progress.navCursor;

    this.nextId = snapshot.ids.next;
    this.freeIds.length = 0;
    this.freeIds.push(...snapshot.ids.free);

    this.map.tiles.set(snapshot.map.tiles);
    this.map.integrity.set(snapshot.map.integrity);
    this.map.revision = snapshot.map.revision;

    // Rebuild every pool, then re-index the broad phase from scratch.
    this.hash.clear();
    this.players.length = 0;
    this.enemies.length = 0;
    this.shots.length = 0;
    this.placeables.length = 0;
    this.pickups.length = 0;
    this.effects.length = 0;
    this.pendingAffects = [];

    for (const p of snapshot.players) {
      const weapons = new Map<WeaponId, WeaponSlot>(p.weapons.map(([id, slot]) => [id, { ...slot }]));
      const player: Player = {
        ...p,
        prevX: p.x,
        prevY: p.y,
        vx: 0,
        vy: 0,
        radius: PLAYER.radius,
        z: 0,
        alive: true,
        speed: PLAYER.speed,
        mass: PLAYER.mass,
        height: PLAYER.height,
        attackCooldown: 0,
        windup: 0,
        weapons,
        held: p.held.map((h) => ({ ...h })),
        stats: computeStats(p.held),
      };
      this.players.push(player);
      this.hash.insert(player.id, player.x, player.y);
    }

    for (const e of snapshot.enemies) {
      const def = ENEMIES[e.defId];
      const enemy: Enemy = {
        ...e,
        prevX: e.x,
        prevY: e.y,
        vx: 0,
        vy: 0,
        alive: true,
        radius: def.radius,
        z: 0,
        mass: def.mass,
        height: def.height,
        chewCx: -1,
        chewCy: -1,
      };
      this.enemies.push(enemy);
      this.hash.insert(enemy.id, enemy.x, enemy.y);
    }

    for (const s of snapshot.shots) {
      this.shots.push({
        ...s,
        prevX: s.x,
        prevY: s.y,
        alive: true,
        radius: 3,
        z: 12,
        hits: new Set(s.hits),
      });
    }

    for (const p of snapshot.placeables) {
      const placeable: Placeable = {
        ...p,
        prevX: p.x,
        prevY: p.y,
        vx: 0,
        vy: 0,
        angle: 0,
        alive: true,
        radius: p.type === 'barrel' ? 13 : 10,
        z: 0,
        detonating: false,
      };
      this.placeables.push(placeable);
      this.hash.insert(placeable.id, placeable.x, placeable.y);
    }

    for (const p of snapshot.pickups) {
      const pickup: Pickup = {
        ...p,
        prevX: p.x,
        prevY: p.y,
        vx: 0,
        vy: 0,
        angle: 0,
        alive: true,
        radius: 12,
        z: 0,
        life: -1,
      };
      this.pickups.push(pickup);
      this.hash.insert(pickup.id, pickup.x, pickup.y);
    }
  }
}

export { CELL_SIZE };
