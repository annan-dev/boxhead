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
import { GameMap, Tile } from '../map/GameMap.js';
import type { ExtractedRoom } from '../art/ArtTypes.js';
import { MapNav } from '../map/MapNav.js';
import {
  circleBlocked,
  circleOverlapsCell,
  hasSightThroughObjects,
  moveCircle,
  raycast,
  sweepClear,
} from '../map/MapCollide.js';
import { SpatialHash } from '../spatial/SpatialHash.js';
import { Rng } from '../math/Rng.js';
import { clamp, distanceSq, TAU } from '../math/MathUtil.js';
import { DEATH, ENEMIES, FIREBALL, attackTiming, type EnemyId } from '../data/enemies.js';
import {
  CHAIN_DELAY_TICKS,
  CLUSTER_SHELL,
  EXTRA_BLAST,
  FAKE_WALL_HP,
  GRENADE,
  ROCKET_ACCELERATION,
  ROCKET_SMOKE,
  ROOM_BARREL_DAMAGE,
  EFFECT_TICKS,
  WEAPONS,
  WEAPON_ORDER,
  explosionFalloff,
  explosionRadius,
  weaponBySlot,
  type WeaponDef,
  type WeaponId,
} from '../data/weapons.js';
import {
  awardsBetween,
  computeStats,
  holdsAmmoTier,
  levelBanner,
  statsFor,
  type Award,
} from '../data/upgrades.js';
import {
  levelDef,
  multiplierWindow,
  streakWindow,
  SCORING,
  type LevelDef,
} from '../data/levels.js';
import {
  HASH_CELL,
  HIT_STUN,
  MAX_THINGS,
  ORIGINAL_CELL,
  ORIGINAL_TICK_RATIO,
  PLAYER,
  SEPARATION,
  DECALS,
} from '../data/tuning.js';
import { MODES } from '../data/modes.js';
import type { GameMode } from '../net/Protocol.js';
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
import { SnapshotError, type SnapshotOptions, type WorldSnapshot } from './Snapshot.js';

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
  room: ExtractedRoom;
  seed?: number;
  playerCount?: number;
  characters?: string[];
  /** Difficulty: the level the run opens on (original presets: 1, 10, 20, 35). */
  startLevel?: number;
  /** Difficulty: the multiplier banked at the start, with its awards (1, 10, 30, 50). */
  startMultiplier?: number;
  /** The original's Devils On/Off option; off, no devil ever spawns. */
  devils?: boolean;
  /** Co-op waves or two-player deathmatch; see `MODES`. Default co-op. */
  mode?: GameMode;
  /**
   * The game speed setting as a factor on the logic rate (0.5, 1, 2). The
   * caller steps the world faster or slower; the original also re-read the
   * rate for a few countdowns that are meant in real seconds, so they get
   * shortened or stretched here to compensate. See `realTicks`.
   */
  speedFactor?: number;
}

const MAX_AFFECT_DEPTH = 4;
/** A range no shot ever reaches; finite so it survives JSON, unlike Infinity. */
const UNLIMITED_RANGE = 1e9;
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
  /**
   * When false, banner messages and score popups are not generated. A client
   * predicting ahead of a server turns this off and shows the server's copies
   * instead, so nothing appears twice. Sounds are unaffected: local feedback
   * must stay immediate. Neither queue touches the generator, so this cannot
   * change how the simulation plays out.
   */
  cosmetics = true;
  /**
   * When true, no new floor marks are recorded. A client replaying ticks it
   * already predicted sets this so the marks it laid the first time are not
   * laid again; the generator is still drawn so the replay stays exact.
   */
  decalsMuted = false;

  tick = 0;
  level = 1;
  score = 0;
  kills = 0;
  multiplier = 1;
  gameOver = false;
  /** Tick the last player fell, so the client can let the death play out. */
  gameOverTick = -1;
  /** Which `MODES` entry governs the rules; part of the snapshot. */
  mode: GameMode = 'coop';
  /** Player index that won a deathmatch, or -1 while nobody has. */
  winnerIndex = -1;

  /** Screen shake amplitude; draw-only, never fed back into the simulation. */
  shake = 0;
  /** White flash intensity, 0-1. */
  flash = 0;
  /** Player-hurt intensity, 0-1; the client draws it as a red vignette. */
  hurt = 0;

  /**
   * Every live entity by id, so neighbour queries resolve in constant time.
   * Shots and effects never enter the broad phase and stay in their own pools.
   */
  private readonly byId: Array<Player | Enemy | Placeable | Pickup | undefined> =
    new Array<Player | Enemy | Placeable | Pickup | undefined>(MAX_THINGS);
  private decalSeq = 0;
  private cosmeticSeq = 0;
  /** Scratch list for swept-shot hits; reused so sweeps never allocate. */
  private readonly sweepHits: Array<{ thing: Enemy | Player | Placeable; distance: number }> = [];

  private levelInfo: LevelDef;
  private spawnedThisLevel = 0;
  private devilsSpawned = 0;
  private zombieSpawnTimer = 0;
  private devilSpawnTimer = 0;
  /** Ticks left before the multiplier drops a step. */
  private multiplierTicks = 0;
  /** Highest multiplier reached; every award at or below it has been granted. */
  private peakMultiplier = 1;
  /** Quick-kill streak, which paces crate drops. */
  private streak = 0;
  private streakTicks = 0;
  private navCursor = 0;
  private waveGrace = 0;

  private nextId = 0;
  private readonly freeIds: number[] = [];
  private pendingAffects: PendingAffect[] = [];
  private readonly devilsActive: boolean;
  private readonly speedFactor: number;

  constructor(options: WorldOptions) {
    this.map = new GameMap(options.room);
    this.rng = new Rng(options.seed ?? 0x5eed);
    this.hash = new SpatialHash(this.map.width, this.map.height, HASH_CELL, MAX_THINGS);
    this.devilsActive = options.devils ?? true;
    this.speedFactor = options.speedFactor ?? 1;
    this.mode = options.mode ?? 'coop';
    this.level = Math.max(1, Math.floor(options.startLevel ?? 1));
    this.levelInfo = levelDef(this.level);
    this.zombieSpawnTimer = this.zombieSpawnPeriod();
    this.devilSpawnTimer = this.levelInfo.devilSpawnRate;
    this.multiplierTicks = this.multiplierTicksFor(1);

    const count = options.playerCount ?? 1;
    for (let i = 0; i < count; i++) {
      this.navs.push(new MapNav(this.map));
      this.spawnPlayer(i, options.characters?.[i] ?? 'swat');
    }
    // The room's own barrels are the class default: 100 damage, a two-cell blast.
    for (const spot of this.map.spawns.barrels) {
      this.addPlaceable('barrel', spot.x, spot.y, -1, {
        splashRadius: explosionRadius(ROOM_BARREL_DAMAGE),
        splashDamage: ROOM_BARREL_DAMAGE,
        cluster: false,
        extraBlasts: 0,
      });
    }
    for (const spot of this.map.spawns.pickups) {
      this.addPickup(spot.x, spot.y, true);
    }
    // The layout marks where destructible walls start the level.
    for (const spot of this.map.spawns.walls) {
      const cell = this.map.cellOf(spot.x, spot.y);
      this.map.buildWall(cell.cx, cell.cy, FAKE_WALL_HP);
    }

    // A harder start banks the multiplier, and with it every award below it,
    // exactly as the original's difficulty setting does.
    // Deathmatch overrides it: the original banks x200 there, the whole arsenal.
    const startMultiplier = Math.max(
      1,
      Math.floor(MODES[this.mode].startMultiplier ?? options.startMultiplier ?? 1),
    );
    if (startMultiplier > 1) this.raiseMultiplier(startMultiplier, true);
    // Deathmatch hands out the arsenal unloaded: `ResetWeapons` empties every
    // weapon but the pistol and draws it. (No level banner at the start
    // either: the original's HUD does not exist yet when level 1 is set.)
    if (MODES[this.mode].startEmpty) {
      for (const player of this.players) {
        for (const [id, slot] of player.weapons) {
          if (!WEAPONS[id].infiniteAmmo) slot.ammo = 0;
        }
        player.current = 'pistol';
      }
    }
  }

  /**
   * Ticks for a span the original measured against its live frame rate, so
   * it lasts the same real time at every game speed: at Fast the world steps
   * twice as often per second, so the span needs twice the ticks.
   */
  private realTicks(ticks: number): number {
    return Math.max(1, Math.round(ticks * this.speedFactor));
  }

  /** The multiplier window with the original's two-tick countdown lag. */
  private multiplierTicksFor(multiplier: number): number {
    return multiplierWindow(multiplier, this.speedFactor) + SCORING.countdownLagTicks;
  }

  /**
   * Ticks between zombie spawns. The original tests the counter before it
   * decrements and fires once it has already reached zero, so each period
   * runs one original tick longer than the table says.
   */
  private zombieSpawnPeriod(): number {
    return this.levelInfo.zombieSpawnRate + ORIGINAL_TICK_RATIO;
  }

  /** Ticks the multiplier holds at its current value; the HUD draws the drain. */
  get multiplierWindow(): number {
    return this.multiplierTicksFor(this.multiplier);
  }

  /** Ticks left on the current multiplier step. */
  get multiplierTicksLeft(): number {
    return this.multiplierTicks;
  }

  /** Highest multiplier reached this run; every award up to it is banked. */
  get awardsBankedUpTo(): number {
    return this.peakMultiplier;
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
    this.byId[id] = undefined;
    this.freeIds.push(id);
  }

  private enemyById(id: number): Enemy | undefined {
    const thing = this.byId[id];
    return thing?.kind === 'enemy' ? thing : undefined;
  }

  private playerById(id: number): Player | undefined {
    const thing = this.byId[id];
    return thing?.kind === 'player' ? thing : undefined;
  }

  private placeableById(id: number): Placeable | undefined {
    const thing = this.byId[id];
    return thing?.kind === 'placeable' ? thing : undefined;
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
      kind: 'player',
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
      pushX: 0,
      pushY: 0,
      stun: 0,
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
      fireHeldTicks: 0,
      detonateMode: false,
      kills: 0,
      score: 0,
      connected: true,
    };
    this.players.push(player);
    this.byId[id] = player;
    this.hash.insert(id, player.x, player.y);
  }

  /**
   * Seat or unseat a player slot. A server builds its world with every seat
   * and flips them as people arrive; an empty seat is a dead player that never
   * respawns, so the horde ignores it. Seating someone respawns them fresh.
   */
  setPlayerConnected(index: number, connected: boolean, characterId?: string): void {
    const player = this.players[index];
    if (!player) return;
    if (characterId !== undefined) player.characterId = characterId;
    if (player.connected === connected) return;
    player.connected = connected;
    if (connected) {
      this.respawn(player);
      return;
    }
    player.state = 'dead';
    player.stateTicks = 0;
    player.respawnTimer = 0;
    player.vx = 0;
    player.vy = 0;
    player.moving = false;
  }

  private addEnemy(defId: EnemyId, x: number, y: number): Enemy | null {
    const id = this.allocId();
    if (id < 0) return null;
    const def = ENEMIES[defId];
    // Every creature of a level shares its speed multiplier, so the horde
    // quickens as the levels climb.
    const speed =
      def.speed *
      this.levelInfo.speedMul *
      (def.speedVariance > 0 ? 1 + this.rng.range(-def.speedVariance, def.speedVariance) : 1);
    const enemy: Enemy = {
      kind: 'enemy',
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
      // A devil holds its fire for its first five original ticks.
      attackCooldown: defId === 'devil' ? 5 * ORIGINAL_TICK_RATIO : 0,
      windup: 0,
      moving: false,
      hitTicks: 0,
      hitFromRear: false,
      pushX: 0,
      pushY: 0,
      stun: 0,
      defId,
      targetId: -1,
      hasLos: false,
      losTimer: this.rng.int(0, 3),
      stuckTicks: 0,
    };
    this.enemies.push(enemy);
    this.byId[id] = enemy;
    this.hash.insert(id, x, y);
    return enemy;
  }

  private addPlaceable(
    type: Placeable['type'],
    x: number,
    y: number,
    ownerId: number,
    stats?: { splashRadius: number; splashDamage: number; cluster: boolean; extraBlasts: number },
  ): void {
    const id = this.allocId();
    if (id < 0) return;
    const weapon = WEAPONS[type === 'barrel' ? 'barrel' : type === 'mine' ? 'mine' : 'chargepack'];
    // In deathmatch a claymore waits for its cell to empty before it arms.
    const armTime = type === 'mine' && MODES[this.mode].minesArmWhenClear ? -1 : (weapon.armTime ?? 0);
    const placeable: Placeable = {
      kind: 'placeable',
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
      // A barrel goes up at the first touch of anything; mines and packs
      // only ever detonate on their own terms.
      hp: type === 'barrel' ? 1 : 25,
      armTime,
      fuse: -1,
      triggerRadius: weapon.triggerRadius ?? 0,
      splashRadius: stats?.splashRadius ?? weapon.splash?.radius ?? 100,
      splashDamage: stats?.splashDamage ?? weapon.splash?.damage ?? 150,
      cluster: stats?.cluster ?? false,
      extraBlasts: stats?.extraBlasts ?? 0,
      detonating: false,
    };
    this.placeables.push(placeable);
    this.byId[id] = placeable;
    this.hash.insert(id, x, y);
    // A barrel is an obstacle to navigation, as the original's Object flag made it.
    if (type === 'barrel') {
      const cell = this.map.cellOf(x, y);
      this.map.setOccupied(cell.cx, cell.cy, true);
    }
  }

  /** Clear a barrel's cell for navigation once it is gone. */
  private releaseBarrelCell(placeable: Placeable): void {
    if (placeable.type !== 'barrel') return;
    const cell = this.map.cellOf(placeable.x, placeable.y);
    // Another live barrel may share the cell (room barrels on one marker).
    for (const other of this.placeables) {
      if (other === placeable || !other.alive || other.type !== 'barrel') continue;
      const otherCell = this.map.cellOf(other.x, other.y);
      if (otherCell.cx === cell.cx && otherCell.cy === cell.cy) return;
    }
    this.map.setOccupied(cell.cx, cell.cy, false);
  }

  /**
   * A crate. What it holds is decided when it is taken (the original's
   * `RandomPickup`), so every crate is the same crate until then.
   */
  private addPickup(x: number, y: number, permanent = false): void {
    const id = this.allocId();
    if (id < 0) return;
    const pickup: Pickup = {
      kind: 'pickup',
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
      type: 'ammo',
      weapon: null,
      amount: 0,
      life: permanent ? -1 : this.realTicks(SCORING.pickupLifeTicks),
      permanent,
      hiddenUntil: 0,
    };
    this.pickups.push(pickup);
    this.byId[id] = pickup;
    this.hash.insert(id, x, y);
  }

  addEffect(
    type: Effect['type'],
    x: number,
    y: number,
    size: number,
    life: number,
    variant = '',
  ): Effect | undefined {
    const id = this.allocId();
    if (id < 0) return undefined;
    const effect: Effect = {
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
      variant,
    };
    this.effects.push(effect);
    return effect;
  }

  /**
   * A handful of small drops thrown away from a hit: a fan around `angle`,
   * `near`..`far` pixels out, each `minSize`..`maxSize` across. Reads as
   * spatter rather than a puddle, and marks the direction the shot came from.
   */
  private spray(
    x: number,
    y: number,
    angle: number,
    color: string,
    count: number,
    near: number,
    far: number,
    minSize: number,
    maxSize: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const spread = angle + this.rng.range(-0.7, 0.7);
      const distance = this.rng.range(near, far);
      this.addDecal(
        'blood',
        x + Math.cos(spread) * distance,
        y + Math.sin(spread) * distance,
        this.rng.range(minSize, maxSize),
        color,
      );
    }
  }

  private addDecal(type: Decal['type'], x: number, y: number, size: number, color: string): void {
    if (this.decals.length >= DECALS.max) this.decals.shift();
    this.decalSeq += 1;
    const seed = this.rng.next();
    if (this.decalsMuted) return;
    this.decals.push({ seq: this.decalSeq, tick: this.tick, x, y, type, size, seed, color });
  }

  private playSound(name: string, x: number, y: number, rate = 1, ownerId = -1): void {
    // Capped so a chain explosion cannot flood the client with requests.
    if (this.sounds.length < 48) this.sounds.push({ name, x, y, rate, ownerId });
  }

  pushMessage(text: string, kind: Message['kind'], life = 130): void {
    if (!this.cosmetics) return;
    this.cosmeticSeq += 1;
    this.messages.push({ seq: this.cosmeticSeq, text, kind, life });
    if (this.messages.length > 6) this.messages.shift();
  }

  private pushPopup(x: number, y: number, text: string, kind: Popup['kind']): void {
    if (!this.cosmetics) return;
    this.cosmeticSeq += 1;
    if (this.popups.length > 24) this.popups.shift();
    this.popups.push({ seq: this.cosmeticSeq, x, y, text, life: 45, kind });
  }

  /** Highest cosmetic sequence number handed out; see `Message.seq`. */
  get cosmeticSequence(): number {
    return this.cosmeticSeq;
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
    // Geometry changed (a wall built or broken, a barrel placed or blown):
    // every field is rebuilt at once, so no creature ever steers on a stale
    // one and a restored world can reproduce the fields exactly.
    for (const nav of this.navs) {
      if (nav.isStale()) nav.refresh();
    }
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
    // Deathmatch has no horde: the original's wave scheduler never runs there.
    if (!MODES[this.mode].zombies) return;
    const info = this.levelInfo;
    let zombiesAlive = 0;
    let devilsAlive = 0;
    for (const enemy of this.enemies) {
      if (enemy.state !== 'alive') continue;
      if (enemy.defId === 'devil') devilsAlive += 1;
      else zombiesAlive += 1;
    }

    // Zombies queue behind the concurrency cap; the timer only runs when
    // there is room for one.
    const zombiesQueued = this.spawnedThisLevel < this.zombieTotal();
    if (zombiesQueued && zombiesAlive < info.maxAlive) {
      this.zombieSpawnTimer -= 1;
      if (this.zombieSpawnTimer <= 0) {
        const weights = info.mix.map((m) => m.weight);
        const chosen = info.mix[this.rng.weighted(weights)]?.id ?? 'zombie';
        if (this.spawnAtEdge(chosen)) {
          this.spawnedThisLevel += 1;
          this.zombieSpawnTimer = this.zombieSpawnPeriod();
        }
      }
    }

    // Devils arrive ten times sooner while any of the wave's zombies are
    // still to be killed (`CUpgrades.Process` tests `Zombie_Count`, which
    // counts the ones left to kill), so they join the wave rather than
    // trailing it.
    const zombiesRemain = zombiesQueued || zombiesAlive > 0;
    if (this.devilsSpawned < this.devilTotal() && devilsAlive < info.devilMaxAlive) {
      this.devilSpawnTimer -= zombiesRemain ? 10 : 1;
      if (this.devilSpawnTimer <= 0) {
        if (this.spawnAtEdge('devil')) {
          this.devilsSpawned += 1;
          this.devilSpawnTimer = info.devilSpawnRate;
        }
      }
    }
  }

  /**
   * Place an enemy on a spawn point, as the original's `Spawn_ValidPosition`
   * does: start at a random point, walk the list in order, and take the first
   * that is clear. Clear means the point's own cell and its entry cell (the
   * first orthogonal neighbour, east, south, west then north, that is not
   * solid map) carry no body and, for zombies, no object: a fake wall or a
   * barrel on the way out of a spawn shuts it, which is how walling off a
   * corridor stops the zombies coming from it. Devils only mind bodies; they
   * raze whatever is in their way. Nothing about the player's view enters
   * into it, so every entrance of a room gets its share; when all of them are
   * blocked the spawn simply waits for the next tick.
   */
  private spawnAtEdge(defId: EnemyId): boolean {
    const devilSpots = this.map.spawns.devils;
    const spots =
      defId === 'devil' && devilSpots.length > 0 ? devilSpots : this.map.spawns.zombies;
    if (spots.length === 0) return false;
    const radius = ENEMIES[defId].radius;
    const start = this.rng.int(0, spots.length - 1);
    for (let i = 0; i < spots.length; i++) {
      const spot = spots[(start + i) % spots.length]!;
      if (this.bodyNear(spot.x, spot.y, radius)) continue;
      if (!this.spawnClear(spot, defId !== 'devil')) continue;
      return this.addEnemy(defId, spot.x, spot.y) !== null;
    }
    return false;
  }

  /** The original's `mCell | mNextCell` test against its no-spawn flags. */
  private spawnClear(spot: { x: number; y: number }, mindObjects: boolean): boolean {
    const cell = this.map.cellOf(spot.x, spot.y);
    const cells: Array<{ cx: number; cy: number }> = [cell];
    const entry = this.entryCell(cell);
    if (entry) cells.push(entry);
    for (const c of cells) {
      if (mindObjects) {
        if (this.map.tileAt(c.cx, c.cy) === Tile.Breakable) return false;
        if (this.map.inBounds(c.cx, c.cy) && this.map.occupied[this.map.index(c.cx, c.cy)]) return false;
      }
      if (c !== cell && this.creatureOverlapsCell(c.cx, c.cy)) return false;
    }
    return true;
  }

  /** True when a living creature already stands on a spot. */
  private bodyNear(x: number, y: number, radius: number): boolean {
    const count = this.hash.queryCircle(x, y, radius + 20, QUERY_BUFFER);
    for (let i = 0; i < count; i++) {
      const thing = this.byId[QUERY_BUFFER[i]!];
      if (!thing || (thing.kind !== 'enemy' && thing.kind !== 'player')) continue;
      if (thing.state !== 'alive') continue;
      const reach = radius + thing.radius;
      if (distanceSq(x, y, thing.x, thing.y) < reach * reach) return true;
    }
    return false;
  }

  private phasePlayers(commands: InputCommand[]): void {
    for (const player of this.players) {
      const command = commands[player.index] ?? emptyCommand();

      if (player.state === 'dying') {
        player.stateTicks += 1;
        if (player.stateTicks > 40) {
          player.state = 'dead';
          player.stateTicks = 0;
          // The body lies there (`State_Dead`) before the respawn wait begins.
          player.respawnTimer = PLAYER.deadTicks + (MODES[this.mode].respawnTicks ?? PLAYER.respawnTicks);
        }
        continue;
      }
      if (player.state === 'dead') {
        // An empty seat stays down until someone takes it, and a finished
        // co-op run brings nobody back.
        if (!player.connected) continue;
        if (this.gameOver && MODES[this.mode].killTarget === null) continue;
        player.stateTicks += 1;
        player.respawnTimer -= 1;
        if (player.respawnTimer <= 0) this.respawn(player);
        continue;
      }

      if (player.invincible > 0) player.invincible -= 1;
      if (player.hitTicks > 0) player.hitTicks -= 1;
      if (player.fireCooldown > 0) player.fireCooldown -= 1;
      // Health comes back on its own, full in thirty seconds.
      player.life = Math.min(player.maxLife, player.life + PLAYER.regenPerTick);

      // Aim follows the pointer; movement is independent of facing.
      player.angle = Math.atan2(command.aimY - player.y, command.aimX - player.x);

      // Shoved by a bite: the player slides and the controls are dead until
      // the slide ends (`State_ZombieHit`).
      if (this.applyStun(player)) {
        player.firingHeld = command.fire;
        player.fireHeldTicks = 0;
        continue;
      }

      const stats = player.stats;
      const speed = player.speed * stats.speedMul;
      // The original scales the raw key axes, so a diagonal is root-two faster.
      const dx = command.moveX;
      const dy = command.moveY;
      player.vx = dx * speed;
      player.vy = dy * speed;
      player.moving = Math.hypot(dx, dy) > 0.01;
      if (player.moving) player.animStep += 1;

      // An empty weapon is swapped for the pistol every tick, not only on a
      // trigger pull (`CThing_Weapon.Update` -> `WeaponEmpty`).
      if (this.weaponEmpty(player, player.current)) {
        this.pushMessage(`${WEAPONS[player.current].name} is out of ammo!`, 'critical', 80);
        this.selectWeapon(player, 'pistol');
      }

      this.applyWeaponSwitch(player, command);
      this.applyFire(player, command);
    }
  }

  /**
   * Slide a creature on its hit shove. True while it is stunned, in which
   * case the caller skips the creature's own control for the tick.
   */
  private applyStun(body: Player | Enemy): boolean {
    if (body.stun <= 0) return false;
    body.stun -= 1;
    body.moving = false;
    if (body.pushX !== 0 || body.pushY !== 0) {
      // The shove is in pixels per original tick and decays per original tick.
      const moved = moveCircle(
        this.map,
        body.x,
        body.y,
        body.pushX / ORIGINAL_TICK_RATIO,
        body.pushY / ORIGINAL_TICK_RATIO,
        body.radius,
      );
      body.x = moved.x;
      body.y = moved.y;
      this.hash.move(body.id, body.x, body.y);
      const decay = Math.pow(HIT_STUN.decay, 1 / ORIGINAL_TICK_RATIO);
      body.pushX *= decay;
      body.pushY *= decay;
      if (Math.hypot(body.pushX, body.pushY) < HIT_STUN.rest) {
        body.pushX = 0;
        body.pushY = 0;
        body.stun = HIT_STUN.sleepTicks;
      }
    }
    body.vx = 0;
    body.vy = 0;
    return true;
  }

  /** Shove a creature and stun it for as long as the slide takes, plus a rest. */
  private shove(body: Player | Enemy, angle: number, pixelsPerOriginalTick: number): void {
    body.pushX = Math.cos(angle) * pixelsPerOriginalTick;
    body.pushY = Math.sin(angle) * pixelsPerOriginalTick;
    // Long enough for the decay to bring the shove under the rest threshold;
    // `applyStun` swaps in the rest as soon as it does.
    body.stun = 1000;
    body.vx = 0;
    body.vy = 0;
  }

  /**
   * The original's `WeaponEmpty`: no ammo left, unless it is unlimited. A
   * charge pack still has work to do while packs are placed and unlit.
   */
  private weaponEmpty(player: Player, id: WeaponId): boolean {
    const def = WEAPONS[id];
    const stats = statsFor(player.stats, id);
    if (def.infiniteAmmo || stats.infiniteAmmo) return false;
    const slot = player.weapons.get(id)!;
    if (slot.ammo > 0) return false;
    if (def.places === 'chargepack' && this.unlitChargePacks(player) > 0) return false;
    return true;
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
      // `NextWeapon` / `PrevWeapon` skip weapons that are owned but empty.
      const usable = WEAPON_ORDER.filter(
        (id) => player.weapons.get(id)?.unlocked && !this.weaponEmpty(player, id),
      );
      if (usable.length === 0) return;
      const at = usable.indexOf(player.current);
      const shift = command.nextWeapon ? 1 : -1;
      const next = usable[(at + shift + usable.length) % usable.length]!;
      this.selectWeapon(player, next);
    }
  }

  private selectWeapon(player: Player, id: WeaponId): void {
    if (player.current === id) return;
    player.current = id;
    // `Reset`: the new weapon fires at once, and a charge pack comes up in
    // detonate mode only when there are packs out and nothing left to place.
    player.fireCooldown = 0;
    player.detonateMode =
      id === 'chargepack' && this.unlitChargePacks(player) > 0 && player.weapons.get(id)!.ammo <= 0;
    // The original announces the switch in its two-player modes only.
    if (this.players.length > 1) this.pushMessage(`${WEAPONS[id].name} selected!`, 'info', 70);
    this.playSound('CLICK', player.x, player.y, 1, player.id);
  }

  private applyFire(player: Player, command: InputCommand): void {
    const def = WEAPONS[player.current];
    const stats = statsFor(player.stats, player.current);
    const slot = player.weapons.get(player.current)!;

    // Fast Fire and Rapid Fire turn a weapon automatic; the grenade throws
    // on release, harder the longer the control was held.
    const auto = def.auto || stats.auto;
    const triggered = def.onRelease
      ? player.firingHeld && !command.fire
      : auto
        ? command.fire
        : command.fire && !player.firingHeld;
    const heldTicks = player.fireHeldTicks;
    player.fireHeldTicks = command.fire ? player.fireHeldTicks + 1 : 0;
    player.firingHeld = command.fire;

    if (!triggered || player.fireCooldown > 0) return;

    // The charge pack alternates: one press places, the next sets every
    // placed pack off, and so on. Detonating costs no ammo and still works
    // with none left, as long as packs are out.
    if (def.places === 'chargepack') {
      if (player.detonateMode || slot.ammo <= 0) {
        if (this.detonateChargePacks(player)) {
          player.detonateMode = false;
          player.fireCooldown = def.fireRate;
        }
        return;
      }
      if (!this.placeObject(player, def, stats.extraBlasts, stats.cluster)) return;
      player.detonateMode = true;
      player.fireCooldown = def.fireRate;
      slot.ammo -= 1;
      return;
    }

    const infinite = def.infiniteAmmo || stats.infiniteAmmo;
    if (!infinite && slot.ammo <= 0) return;

    if (def.places) {
      // A refused placement costs nothing; the player simply tries elsewhere.
      if (!this.placeObject(player, def, stats.extraBlasts, stats.cluster)) return;
    } else {
      const power = def.onRelease
        ? Math.max(GRENADE.minPower, Math.min(1, heldTicks / GRENADE.chargeTicks))
        : 1;
      this.fireProjectiles(player, def, stats, power);
      this.shake += def.shake;
    }
    player.fireCooldown = Math.max(1, stats.fireRate ?? def.fireRate);
    if (!infinite) slot.ammo -= 1;
  }

  /** Placed charge packs of a player whose fuse is not yet lit. */
  private unlitChargePacks(player: Player): number {
    let count = 0;
    for (const placeable of this.placeables) {
      if (!placeable.alive || placeable.type !== 'chargepack') continue;
      if (placeable.ownerId === player.id && placeable.fuse < 0) count += 1;
    }
    return count;
  }

  /** Light the fuses on a player's charge packs. Returns false when there are none. */
  private detonateChargePacks(player: Player): boolean {
    let any = false;
    for (const placeable of this.placeables) {
      if (!placeable.alive || placeable.type !== 'chargepack') continue;
      if (placeable.ownerId !== player.id || placeable.fuse >= 0) continue;
      placeable.fuse = WEAPONS.chargepack.fuse ?? 5;
      any = true;
    }
    if (any) this.playSound('Object.Mine.Detonate', player.x, player.y, 1, player.id);
    return any;
  }

  /**
   * Where a placing weapon would put its object: the grid cell just ahead of
   * the player, as the original's `GetCell` did for barrels, mines and walls
   * alike. `ok` says whether placing there would be accepted right now, so
   * the client can show the cell before the player commits. Null when the
   * player's current weapon does not place anything.
   */
  placementTarget(player: Player): { cx: number; cy: number; x: number; y: number; ok: boolean } | null {
    const def = WEAPONS[player.current];
    if (!def.places) return null;
    const distance = player.radius + 22;
    const cell = this.map.cellOf(
      player.x + Math.cos(player.angle) * distance,
      player.y + Math.sin(player.angle) * distance,
    );
    const centre = this.map.centreOf(cell.cx, cell.cy);
    let ok = this.map.inBounds(cell.cx, cell.cy) && this.map.tileAt(cell.cx, cell.cy) === Tile.Floor;
    if (ok && def.places === 'fakewall') {
      // Never wall a body in: a creature inside a solid cell can never move
      // again, and if it is the player that is the end of the run.
      ok = !this.creatureOverlapsCell(cell.cx, cell.cy);
    } else if (ok) {
      const radius = def.places === 'barrel' ? 13 : 10;
      ok = !circleBlocked(this.map, centre.x, centre.y, radius) && !this.placeableNear(centre.x, centre.y, radius);
      // A barrel is solid, so it must not land on anyone either.
      if (ok && def.places === 'barrel') ok = !this.creatureOverlapsCell(cell.cx, cell.cy);
    }
    return { cx: cell.cx, cy: cell.cy, x: centre.x, y: centre.y, ok };
  }

  /** Place a world object ahead of the player. Returns false when refused. */
  private placeObject(
    player: Player,
    def: WeaponDef,
    extraBlasts: number,
    cluster: boolean,
  ): boolean {
    const target = this.placementTarget(player);
    if (!target || !target.ok) return false;
    const { x, y } = target;

    if (def.places === 'fakewall') {
      if (!this.map.buildWall(target.cx, target.cy, FAKE_WALL_HP)) return false;
      this.playSound('Object.Barrel.Place', x, y, 1, player.id);
      return true;
    }

    const type = def.places === 'barrel' ? 'barrel' : def.places === 'mine' ? 'mine' : 'chargepack';
    this.addPlaceable(type, x, y, player.id, {
      splashRadius: def.splash?.radius ?? 100,
      splashDamage: def.splash?.damage ?? 150,
      cluster,
      extraBlasts,
    });
    this.playSound(type === 'mine' ? 'Weapon.Mine.Place' : 'Object.Barrel.Place', x, y, 1, player.id);
    return true;
  }

  /** True when any living body overlaps a grid cell. */
  private creatureOverlapsCell(cx: number, cy: number): boolean {
    const centre = this.map.centreOf(cx, cy);
    const count = this.hash.queryCircle(centre.x, centre.y, this.map.cell, QUERY_BUFFER);
    for (let i = 0; i < count; i++) {
      const thing = this.byId[QUERY_BUFFER[i]!];
      if (!thing || (thing.kind !== 'player' && thing.kind !== 'enemy')) continue;
      if (thing.state !== 'alive') continue;
      if (circleOverlapsCell(this.map, thing.x, thing.y, thing.radius + 1, cx, cy)) return true;
    }
    return false;
  }

  /** True when a placed object already occupies this spot. */
  private placeableNear(x: number, y: number, radius: number): boolean {
    const count = this.hash.queryCircle(x, y, radius + 13, QUERY_BUFFER);
    for (let i = 0; i < count; i++) {
      const other = this.placeableById(QUERY_BUFFER[i]!);
      if (!other || !other.alive) continue;
      const reach = radius + other.radius;
      if (distanceSq(x, y, other.x, other.y) < reach * reach) return true;
    }
    return false;
  }

  /** The angles a weapon fires at, relative to the aim, as the original lays them out. */
  private shotAngles(def: WeaponDef, wideShot: number): number[] {
    if (def.kind !== 'pellet') return [0];
    // Shotgun: a centre ray, then pairs to either side. Wide Shot and Wider
    // Shot add a second pair and open the step between them.
    const step = def.spread * (wideShot + 1);
    const angles = [0];
    const pairs = wideShot > 0 ? 2 : 1;
    for (let i = 1; i <= pairs; i++) angles.push(-step * i, step * i);
    return angles;
  }

  private fireProjectiles(
    player: Player,
    def: WeaponDef,
    stats: ReturnType<typeof statsFor>,
    power: number,
  ): void {
    const muzzle = player.radius + 12;
    const originX = player.x + Math.cos(player.angle) * muzzle;
    const originY = player.y + Math.sin(player.angle) * muzzle;
    const range = def.range * stats.rangeMul;
    // A hitscan shot covers its whole range on the tick it is fired.
    const speed = def.hitscan ? range : def.speed * power;

    for (const offset of this.shotAngles(def, stats.wideShot)) {
      const angle = player.angle + offset;
      const id = this.allocId();
      if (id < 0) return;
      const shot: Shot = {
        id,
        alive: true,
        x: originX,
        y: originY,
        prevX: originX,
        prevY: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        angle,
        radius: 3,
        z: def.kind === 'grenade' ? GRENADE.startZ : 12,
        ownerId: player.id,
        weapon: def.id,
        kind: def.kind,
        damage: def.damage * stats.damageMul,
        knockback: def.knockback,
        // Hitscan shots resolve on their first tick and linger as a tracer.
        life: def.kind === 'grenade' ? (def.fuse ?? 120) : def.hitscan ? EFFECT_TICKS.tracer : 300,
        travelled: 0,
        maxRange: range,
        pierce: def.pierce ?? false,
        splashRadius: def.splash?.radius ?? 0,
        splashDamage: def.splash?.damage ?? 0,
        fuse: def.kind === 'grenade' ? (def.fuse ?? 120) : -1,
        hits: new Set<number>(),
        cluster: stats.cluster,
        extraBlasts: def.splash ? stats.extraBlasts : 0,
        wallDamage: def.splash?.damage ?? def.damage * stats.damageMul,
        vz: def.kind === 'grenade' ? GRENADE.launchVz * power : 0,
        hitscan: def.hitscan ?? false,
      };
      this.shots.push(shot);
    }

    const flash = this.addEffect('muzzle', originX, originY, 14, EFFECT_TICKS.muzzle, def.id);
    if (flash) flash.angle = player.angle;
    this.playSound(this.fireSound(def.id), player.x, player.y, this.rng.range(0.94, 1.06), player.id);
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

  /**
   * Bring a fallen player back. The original picks the player spawn point
   * nearest the other player in co-op (`Spawn_ValidPosition_Close`) and the
   * farthest in deathmatch (`Spawn_ValidPosition_Far`); with nobody else
   * standing, the seat's own point serves.
   */
  private respawn(player: Player): void {
    const own = this.map.spawns.players[player.index] ??
      this.map.spawns.players[0] ?? { x: this.map.width / 2, y: this.map.height / 2 };
    let spot = own;
    const other = this.players.find((p) => p !== player && p.state === 'alive');
    if (other && this.map.spawns.players.length > 1) {
      const near = MODES[this.mode].respawnNear;
      let best = near ? Infinity : -Infinity;
      for (const candidate of this.map.spawns.players) {
        if (this.bodyNear(candidate.x, candidate.y, player.radius)) continue;
        const d = distanceSq(candidate.x, candidate.y, other.x, other.y);
        if (near ? d < best : d > best) {
          best = d;
          spot = candidate;
        }
      }
    }
    player.x = spot.x;
    player.y = spot.y;
    player.prevX = spot.x;
    player.prevY = spot.y;
    player.life = player.maxLife;
    player.state = 'alive';
    player.stateTicks = 0;
    player.pushX = 0;
    player.pushY = 0;
    player.stun = 0;
    player.invincible = MODES[this.mode].respawnInvincibleTicks ?? PLAYER.respawnInvincibleTicks;
    this.hash.move(player.id, player.x, player.y);
  }

  // ---- enemies ------------------------------------------------------------

  private phaseEnemies(): void {
    for (const enemy of this.enemies) {
      if (enemy.state === 'dying') {
        // The fall plays out, then the body lies there as a corpse.
        enemy.stateTicks += 1;
        if (enemy.stateTicks >= DEATH.dyingTicks) {
          enemy.state = 'dead';
          enemy.stateTicks = 0;
        }
        continue;
      }
      if (enemy.state === 'dead') {
        enemy.stateTicks += 1;
        continue;
      }
      if (enemy.state !== 'alive') continue;

      if (enemy.hitTicks > 0) enemy.hitTicks -= 1;
      if (enemy.attackCooldown > 0) enemy.attackCooldown -= 1;

      // A hit stops everything: the creature slides, then rests.
      if (this.applyStun(enemy)) {
        enemy.windup = 0;
        continue;
      }

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
        // Only solid map cells block sight (`Collide_Line` against
        // `mCollide_NonShootable`): a devil aims straight through barrels
        // and fake walls, and its fireball bursts on them instead.
        const range = def.attack.kind === 'ranged' ? def.attack.reach + 60 : 340;
        enemy.hasLos =
          distanceSq(enemy.x, enemy.y, target.x, target.y) < range * range &&
          hasSightThroughObjects(this.map, enemy.x, enemy.y, target.x, target.y);
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
      const speedCells = (enemy.speed * ORIGINAL_TICK_RATIO) / ORIGINAL_CELL;

      if (def.attack.kind === 'melee' && distanceToTarget <= reach) {
        // A zombie bites when the player stands in the next cell: the attack
        // clip runs at a pace tied to its speed and lands on the last frame.
        if (enemy.attackCooldown <= 0) {
          enemy.windup = attackTiming(enemy.defId, speedCells).windup;
          enemy.attackCooldown = enemy.windup + def.attack.cooldown;
        }
        enemy.vx = 0;
        enemy.vy = 0;
        enemy.moving = false;
        enemy.angle = Math.atan2(toTargetY, toTargetX);
        continue;
      }
      if (def.attack.kind === 'ranged' && enemy.hasLos && distanceToTarget < def.attack.reach) {
        // The devil throws only once it already faces the player's direction
        // (`State_Attack_Decision` compares eight-way directions); otherwise
        // it keeps walking and reconsiders. It stands still to throw, and the
        // clip length is the only pause between throws.
        const facing = Math.round((enemy.angle / TAU) * 8);
        const wanted = Math.round((Math.atan2(toTargetY, toTargetX) / TAU) * 8);
        if (enemy.attackCooldown <= 0 && ((facing - wanted) % 8 + 8) % 8 === 0) {
          const timing = attackTiming(enemy.defId, speedCells);
          enemy.windup = timing.windup;
          enemy.attackCooldown = timing.total;
          enemy.vx = 0;
          enemy.vy = 0;
          enemy.moving = false;
          continue;
        }
      }

      // Steer toward the farthest point along the flow-field route that can
      // be reached in a straight slide (the original's `Nav_Direction` also
      // prefers the direct line to the player whenever it shortens the way),
      // so a crowd cuts corners cleanly rather than staircasing cell by cell.
      const goal = this.steerGoal(enemy, target);
      let dirX = goal.x - enemy.x;
      let dirY = goal.y - enemy.y;
      const goalLength = Math.hypot(dirX, dirY) || 1;
      dirX /= goalLength;
      dirY /= goalLength;

      const separation = this.separationFor(enemy);
      dirX += separation.x;
      dirY += separation.y;
      const steerLength = Math.hypot(dirX, dirY) || 1;

      enemy.vx = (dirX / steerLength) * enemy.speed;
      enemy.vy = (dirY / steerLength) * enemy.speed;
      enemy.angle = this.facing(enemy.angle, Math.atan2(enemy.vy, enemy.vx));
      enemy.moving = true;
      enemy.animStep += 1;
    }
  }

  /**
   * One of eight facings, kept until the heading has clearly left the
   * current sector. Without the hysteresis a body jostled by a crowd flips
   * between two facings every tick, which reads as flicker.
   */
  private facing(current: number, heading: number): number {
    const sector = TAU / 8;
    let delta = heading - current;
    delta -= Math.round(delta / TAU) * TAU;
    if (Math.abs(delta) <= sector / 2 + 0.22) return current;
    const snapped = (Math.round(heading / sector) * sector) % TAU;
    return snapped < 0 ? snapped + TAU : snapped;
  }

  /**
   * Where a creature should head this tick: the player if the slide there is
   * clear, else the farthest cell centre along the flow route it can slide
   * to, else the next cell, else straight at the player.
   */
  private steerGoal(enemy: Enemy, target: Player): { x: number; y: number } {
    const nav = this.navFor(target);
    const cell = this.map.cellOf(enemy.x, enemy.y);
    if (sweepClear(this.map, enemy.x, enemy.y, target.x, target.y, enemy.radius)) {
      return { x: target.x, y: target.y };
    }
    let cx = cell.cx;
    let cy = cell.cy;
    let best: { x: number; y: number } | null = null;
    for (let i = 0; i < 8; i++) {
      const step = nav?.stepAt(cx, cy);
      if (!step) break;
      cx += step[0];
      cy += step[1];
      const centre = this.map.centreOf(cx, cy);
      if (i > 0 && !sweepClear(this.map, enemy.x, enemy.y, centre.x, centre.y, enemy.radius)) break;
      best = centre;
    }
    return best ?? { x: target.x, y: target.y };
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

  private resolveEnemyAttack(enemy: Enemy, target: Player): void {
    const def = ENEMIES[enemy.defId];
    if (def.attack.kind === 'ranged') {
      this.throwFireball(enemy, Math.atan2(target.y - enemy.y, target.x - enemy.x), false);
      return;
    }

    // The bite lands on whatever stands in the cell ahead; the player has a
    // moment to step out of it while the clip plays.
    const reach = enemy.radius + target.radius + def.attack.reach + 12;
    if (distanceSq(enemy.x, enemy.y, target.x, target.y) <= reach * reach) {
      const protectedBefore = target.invincible > 0;
      this.damagePlayer(target, def.attack.damage, enemy.x, enemy.y);
      // The bite shoves the player away and stuns them for the slide; spawn
      // protection discards the whole affect, shove included.
      if (!protectedBefore && target.state === 'alive') {
        this.shove(target, Math.atan2(target.y - enemy.y, target.x - enemy.x), PLAYER.biteShove);
      }
      this.playSound('Creature.Zombie.Attack', enemy.x, enemy.y, this.rng.range(0.9, 1.1));
    }
  }

  /**
   * A devil's fireball (`CThing_Shot_FireBall`). Aimed at a player it is a
   * small burst carrying the devil's damage; aimed at an object in the
   * devil's way it is a cell across and razes walls and barrels.
   */
  private throwFireball(enemy: Enemy, angle: number, atObject: boolean): void {
    const id = this.allocId();
    if (id < 0) return;
    const reach = enemy.radius * FIREBALL.spawnReach;
    const x = enemy.x + Math.cos(angle) * reach;
    const y = enemy.y + Math.sin(angle) * reach;
    this.shots.push({
      id,
      alive: true,
      x,
      y,
      prevX: enemy.x,
      prevY: enemy.y,
      vx: Math.cos(angle) * FIREBALL.speed,
      vy: Math.sin(angle) * FIREBALL.speed,
      angle,
      radius: atObject ? FIREBALL.objectSplashRadius / 2 : FIREBALL.radius,
      z: FIREBALL.spawnZ,
      // Negative owner marks an enemy projectile.
      ownerId: -2,
      weapon: 'pistol',
      kind: 'fireball',
      damage: FIREBALL.damage,
      knockback: 0,
      // It flies until it hits something.
      life: UNLIMITED_RANGE,
      travelled: 0,
      maxRange: UNLIMITED_RANGE,
      pierce: false,
      splashRadius: atObject ? FIREBALL.objectSplashRadius : FIREBALL.splashRadius,
      splashDamage: FIREBALL.damage,
      fuse: -1,
      // The thrower is never its own target.
      hits: new Set<number>([enemy.id]),
      cluster: false,
      extraBlasts: 0,
      wallDamage: atObject ? FIREBALL.objectDamage : FIREBALL.damage,
      vz: 0,
      hitscan: false,
    });
    enemy.angle = angle;
    this.playSound('Creature.Zombie.Attack', enemy.x, enemy.y, 0.8);
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
      const moved = this.inBorder(enemy)
        ? this.moveFromBorder(enemy)
        : moveCircle(this.map, enemy.x, enemy.y, enemy.vx, enemy.vy, enemy.radius);
      enemy.x = moved.x;
      enemy.y = moved.y;
      this.hash.move(enemy.id, enemy.x, enemy.y);

      // Wedged against something: a zombie simply waits, as the original's
      // do, but a devil razes whatever object is in its way.
      const progress = Math.hypot(enemy.x - beforeX, enemy.y - beforeY);
      if (enemy.moving && progress < enemy.speed * 0.25) {
        enemy.stuckTicks += 1;
        if (enemy.stuckTicks > 12 && enemy.defId === 'devil') {
          this.razeObstacle(enemy);
          enemy.stuckTicks = 0;
        }
      } else {
        enemy.stuckTicks = 0;
      }
    }

    for (const shot of this.shots) {
      if (!shot.alive) continue;
      // A hitscan shot has already covered its range; it only lingers to draw.
      if (shot.hitscan && shot.travelled > 0) continue;
      if (shot.kind === 'grenade') {
        // A lob: it falls, bounces with half its pace, and on the ground
        // loses half its pace every original tick until it stops.
        shot.vz -= GRENADE.gravity;
        shot.z += shot.vz;
        if (shot.z <= 0) {
          shot.z = 0;
          if (shot.vz < -0.8) {
            shot.vz = -shot.vz * GRENADE.floorBounce;
            shot.vx *= GRENADE.floorBounce;
            shot.vy *= GRENADE.floorBounce;
            this.playSound('Shot.Grenade.Bounce', shot.x, shot.y, this.rng.range(0.95, 1.05));
          } else {
            shot.vz = 0;
            shot.vx *= GRENADE.groundDrag;
            shot.vy *= GRENADE.groundDrag;
            if (shot.vx * shot.vx + shot.vy * shot.vy < 0.01) {
              shot.vx = 0;
              shot.vy = 0;
            }
          }
        }
      } else if (shot.kind === 'fireball') {
        shot.vx *= FIREBALL.acceleration;
        shot.vy *= FIREBALL.acceleration;
      } else if (shot.kind === 'rocket') {
        shot.vx *= ROCKET_ACCELERATION;
        shot.vy *= ROCKET_ACCELERATION;
        // The exhaust: a puff dropped at the rocket every original tick, sent
        // back along its path.
        if (this.tick % ROCKET_SMOKE.every === 0) {
          const puff = this.addEffect('rocketsmoke', shot.x, shot.y, 10, ROCKET_SMOKE.life);
          if (puff) {
            puff.vx = -Math.cos(shot.angle) * ROCKET_SMOKE.speed;
            puff.vy = -Math.sin(shot.angle) * ROCKET_SMOKE.speed;
          }
        }
      }
      shot.x += shot.vx;
      shot.y += shot.vy;
      shot.travelled += Math.hypot(shot.vx, shot.vy);
    }
  }

  /**
   * A devil with an object in its way (`State_GotoPlayer`, cell ahead flagged
   * Object) throws a cell-wide fireball at it that razes a wall or sets off
   * a barrel in one hit. Zombies have no such move.
   */
  private razeObstacle(enemy: Enemy): void {
    const ahead = enemy.radius + 14;
    const x = enemy.x + Math.cos(enemy.angle) * ahead;
    const y = enemy.y + Math.sin(enemy.angle) * ahead;
    const cell = this.map.cellOf(x, y);

    let blocked = this.map.tileAt(cell.cx, cell.cy) === Tile.Breakable;
    if (!blocked) {
      const count = this.hash.queryCircle(enemy.x, enemy.y, enemy.radius + 20, QUERY_BUFFER);
      for (let i = 0; i < count; i++) {
        const placeable = this.placeableById(QUERY_BUFFER[i]!);
        if (!placeable || !placeable.alive || placeable.type !== 'barrel') continue;
        const reach = enemy.radius + placeable.radius + 6;
        if (distanceSq(enemy.x, enemy.y, placeable.x, placeable.y) > reach * reach) continue;
        const facing =
          Math.cos(enemy.angle) * (placeable.x - enemy.x) +
          Math.sin(enemy.angle) * (placeable.y - enemy.y);
        if (facing > 0) {
          blocked = true;
          break;
        }
      }
    }
    if (!blocked) return;
    const timing = attackTiming(enemy.defId, (enemy.speed * ORIGINAL_TICK_RATIO) / ORIGINAL_CELL);
    enemy.attackCooldown = timing.total;
    this.throwFireball(enemy, enemy.angle, true);
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
        if (enemy.state === 'alive') this.separateBody(enemy);
      }
      for (const player of this.players) {
        if (player.state === 'alive') this.separateBody(player);
      }
    }
  }

  /**
   * Push one body out of everything it overlaps: creatures among themselves
   * by mass, barrels as immovable posts, and the player out of every
   * creature it touches while the creature stands its ground, which is how
   * the original's `PlayerCollide` treats the horde as so many posts.
   */
  private separateBody(body: Enemy | Player): void {
    const count = this.hash.queryCircle(body.x, body.y, body.radius + 24, QUERY_BUFFER);

    let pushX = 0;
    let pushY = 0;
    for (let i = 0; i < count; i++) {
      const id = QUERY_BUFFER[i]!;
      if (id === body.id) continue;
      const other = this.byId[id];
      if (!other) continue;

      let otherRadius: number;
      let share: number;
      if (other.kind === 'enemy' || other.kind === 'player') {
        if (other.state !== 'alive') continue;
        otherRadius = other.radius;
        if (body.kind === 'player' && other.kind === 'enemy') share = 1;
        else if (body.kind === 'enemy' && other.kind === 'player') continue;
        // Heavier bodies give ground more slowly.
        else share = other.mass / (body.mass + other.mass);
      } else if (other.kind === 'placeable' && other.type === 'barrel' && other.alive) {
        otherRadius = other.radius;
        share = 1;
      } else {
        continue;
      }

      const dx = other.x - body.x;
      const dy = other.y - body.y;
      const want = body.radius + otherRadius;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= want * want || distanceSquared === 0) continue;

      const d = Math.sqrt(distanceSquared);
      const overlap = (want - d) * SEPARATION.strength;
      pushX -= (dx / d) * overlap * share;
      pushY -= (dy / d) * overlap * share;
    }

    if (pushX !== 0 || pushY !== 0) {
      const moved = moveCircle(this.map, body.x, body.y, pushX, pushY, body.radius);
      body.x = moved.x;
      body.y = moved.y;
    }
    this.unstick(body);
    this.hash.move(body.id, body.x, body.y);
  }

  /**
   * Recover a body that has ended up inside geometry, which can still happen
   * when a wall is built on top of it. Without this the creature is immobile
   * and unkillable, and the wave can never finish.
   */
  /**
   * True for a creature standing in the map's solid edge ring, where the
   * original's spawn markers sit: it is not stuck, it is waiting to enter.
   */
  private inBorder(creature: Enemy | Player): boolean {
    const cell = this.map.cellOf(creature.x, creature.y);
    return creature.kind === 'enemy' && this.map.tileAt(cell.cx, cell.cy) === Tile.Solid;
  }

  /**
   * A creature in the border walks straight out through its entry cell, the
   * first open neighbour east, south, west then north (the original's
   * `ValidMoveDirection`), and only once that cell is passable: a wall
   * standing there holds it in the dark until the wall falls.
   */
  private moveFromBorder(enemy: Enemy): { x: number; y: number } {
    const cell = this.map.cellOf(enemy.x, enemy.y);
    const entry = this.entryCell(cell);
    if (!entry || !this.map.passable(entry.cx, entry.cy)) return { x: enemy.x, y: enemy.y };
    const centre = this.map.centreOf(entry.cx, entry.cy);
    const dx = centre.x - enemy.x;
    const dy = centre.y - enemy.y;
    const distance = Math.hypot(dx, dy) || 1;
    const step = Math.min(distance, enemy.speed);
    return { x: enemy.x + (dx / distance) * step, y: enemy.y + (dy / distance) * step };
  }

  /** The first non-solid orthogonal neighbour, east, south, west, north; null when walled in. */
  private entryCell(cell: { cx: number; cy: number }): { cx: number; cy: number } | null {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const cx = cell.cx + dx;
      const cy = cell.cy + dy;
      if (this.map.tileAt(cx, cy) !== Tile.Solid) return { cx, cy };
    }
    return null;
  }

  private unstick(creature: Enemy | Player): void {
    if (this.inBorder(creature)) return;
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
          this.explodeShot(shot, shot.x, shot.y);
          shot.alive = false;
          continue;
        }
      }
      // A hitscan shot has covered its whole range on its first tick and is
      // resolved then; after that it is only a tracer fading out.
      if (shot.hitscan && shot.life < EFFECT_TICKS.tracer - 1) {
        if (shot.life <= 0) shot.alive = false;
        continue;
      }
      if (shot.life <= 0 || (!shot.hitscan && shot.travelled > shot.maxRange)) {
        // Anything explosive goes off where it stops, grenades included.
        if (shot.splashRadius > 0) this.explodeShot(shot, shot.x, shot.y);
        shot.alive = false;
        continue;
      }

      // Sweep the segment travelled this tick so fast shots cannot tunnel.
      // Grenades roll past bodies and only ever go off on their fuse.
      const wall = raycast(this.map, shot.prevX, shot.prevY, shot.x, shot.y);
      const hit = shot.kind === 'grenade' ? false : this.sweepTargets(shot, wall?.distance ?? Infinity);

      if (hit) continue;
      if (wall) {
        if (shot.kind === 'grenade') {
          // Grenades bounce off walls, keeping a quarter of their pace:
          // reflected about the face they struck, not simply reversed.
          const dx = shot.x - shot.prevX;
          const dy = shot.y - shot.prevY;
          const probe = moveCircle(this.map, shot.prevX, shot.prevY, dx, dy, shot.radius);
          shot.x = shot.prevX;
          shot.y = shot.prevY;
          if (probe.hitX) shot.vx = -shot.vx;
          if (probe.hitY) shot.vy = -shot.vy;
          if (!probe.hitX && !probe.hitY) {
            shot.vx = -shot.vx;
            shot.vy = -shot.vy;
          }
          shot.vx *= GRENADE.wallBounce;
          shot.vy *= GRENADE.wallBounce;
          this.playSound('Shot.Grenade.Bounce', shot.x, shot.y);
          continue;
        }
        if (shot.splashRadius > 0) {
          this.explodeShot(shot, wall.x, wall.y);
        } else {
          // A bullet into a barricade wears it down by its damage
          // (`CThing_Object_Wall` accepts the Bullet affect).
          this.damageWallCell(wall.cx, wall.cy, shot.damage);
          this.addEffect('spark', wall.x, wall.y, 8, EFFECT_TICKS.bulletHit);
          this.addDecal('pock', wall.x, wall.y, 4, '#1d1d1f');
          this.playSound(`Shot.HitWall.${this.rng.int(1, 3)}`, wall.x, wall.y, this.rng.range(0.9, 1.1));
        }
        this.endShot(shot, wall.x, wall.y);
      }
    }
  }

  /** A shot's own blast, with everything the shot carries. */
  private explodeShot(shot: Shot, x: number, y: number): void {
    this.explode(x, y, shot.splashRadius, shot.splashDamage, shot.ownerId, shot.cluster, 0, {
      extraBlasts: shot.extraBlasts,
      wallDamage: shot.wallDamage,
    });
  }

  /**
   * Wear down a barricade cell. Destroyed, it leaves smoke and a scorch mark
   * (`CThing_Object_Wall.ProcessAffects`).
   */
  private damageWallCell(cx: number, cy: number, amount: number): void {
    if (this.map.tileAt(cx, cy) !== Tile.Breakable) return;
    if (this.map.damageWall(cx, cy, amount)) {
      const centre = this.map.centreOf(cx, cy);
      this.addEffect('smoke', centre.x, centre.y, 26, EFFECT_TICKS.smokeCloud);
      this.addDecal('scorch', centre.x, centre.y, 18, '#101014');
      this.playSound('Shot.HitWall.1', centre.x, centre.y);
    }
  }

  /**
   * Retire a shot at a point. A hitscan tracer stays one more tick, cut to
   * where it struck, so the line on screen ends at the target.
   */
  private endShot(shot: Shot, x: number, y: number): void {
    if (shot.hitscan) {
      shot.x = x;
      shot.y = y;
      shot.travelled = shot.maxRange;
      return;
    }
    shot.alive = false;
  }

  /**
   * Test a shot's swept segment against creatures.
   * Returns true when the shot was consumed.
   */
  private sweepTargets(shot: Shot, wallDistance: number): boolean {
    const enemyProjectile = shot.ownerId === -2;
    const count = this.hash.querySegment(shot.prevX, shot.prevY, shot.x, shot.y, QUERY_BUFFER);

    const hits = this.sweepHits;
    hits.length = 0;
    for (let i = 0; i < count; i++) {
      const id = QUERY_BUFFER[i]!;
      if (shot.hits.has(id)) continue;

      const thing = this.byId[id];
      if (!thing) continue;
      if (enemyProjectile) {
        // A fireball stops on any collidable body: a player, a zombie, a
        // devil or a barrel (`GenericCollide` -> `Collide_Mapwho`). It flies
        // over mines and packs.
        const barrel = thing.kind === 'placeable' && thing.alive && thing.type === 'barrel';
        const player = thing.kind === 'player' && thing.state === 'alive' && thing.invincible <= 0;
        const creature = thing.kind === 'enemy' && thing.state === 'alive';
        if (!barrel && !player && !creature) continue;
      } else if (thing.kind === 'enemy') {
        if (thing.state !== 'alive') continue;
      } else if (thing.kind === 'player') {
        // Versus play: the other player is a target. Nobody hits themselves,
        // which is the one exclusion the original's line test makes.
        if (!MODES[this.mode].playersHurtEachOther || thing.id === shot.ownerId) continue;
        if (thing.state !== 'alive' || thing.invincible > 0) continue;
      } else if (thing.kind !== 'placeable' || !thing.alive || thing.type !== 'barrel') {
        // Player fire hits zombies and barrels: shooting a barrel is how the
        // original sets off a chain from a safe distance. Mines and charge
        // packs accept no affect at all, so shots pass over them.
        continue;
      }

      const distance = this.segmentHitDistance(shot, thing.x, thing.y, thing.radius);
      if (distance === null || distance > wallDistance) continue;
      hits.push({ thing, distance });
    }
    if (hits.length === 0) return false;
    hits.sort((a, b) => a.distance - b.distance);

    const first = hits[0]!.thing;
    shot.hits.add(first.id);

    if (enemyProjectile) {
      // The fireball bursts where it lands: a half-cell area that hurts
      // whatever is in it, zombies included, and sets off a barrel.
      this.explodeShot(shot, first.x, first.y);
      shot.alive = false;
      return true;
    }

    if (shot.splashRadius > 0) {
      this.explodeShot(shot, first.x, first.y);
      shot.alive = false;
      return true;
    }

    if (!shot.pierce) {
      this.damageThing(first, shot);
      this.endShot(shot, first.x, first.y);
      return true;
    }

    // A piercing shot runs through everything on the segment, nearest first.
    for (const hit of hits) {
      shot.hits.add(hit.thing.id);
      this.damageThing(hit.thing, shot);
    }
    hits.length = 0;
    return false;
  }

  /** Apply a player's shot to whatever it struck. */
  private damageThing(thing: Enemy | Placeable | Player, shot: Shot): void {
    if (thing.kind === 'player') {
      this.damagePlayer(thing, shot.damage, shot.prevX, shot.prevY, shot.ownerId);
      return;
    }
    if (thing.kind === 'enemy') {
      this.damageEnemy(thing, shot.damage, shot.angle, false, shot.ownerId);
      return;
    }
    // One bullet is enough: a barrel goes up on the first hit, as in the original.
    if (thing.type === 'barrel') this.detonate(thing);
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
      else if (placeable.armTime < 0) {
        // Deathmatch claymores arm once nobody stands on their cell.
        const cell = this.map.cellOf(placeable.x, placeable.y);
        if (!this.creatureOverlapsCell(cell.cx, cell.cy)) placeable.armTime = 0;
      }

      // A lit fuse counts down to the bang.
      if (placeable.fuse > 0) {
        placeable.fuse -= 1;
        if (placeable.fuse === 0) {
          this.detonate(placeable);
          continue;
        }
      }

      // A claymore trips when a zombie steps on it, then beeps for two
      // seconds before it goes off, as the original's does.
      if (placeable.type === 'mine' && placeable.armTime === 0 && placeable.fuse < 0) {
        // Widened by the largest body radius, since the trip test below adds it.
        const count = this.hash.queryCircle(
          placeable.x,
          placeable.y,
          placeable.triggerRadius + 16,
          QUERY_BUFFER,
        );
        for (let i = 0; i < count; i++) {
          const thing = this.byId[QUERY_BUFFER[i]!];
          // In deathmatch the original arms them against players as well.
          const trips =
            thing?.kind === 'enemy' || (thing?.kind === 'player' && MODES[this.mode].minesTripPlayers);
          if (!trips || thing.state !== 'alive') continue;
          const enemy = thing;
          const reach = placeable.triggerRadius + enemy.radius;
          if (distanceSq(placeable.x, placeable.y, enemy.x, enemy.y) > reach * reach) continue;
          placeable.fuse = WEAPONS.mine.fuse ?? 100;
          this.playSound('Object.Mine.Detonate', placeable.x, placeable.y);
          break;
        }
      }
    }
  }

  /** Blow a placed object up now. */
  private detonate(placeable: Placeable, depth = 0): void {
    if (!placeable.alive) return;
    placeable.detonating = true;
    placeable.alive = false;
    this.releaseBarrelCell(placeable);
    this.explode(
      placeable.x,
      placeable.y,
      placeable.splashRadius,
      placeable.splashDamage,
      placeable.ownerId,
      placeable.cluster,
      depth,
      { extraBlasts: placeable.extraBlasts, wallDamage: placeable.splashDamage },
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
    extras: { extraBlasts?: number; wallDamage?: number; delay?: number } = {},
  ): void {
    if (depth > MAX_AFFECT_DEPTH) return;
    const delay = extras.delay ?? 0;
    this.pendingAffects.push({
      x,
      y,
      radius,
      damage,
      wallDamage: extras.wallDamage ?? damage,
      ownerId,
      cluster,
      extraBlasts: extras.extraBlasts ?? 0,
      delay,
      announce: delay > 0,
      depth,
    });
    if (delay === 0) this.announceBlast(x, y, radius);
  }

  /** The picture and sound of a blast. */
  private announceBlast(x: number, y: number, radius: number): void {
    this.addEffect('explosion', x, y, radius, EFFECT_TICKS.explosion);
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
      // A delayed blast (Big Bang's followers) waits its turn.
      if (affect.delay > 0) {
        affect.delay -= 1;
        this.pendingAffects.push(affect);
        continue;
      }
      if (affect.announce) {
        affect.announce = false;
        this.announceBlast(affect.x, affect.y, affect.radius);
      }

      // A devil's fireball burst is flat over its little area; a proper
      // explosion falls off in the original's three rings: full damage close
      // in, then 75%, then half.
      const fireball = affect.ownerId === -2;
      const count = this.hash.queryCircle(affect.x, affect.y, affect.radius, QUERY_BUFFER);
      for (let i = 0; i < count; i++) {
        const id = QUERY_BUFFER[i]!;
        const enemy = this.enemyById(id);
        if (enemy) {
          if (enemy.state !== 'alive') continue;
          const d = Math.hypot(enemy.x - affect.x, enemy.y - affect.y);
          if (d > affect.radius) continue;
          const falloff = fireball ? 1 : explosionFalloff(d / affect.radius);
          const angle = Math.atan2(enemy.y - affect.y, enemy.x - affect.x);
          this.damageEnemy(enemy, affect.damage * falloff, angle, !fireball, affect.ownerId);
          continue;
        }
        const player = this.playerById(id);
        if (player && player.state === 'alive' && player.invincible <= 0) {
          // Your own blasts hurt exactly as much: stand clear of the barrels.
          // Another player's blast lands only where the mode says so; a blast
          // nobody owns -- room barrels, devils -- lands on everyone.
          if (affect.ownerId >= 0 && affect.ownerId !== player.id) {
            const mode = MODES[this.mode];
            if (!mode.playersHurtEachOther && !mode.friendlyFire) continue;
          }
          const d = Math.hypot(player.x - affect.x, player.y - affect.y);
          if (d > affect.radius) continue;
          const falloff = fireball ? 1 : explosionFalloff(d / affect.radius);
          this.damagePlayer(player, affect.damage * falloff, affect.x, affect.y, affect.ownerId);
        }
      }

      // Barricades in the blast take it too (`CThing_Object_Wall` accepts
      // Explosion and FireBall affects).
      this.damageWallsInBlast(affect, fireball);

      // Chain into every barrel caught in the blast; each goes up on its own
      // next step, one original tick later. Mines and charge packs accept no
      // affect and sit through anything.
      for (const placeable of this.placeables) {
        if (!placeable.alive || placeable.detonating || placeable.type !== 'barrel') continue;
        if (distanceSq(placeable.x, placeable.y, affect.x, affect.y) > affect.radius * affect.radius) {
          continue;
        }
        if (affect.depth + 1 > MAX_AFFECT_DEPTH) continue;
        placeable.detonating = true;
        placeable.fuse = CHAIN_DELAY_TICKS;
      }

      if (affect.cluster && affect.depth < MAX_AFFECT_DEPTH) {
        this.spawnClusterShells(affect);
      }
      if (affect.extraBlasts > 0 && affect.depth < MAX_AFFECT_DEPTH) {
        this.spawnExtraBlasts(affect);
      }
    }
  }

  /** Apply a blast to the breakable cells whose centre lies within it. */
  private damageWallsInBlast(affect: PendingAffect, flat: boolean): void {
    const cell = this.map.cell;
    const minX = Math.max(0, Math.floor((affect.x - affect.radius) / cell));
    const maxX = Math.min(this.map.cols - 1, Math.floor((affect.x + affect.radius) / cell));
    const minY = Math.max(0, Math.floor((affect.y - affect.radius) / cell));
    const maxY = Math.min(this.map.rows - 1, Math.floor((affect.y + affect.radius) / cell));
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        if (this.map.tileAt(cx, cy) !== Tile.Breakable) continue;
        const centre = this.map.centreOf(cx, cy);
        const d = Math.hypot(centre.x - affect.x, centre.y - affect.y);
        if (d > affect.radius + cell / 2) continue;
        const falloff = flat ? 1 : explosionFalloff(Math.min(1, d / affect.radius));
        this.damageWallCell(cx, cy, affect.wallDamage * falloff);
      }
    }
  }

  /**
   * Cluster Explode: four shells lobbed out of the blast, one per quadrant,
   * each bursting with the parent's full damage when its fuse runs out.
   */
  private spawnClusterShells(affect: PendingAffect): void {
    for (let i = 0; i < CLUSTER_SHELL.count; i++) {
      const angle =
        (i / CLUSTER_SHELL.count) * TAU + this.rng.range(-CLUSTER_SHELL.jitter, CLUSTER_SHELL.jitter);
      const speed = this.rng.range(CLUSTER_SHELL.minSpeed, CLUSTER_SHELL.maxSpeed);
      const fuse = this.rng.int(CLUSTER_SHELL.minFuse, CLUSTER_SHELL.maxFuse);
      const id = this.allocId();
      if (id < 0) return;
      this.shots.push({
        id,
        alive: true,
        x: affect.x,
        y: affect.y,
        prevX: affect.x,
        prevY: affect.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        angle,
        radius: 3,
        z: 0,
        ownerId: affect.ownerId,
        weapon: 'grenade',
        kind: 'grenade',
        damage: 0,
        knockback: 0,
        life: fuse,
        travelled: 0,
        maxRange: UNLIMITED_RANGE,
        pierce: false,
        splashRadius: affect.radius,
        splashDamage: affect.damage,
        fuse,
        hits: new Set<number>(),
        cluster: false,
        extraBlasts: 0,
        wallDamage: affect.wallDamage,
        vz: CLUSTER_SHELL.launchVz,
        hitscan: false,
      });
    }
  }

  /**
   * Big Bang / Bigger Bang: two or three more full blasts a cell out from
   * the first, spread evenly with a little jitter, each a few ticks later.
   */
  private spawnExtraBlasts(affect: PendingAffect): void {
    const n = affect.extraBlasts;
    const step = TAU / n;
    for (let i = 0; i < n; i++) {
      const angle = i * step + this.rng.range(-step / 8, step / 8);
      this.explode(
        affect.x + Math.cos(angle) * EXTRA_BLAST.distance,
        affect.y + Math.sin(angle) * EXTRA_BLAST.distance,
        affect.radius,
        affect.damage,
        affect.ownerId,
        false,
        affect.depth + 1,
        {
          wallDamage: affect.wallDamage,
          delay: this.rng.int(EXTRA_BLAST.minDelay, EXTRA_BLAST.maxDelay),
        },
      );
    }
  }

  // ---- damage -------------------------------------------------------------

  /**
   * Hurt a creature. A bullet shoves it at least 0.3 cells, more for heavy
   * hits; a blast at most 0.3; and the creature is stunned for the slide
   * (`CThing_Creature.ProcessAffects` / `State_BulletHit`).
   */
  private damageEnemy(
    enemy: Enemy,
    amount: number,
    angle: number,
    blast: boolean,
    ownerId: number,
  ): void {
    if (enemy.state !== 'alive') return;
    const def = ENEMIES[enemy.defId];
    enemy.life -= amount;
    enemy.hitTicks = 8;
    enemy.hitFromRear = Math.cos(angle - enemy.angle) > 0;

    const cells = blast
      ? Math.min(HIT_STUN.baseCells, amount * HIT_STUN.perDamage)
      : Math.max(HIT_STUN.baseCells, amount * HIT_STUN.perDamage);
    this.shove(enemy, angle, (cells * ORIGINAL_CELL) / Math.max(0.4, enemy.mass));

    const blood = this.addEffect('blood', enemy.x, enemy.y, 10, EFFECT_TICKS.blood);
    if (blood) blood.angle = angle;
    this.spray(enemy.x, enemy.y, angle, def.bloodColor, 3, 4, 16, 2.5, 4.5);

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
    this.addDecal('blood', enemy.x, enemy.y, this.rng.range(7, 9), def.bloodColor);
    this.spray(enemy.x, enemy.y, angle, def.bloodColor, 4, 8, 22, 2.5, 5);
    this.addEffect('gib', enemy.x, enemy.y, 14, 30);
    this.playSound('Creature.HitFloor', enemy.x, enemy.y, this.rng.range(0.9, 1.1));
    this.registerKill(enemy, ownerId);
  }

  /** `attackerId` is the player entity behind the hit, or -1 for the horde and the room. */
  private damagePlayer(
    player: Player,
    amount: number,
    fromX: number,
    fromY: number,
    attackerId = -1,
  ): void {
    if (player.state !== 'alive' || player.invincible > 0) return;
    player.life -= amount;
    player.hitTicks = 10;
    const angle = Math.atan2(player.y - fromY, player.x - fromX);
    player.hitFromRear = Math.cos(angle - player.angle) > 0;
    this.shake += 2.5;
    this.hurt = Math.min(1, this.hurt + 0.35 + amount / 100);
    this.addDecal('blood', player.x, player.y, this.rng.range(5, 9), '#7a0d12');

    if (player.life > 0) return;
    player.life = 0;
    player.state = 'dying';
    player.stateTicks = 0;
    this.playSound(this.rng.bool() ? 'Creature.Player.Scream.1' : 'Creature.Player.Scream.2', player.x, player.y);
    this.pushMessage('You died', 'critical', 150);
    this.registerPlayerKill(player, attackerId);
    // Co-op ends when nobody is left standing; a deathmatch only ends on kills.
    if (
      MODES[this.mode].killTarget === null &&
      this.players.every((p) => p.state !== 'alive') &&
      !this.gameOver
    ) {
      this.gameOver = true;
      this.gameOverTick = this.tick;
    }
  }

  /**
   * A player has fallen. The original (`CWorld.LogKill`) keeps one *death*
   * counter per player and `CWorld.PlayerDead` ends a deathmatch when a
   * player's deaths reach the target, so the other player wins. Crediting the
   * kill to the killer, or to every other seated player when there is no
   * killer or the victim did it to themselves, reproduces that exactly with
   * two players and stays well defined with more. Outside a kill-target mode
   * only a real killer is credited.
   */
  registerPlayerKill(victim: Player, killerId: number): void {
    const mode = MODES[this.mode];
    const killer = killerId >= 0 ? this.playerById(killerId) : undefined;
    const credited =
      killer && killer !== victim
        ? [killer]
        : mode.killTarget !== null
          ? this.players.filter((p) => p !== victim && p.connected)
          : [];
    for (const player of credited) {
      player.kills += 1;
      if (!mode.sharedScore) player.score += 1;
    }
    // The original drops a crate where a deathmatch victim fell.
    if (mode.dropCrateOnPlayerDeath && !this.map.blockedAtPoint(victim.x, victim.y)) {
      this.addPickup(victim.x, victim.y);
    }
    const target = mode.killTarget;
    if (target === null || this.gameOver) return;
    const winner = credited.find((p) => p.kills >= target);
    if (winner) this.endMatch(winner.index);
  }

  /** Close a versus match: `winnerIndex` is the seat that won, or -1 for a draw. */
  private endMatch(winnerIndex: number): void {
    this.gameOver = true;
    this.gameOverTick = this.tick;
    this.winnerIndex = winnerIndex;
    this.pushMessage(winnerIndex >= 0 ? `PLAYER ${winnerIndex + 1} WINS` : 'DRAW', 'level', 200);
  }

  /** Seat with the most kills, or -1 when the lead is shared. */
  private leader(): number {
    let best = -1;
    let bestKills = -1;
    let tied = false;
    for (const player of this.players) {
      if (player.kills > bestKills) {
        bestKills = player.kills;
        best = player.index;
        tied = false;
      } else if (player.kills === bestKills) {
        tied = true;
      }
    }
    return tied ? -1 : best;
  }

  private registerKill(enemy: Enemy, ownerId: number): void {
    const def = ENEMIES[enemy.defId];
    this.kills += 1;

    // Every kill lifts the multiplier one step and restarts its drain. Score
    // is the creature's worth times the multiplier at the moment it fell.
    this.raiseMultiplier(this.multiplier + 1, false);
    const gained = Math.round(def.score * this.multiplier);
    this.score += gained;

    // The quick-kill streak runs on a much shorter window; every fifth kill
    // of a streak shakes a crate loose. Devils always drop one.
    this.streak += 1;
    this.streakTicks = streakWindow(this.streak, this.speedFactor) + SCORING.countdownLagTicks;
    const drops = enemy.defId === 'devil' || this.streak % SCORING.pickupEveryStreakKills === 0;

    const owner = ownerId >= 0 ? this.playerById(ownerId) : undefined;
    if (owner) owner.kills += 1;

    this.pushPopup(enemy.x, enemy.y - 20, `+${gained}`, 'score');
    if (drops && !this.map.blockedAtPoint(enemy.x, enemy.y)) this.addPickup(enemy.x, enemy.y);
  }

  /**
   * Move the multiplier to a value and restart its window. Climbing past a
   * threshold hands out that award, once, for the rest of the run; a harder
   * difficulty banks a whole stack of them silently at the start.
   */
  private raiseMultiplier(value: number, silent: boolean): void {
    this.multiplier = Math.max(1, Math.min(SCORING.maxMultiplier, value));
    this.multiplierTicks = this.multiplierTicksFor(this.multiplier);
    if (this.multiplier <= this.peakMultiplier) return;
    for (const award of awardsBetween(this.peakMultiplier, this.multiplier)) {
      for (const player of this.players) this.grantAward(player, award);
      // One banner per award, not one per seat.
      if (!silent) this.pushMessage(award.message, 'upgrade', 150);
    }
    this.peakMultiplier = this.multiplier;
  }

  // ---- pickups, effects, scoring ------------------------------------------

  private phasePickups(): void {
    for (const pickup of this.pickups) {
      if (!pickup.alive) continue;
      if (pickup.hiddenUntil > 0) {
        if (this.tick >= pickup.hiddenUntil) pickup.hiddenUntil = 0;
        continue;
      }
      if (pickup.life > 0) {
        pickup.life -= 1;
        if (pickup.life === 0) {
          pickup.alive = false;
          continue;
        }
      }
      for (const player of this.players) {
        if (player.state !== 'alive') continue;
        const reach = pickup.radius + player.radius;
        if (distanceSq(pickup.x, pickup.y, player.x, player.y) > reach * reach) continue;

        this.openCrate(player);
        this.playSound('Object.Pickup', pickup.x, pickup.y, 1, player.id);
        if (pickup.permanent) {
          // A room's own crate comes back: ten seconds in co-op, thirty in deathmatch.
          pickup.hiddenUntil = this.tick + this.realTicks(MODES[this.mode].crateRespawnTicks);
        } else {
          pickup.alive = false;
        }
        break;
      }
    }
  }

  /**
   * The original's `RandomPickup`: a crate refills one weapon the player
   * holds to full, chosen with a bias toward the emptiest; the pistol is
   * never in the draw. A hurt player may draw "Life up!" instead, with a
   * chance that grows with the damage taken.
   */
  private openCrate(player: Player): void {
    const candidates: Array<{ weapon: WeaponId | null; chance: number }> = [];
    let total = 0;
    for (const weaponId of WEAPON_ORDER) {
      const slot = player.weapons.get(weaponId);
      if (!slot?.unlocked || weaponId === 'pistol') continue;
      const def = WEAPONS[weaponId];
      const stats = statsFor(player.stats, weaponId);
      const infinite = def.infiniteAmmo || stats.infiniteAmmo;
      const capacity = def.totalAmmo * stats.ammoMul;
      const fill = infinite || capacity <= 0 ? 1 : Math.min(1, slot.ammo / capacity);
      const chance = (1 - fill) * 0.75 + 0.25;
      candidates.push({ weapon: weaponId, chance });
      total += chance;
    }
    if (player.life < player.maxLife) {
      const chance = (1 - player.life / player.maxLife) * total;
      candidates.push({ weapon: null, chance });
      total += chance;
    }
    if (candidates.length === 0 || total <= 0) return;

    let roll = this.rng.next() * total;
    let chosen = candidates[candidates.length - 1]!.weapon;
    for (const candidate of candidates) {
      roll -= candidate.chance;
      if (roll <= 0) {
        chosen = candidate.weapon;
        break;
      }
    }
    if (chosen === null) {
      player.life = player.maxLife;
      this.pushMessage('Life up!', 'info', 70);
      return;
    }
    const def = WEAPONS[chosen];
    const slot = player.weapons.get(chosen)!;
    slot.ammo = Math.max(slot.ammo, Math.round(def.totalAmmo * statsFor(player.stats, chosen).ammoMul));
    this.pushMessage(`Picked up ${def.name}`, 'info', 70);
  }

  private phaseEffects(): void {
    for (const effect of this.effects) {
      if (!effect.alive) continue;
      effect.life -= 1;
      if (effect.life <= 0) {
        effect.alive = false;
        continue;
      }
      if (effect.vx !== 0 || effect.vy !== 0) {
        effect.prevX = effect.x;
        effect.prevY = effect.y;
        if (effect.type === 'rocketsmoke') {
          effect.vx *= ROCKET_SMOKE.growth;
          effect.vy *= ROCKET_SMOKE.growth;
        }
        effect.x += effect.vx;
        effect.y += effect.vy;
      }
    }
    for (const message of this.messages) message.life -= 1;
    for (const popup of this.popups) {
      popup.life -= 1;
      popup.y -= 0.4;
    }
    this.shake *= 0.86;
    if (this.shake < 0.2) this.shake = 0;
    this.flash = Math.max(0, this.flash - 0.06);
    this.hurt = Math.max(0, this.hurt - 0.035);
  }

  private phaseScore(): void {
    // A finished run neither drains nor advances.
    if (this.gameOver) return;
    const mode = MODES[this.mode];
    if (!mode.sharedScore) {
      // The original's `CUpgrades.Process` returns at once in deathmatch: the
      // multiplier never drains and no wave is ever scheduled. Only a time
      // limit, where a mode has one, can end the match from here.
      if (mode.timeLimitTicks !== null && this.tick >= mode.timeLimitTicks && !this.gameOver) {
        this.endMatch(this.leader());
      }
      return;
    }

    // The streak counter simply expires; the multiplier steps down one at a
    // time, each step on its own, shorter window.
    if (this.streakTicks > 0) {
      this.streakTicks -= 1;
      if (this.streakTicks === 0) this.streak = 0;
    }
    if (this.multiplier > 1) {
      this.multiplierTicks -= 1;
      if (this.multiplierTicks <= 0) {
        this.multiplier -= 1;
        this.multiplierTicks = this.multiplierTicksFor(this.multiplier);
      }
    }

    // A level clears once its wave has been fully released and dealt with,
    // corpses included until they fade (the original counts things, not the
    // living).
    const waveReleased =
      this.spawnedThisLevel >= this.zombieTotal() &&
      this.devilsSpawned >= this.devilTotal();
    if (!waveReleased) return;

    const remaining = this.enemies.length;
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

  /** Devils this level, or none with the option off. */
  private devilTotal(): number {
    return this.devilsActive ? this.levelInfo.devilTotal : 0;
  }

  /** Zombies this level, scaled by the mode. */
  private zombieTotal(): number {
    return Math.round(this.levelInfo.zombieTotal * (MODES[this.mode].zombieMul ?? 1));
  }

  private advanceLevel(): void {
    this.level += 1;
    this.levelInfo = levelDef(this.level);
    this.spawnedThisLevel = 0;
    this.devilsSpawned = 0;
    this.waveGrace = 0;
    // The next wave's first zombie is one spawn interval away, as in the original.
    this.zombieSpawnTimer = this.zombieSpawnPeriod();
    this.devilSpawnTimer = this.levelInfo.devilSpawnRate;
    this.pushMessage(levelBanner(this.level), 'level', 160);
    const anchor = this.players.find((p) => p.state === 'alive') ?? this.players[0];
    this.playSound('CLICK', anchor?.x ?? 0, anchor?.y ?? 0);
  }

  private grantAward(player: Player, award: Award): void {
    if (award.kind === 'weapon') {
      const slot = player.weapons.get(award.weapon)!;
      slot.unlocked = true;
      const stats = statsFor(player.stats, award.weapon);
      slot.ammo = Math.max(slot.ammo, Math.round(WEAPONS[award.weapon].totalAmmo * stats.ammoMul));
    } else {
      player.held.push({ weapon: award.weapon, upgrade: award.upgrade });
      // Recompute from the full set so awards stay order-independent.
      player.stats = computeStats(player.held);
      // The original reapplies every upgrade of the weapon on each new one,
      // and an ammo tier sets the ammo to capacity when applied: so any
      // upgrade to a weapon that holds an ammo tier refills it on the spot.
      if (holdsAmmoTier(player.held, award.weapon)) {
        const slot = player.weapons.get(award.weapon)!;
        const stats = statsFor(player.stats, award.weapon);
        slot.ammo = Math.max(slot.ammo, Math.round(WEAPONS[award.weapon].totalAmmo * stats.ammoMul));
      }
    }
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

    // A corpse is a thing until it has faded, and a level cannot end before then.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      if (enemy.state !== 'dead' || enemy.stateTicks < DEATH.corpseTicks) continue;
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
    mix(this.multiplier);
    mix(this.enemies.length);
    mix(this.winnerIndex);
    for (const player of this.players) {
      mix(player.x);
      mix(player.y);
      mix(player.life);
      mix(player.kills);
      mix(player.score);
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
   * Popups, banners, decals and queued sounds are left out: they regenerate
   * from play and a joining client does not need the history. Effects are
   * included even though they are cosmetic, because they hold entity ids (see
   * `EffectSnapshot`).
   */
  snapshot(options: SnapshotOptions = {}): WorldSnapshot {
    const includeMap = options.includeMap ?? true;
    return {
      version: 2,
      tick: this.tick,
      mode: this.mode,
      level: this.level,
      score: this.score,
      kills: this.kills,
      multiplier: this.multiplier,
      gameOver: this.gameOver,
      gameOverTick: this.gameOverTick,
      winnerIndex: this.winnerIndex,
      rng: this.rng.getState(),
      progress: {
        spawnedThisLevel: this.spawnedThisLevel,
        devilsSpawned: this.devilsSpawned,
        zombieSpawnTimer: this.zombieSpawnTimer,
        devilSpawnTimer: this.devilSpawnTimer,
        multiplierTicks: this.multiplierTicks,
        peakMultiplier: this.peakMultiplier,
        streak: this.streak,
        streakTicks: this.streakTicks,
        waveGrace: this.waveGrace,
        navCursor: this.navCursor,
      },
      ids: { next: this.nextId, free: [...this.freeIds] },
      map: {
        revision: this.map.revision,
        integrityRevision: this.map.integrityRevision,
        ...(includeMap
          ? { tiles: Array.from(this.map.tiles), integrity: Array.from(this.map.integrity) }
          : {}),
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
        pushX: p.pushX,
        pushY: p.pushY,
        stun: p.stun,
        current: p.current,
        fireCooldown: p.fireCooldown,
        invincible: p.invincible,
        respawnTimer: p.respawnTimer,
        kills: p.kills,
        score: p.score,
        firingHeld: p.firingHeld,
        fireHeldTicks: p.fireHeldTicks,
        detonateMode: p.detonateMode,
        connected: p.connected,
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
        pushX: e.pushX,
        pushY: e.pushY,
        stun: e.stun,
        targetId: e.targetId,
        hasLos: e.hasLos,
        losTimer: e.losTimer,
        stuckTicks: e.stuckTicks,
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
        extraBlasts: s.extraBlasts,
        wallDamage: s.wallDamage,
        hits: [...s.hits],
        z: s.z,
        vz: s.vz,
        hitscan: s.hitscan,
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
        extraBlasts: p.extraBlasts,
        detonating: p.detonating,
      })),
      pickups: this.pickups.map((p) => ({
        id: p.id,
        type: p.type,
        weapon: p.weapon,
        x: p.x,
        y: p.y,
        amount: p.amount,
        life: p.life,
        permanent: p.permanent,
        hiddenUntil: p.hiddenUntil,
      })),
      effects: this.effects.map((e) => ({
        id: e.id,
        type: e.type,
        x: e.x,
        y: e.y,
        angle: e.angle,
        life: e.life,
        maxLife: e.maxLife,
        size: e.size,
        seed: e.seed,
        variant: e.variant,
        vx: e.vx,
        vy: e.vy,
      })),
      affects: this.pendingAffects.map((a) => ({ ...a })),
      navs: this.navs.map((nav) => nav.getTarget()),
    };
  }

  /** Replace this world's state with a snapshot. */
  restore(snapshot: WorldSnapshot): void {
    this.tick = snapshot.tick;
    this.mode = snapshot.mode;
    this.level = snapshot.level;
    this.score = snapshot.score;
    this.kills = snapshot.kills;
    this.multiplier = snapshot.multiplier;
    this.gameOver = snapshot.gameOver;
    this.gameOverTick = snapshot.gameOverTick;
    this.winnerIndex = snapshot.winnerIndex;
    this.rng.setState(snapshot.rng);
    this.levelInfo = levelDef(snapshot.level);

    const progress = snapshot.progress;
    this.spawnedThisLevel = progress.spawnedThisLevel;
    this.devilsSpawned = progress.devilsSpawned;
    this.zombieSpawnTimer = progress.zombieSpawnTimer;
    this.devilSpawnTimer = progress.devilSpawnTimer;
    this.multiplierTicks = progress.multiplierTicks;
    this.peakMultiplier = progress.peakMultiplier;
    this.streak = progress.streak;
    this.streakTicks = progress.streakTicks;
    this.waveGrace = progress.waveGrace;
    this.navCursor = progress.navCursor;

    this.nextId = snapshot.ids.next;
    this.freeIds.length = 0;
    this.freeIds.push(...snapshot.ids.free);

    if (snapshot.map.tiles && snapshot.map.integrity) {
      if (snapshot.map.tiles.length !== this.map.tiles.length) {
        throw new SnapshotError(
          `map has ${snapshot.map.tiles.length} cells, this world has ${this.map.tiles.length}`,
        );
      }
      this.map.tiles.set(snapshot.map.tiles);
      this.map.integrity.set(snapshot.map.integrity);
    } else if (
      snapshot.map.revision !== this.map.revision ||
      snapshot.map.integrityRevision !== this.map.integrityRevision
    ) {
      throw new SnapshotError('snapshot omits tiles but the map revision differs');
    }
    this.map.revision = snapshot.map.revision;
    this.map.integrityRevision = snapshot.map.integrityRevision;

    // Rebuild every pool, then re-index the broad phase from scratch.
    this.hash.clear();
    this.byId.fill(undefined);
    this.players.length = 0;
    this.enemies.length = 0;
    this.shots.length = 0;
    this.placeables.length = 0;
    this.pickups.length = 0;
    this.effects.length = 0;
    this.pendingAffects = snapshot.affects.map((a) => ({ ...a }));

    for (const p of snapshot.players) {
      const weapons = new Map<WeaponId, WeaponSlot>(p.weapons.map(([id, slot]) => [id, { ...slot }]));
      const player: Player = {
        ...p,
        kind: 'player',
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
      this.byId[player.id] = player;
      this.hash.insert(player.id, player.x, player.y);
    }

    for (const e of snapshot.enemies) {
      const def = ENEMIES[e.defId];
      const enemy: Enemy = {
        ...e,
        kind: 'enemy',
        prevX: e.x,
        prevY: e.y,
        vx: 0,
        vy: 0,
        alive: true,
        radius: def.radius,
        z: 0,
        mass: def.mass,
        height: def.height,
      };
      this.enemies.push(enemy);
      this.byId[enemy.id] = enemy;
      this.hash.insert(enemy.id, enemy.x, enemy.y);
    }

    for (const s of snapshot.shots) {
      this.shots.push({
        ...s,
        prevX: s.x,
        prevY: s.y,
        alive: true,
        radius: s.kind === 'fireball' ? (s.wallDamage > s.damage ? FIREBALL.objectSplashRadius / 2 : FIREBALL.radius) : 3,
        hits: new Set(s.hits),
      });
    }

    for (const p of snapshot.placeables) {
      const placeable: Placeable = {
        ...p,
        kind: 'placeable',
        prevX: p.x,
        prevY: p.y,
        vx: 0,
        vy: 0,
        angle: 0,
        alive: true,
        radius: p.type === 'barrel' ? 13 : 10,
        z: 0,
      };
      this.placeables.push(placeable);
      this.byId[placeable.id] = placeable;
      this.hash.insert(placeable.id, placeable.x, placeable.y);
    }

    for (const p of snapshot.pickups) {
      const pickup: Pickup = {
        ...p,
        kind: 'pickup',
        prevX: p.x,
        prevY: p.y,
        vx: 0,
        vy: 0,
        angle: 0,
        alive: true,
        radius: 12,
        z: 0,
      };
      this.pickups.push(pickup);
      this.byId[pickup.id] = pickup;
      this.hash.insert(pickup.id, pickup.x, pickup.y);
    }

    for (const e of snapshot.effects) {
      this.effects.push({
        ...e,
        alive: true,
        prevX: e.x,
        prevY: e.y,
        radius: e.size,
        z: 0,
      });
    }

    // Barrel occupancy is derived from the placeables, so rebuild it without
    // disturbing the restored revision.
    this.map.occupied.fill(0);
    for (const placeable of this.placeables) {
      if (placeable.type !== 'barrel' || !placeable.alive) continue;
      const cell = this.map.cellOf(placeable.x, placeable.y);
      if (this.map.inBounds(cell.cx, cell.cy)) this.map.occupied[this.map.index(cell.cx, cell.cy)] = 1;
    }
    this.map.revision = snapshot.map.revision;

    // Flow fields are derived state, but a field built on a different tick
    // steers the horde differently for a while; rebuild them as they were.
    this.navs.forEach((nav, i) => {
      const saved = snapshot.navs[i];
      nav.setTarget(saved?.targetCell ?? -1, saved?.revision ?? -1);
    });
  }
}
