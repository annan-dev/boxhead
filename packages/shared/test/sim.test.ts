/**
 * Simulation tests.
 *
 * The determinism test is the important one: it is what makes an authoritative
 * server possible later, so it should fail loudly the moment anything reads the
 * clock or reaches for Math.random.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, emptyCommand, type InputCommand } from '../src/sim/World.js';
import { ROOMS } from '../src/data/rooms.js';
import { Rng } from '../src/math/Rng.js';
import { computeStats } from '../src/data/upgrades.js';
import { WEAPONS } from '../src/data/weapons.js';
import { multiplierWindow } from '../src/data/levels.js';

const room = ROOMS[0]!;

/** A scripted input stream, so runs are comparable without a human. */
function scriptedCommands(tick: number, rng: Rng): InputCommand[] {
  const command = emptyCommand();
  const phase = tick * 0.02;
  command.moveX = Math.cos(phase);
  command.moveY = Math.sin(phase * 0.7);
  command.aimX = 400 + Math.cos(phase * 1.3) * 200;
  command.aimY = 260 + Math.sin(phase * 1.1) * 160;
  command.fire = tick % 7 !== 0;
  if (tick % 300 === 0) command.weaponSlot = rng.int(1, 3);
  return [command];
}

function run(ticks: number, seed: number): World {
  const world = new World({ room, seed, playerCount: 1 });
  const rng = new Rng(seed ^ 0xabcdef);
  for (let tick = 0; tick < ticks; tick++) {
    world.step(scriptedCommands(tick, rng));
  }
  return world;
}

test('same seed and inputs produce an identical world', () => {
  const a = run(3000, 12345);
  const b = run(3000, 12345);
  assert.equal(a.stateHash(), b.stateHash(), 'state hash diverged between identical runs');
  assert.equal(a.score, b.score);
  assert.equal(a.kills, b.kills);
  assert.equal(a.enemies.length, b.enemies.length);
});

test('different seeds diverge', () => {
  const a = run(1500, 1);
  const b = run(1500, 2);
  assert.notEqual(a.stateHash(), b.stateHash(), 'different seeds produced identical worlds');
});

test('a long run stays finite and bounded', () => {
  const world = run(12000, 777);

  for (const entity of [...world.players, ...world.enemies, ...world.shots]) {
    assert.ok(Number.isFinite(entity.x), 'entity x went non-finite');
    assert.ok(Number.isFinite(entity.y), 'entity y went non-finite');
    assert.ok(entity.x >= 0 && entity.x <= world.map.width, 'entity escaped the map on x');
    assert.ok(entity.y >= 0 && entity.y <= world.map.height, 'entity escaped the map on y');
  }

  // Pools must not grow without bound over a long session.
  assert.ok(world.shots.length < 400, `shot pool leaked: ${world.shots.length}`);
  assert.ok(world.effects.length < 600, `effect pool leaked: ${world.effects.length}`);
  assert.ok(world.messages.length <= 6, 'message queue leaked');
  assert.ok(world.decals.length <= 900, 'decal queue leaked');
});

test('the game actually progresses', () => {
  // A player who aims at the nearest zombie and taps fire clears level 1.
  const world = new World({ room, seed: 4242, playerCount: 1 });
  const player = world.players[0]!;
  for (let tick = 0; tick < 9000 && world.level === 1; tick++) {
    let best: { x: number; y: number } | null = null;
    let bestDistance = Infinity;
    for (const enemy of world.enemies) {
      if (enemy.state !== 'alive') continue;
      const d = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = enemy;
      }
    }
    const command = emptyCommand();
    command.aimX = best ? best.x : player.x + 100;
    command.aimY = best ? best.y : player.y;
    command.fire = best !== null && tick % 2 === 0;
    world.step([command]);
  }
  assert.ok(world.kills > 0, 'nothing died in 3 minutes of play');
  assert.ok(world.score > 0, 'no score was earned');
  assert.ok(world.level > 1, `never advanced past level 1 (kills: ${world.kills})`);
});

test('the multiplier awards the UZI at x5 and drains back to x1', () => {
  const { world, player } = quietWorld();
  arm(player, 'railgun');
  // Five zombies in a line: one rail shot, five kills, multiplier x6.
  const targets = [40, 60, 80, 100, 120].map((d) => spawnEnemy(world, player.x + d, player.y));
  world.step([command(player.x + 200, player.y, false)]);
  world.step([command(player.x + 200, player.y, true)]);
  assert.equal(targets.filter((e) => e.state !== 'alive').length, 5, 'rail shot missed');
  assert.equal(world.multiplier, 6);
  assert.ok(player.weapons.get('uzi')!.unlocked, 'UZI not awarded at x5');
  assert.ok(player.held.some((h) => h.upgrade === 'FastFire'), 'Fast Fire not awarded at x3');
  assert.ok(!player.weapons.get('shotgun')!.unlocked, 'shotgun awarded before x10');

  // Left alone, the multiplier steps down to one: five windows of under
  // three seconds each.
  for (let i = 0; i < 1000; i++) world.step([command(player.x + 200, player.y, false)]);
  assert.equal(world.multiplier, 1);
  assert.ok(player.weapons.get('uzi')!.unlocked, 'awards must be kept after the drain');
});

test('a harder difficulty banks the multiplier and its awards', () => {
  const world = new World({ room, seed: 5, playerCount: 1, startLevel: 10, startMultiplier: 10 });
  const player = world.players[0]!;
  assert.equal(world.level, 10);
  assert.equal(world.multiplier, 10);
  assert.ok(player.weapons.get('uzi')!.unlocked);
  assert.ok(player.weapons.get('shotgun')!.unlocked, 'shotgun (x10) not banked');
  assert.ok(!player.weapons.get('barrel')!.unlocked, 'barrel (x15) banked too early');
});

test('with devils off, no devil ever spawns and levels still clear', () => {
  const world = new World({ room, seed: 8, playerCount: 1, startLevel: 6, devils: false });
  const player = world.players[0]!;
  player.maxLife = 1e9;
  player.life = 1e9;
  arm(player, 'railgun');
  player.weapons.get('railgun')!.ammo = 1e9;
  const startLevel = world.level;
  for (let tick = 0; tick < 6000 && world.level === startLevel; tick++) {
    let best: { x: number; y: number } | null = null;
    let bestDistance = Infinity;
    for (const enemy of world.enemies) {
      if (enemy.state !== 'alive') continue;
      const d = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = enemy;
      }
    }
    world.step([command(best ? best.x : player.x + 100, best ? best.y : player.y, best !== null && tick % 2 === 0)]);
    assert.ok(!world.enemies.some((e) => e.defId === 'devil'), 'a devil spawned with devils off');
  }
  assert.ok(world.level > startLevel, 'the level never cleared without devils');
});

test('every fifth streak kill drops a crate that refills a weapon', () => {
  const { world, player } = quietWorld();
  arm(player, 'railgun');
  player.weapons.get('railgun')!.ammo = 1;
  const crates = world.pickups.length;
  for (const d of [40, 60, 80, 100, 120]) spawnEnemy(world, player.x + d, player.y);
  world.step([command(player.x + 200, player.y, false)]);
  world.step([command(player.x + 200, player.y, true)]);
  assert.ok(world.pickups.length > crates, 'no crate dropped on the fifth kill');
});

test('enemies close on the player', () => {
  const world = new World({ room, seed: 99, playerCount: 1 });
  const player = world.players[0]!;
  // Let a wave spawn, then watch whether the nearest zombie gets closer.
  const idle = [emptyCommand()];
  for (let i = 0; i < 400; i++) world.step(idle);
  assert.ok(world.enemies.length > 0, 'no enemies spawned');

  const before = Math.min(
    ...world.enemies.map((e) => Math.hypot(e.x - player.x, e.y - player.y)),
  );
  for (let i = 0; i < 300; i++) world.step(idle);
  const after = Math.min(
    ...world.enemies.map((e) => Math.hypot(e.x - player.x, e.y - player.y)),
  );
  assert.ok(after < before, `enemies did not approach (${before.toFixed(1)} -> ${after.toFixed(1)})`);
});

test('upgrades are order independent and tiers do not stack', async () => {
  const { computeStats } = await import('../src/data/upgrades.js');
  const held = [
    { weapon: 'uzi' as const, upgrade: 'DoubleDamage' as const },
    { weapon: 'uzi' as const, upgrade: 'RapidFire' as const },
    { weapon: 'uzi' as const, upgrade: 'QuadAmmo' as const },
    { weapon: 'uzi' as const, upgrade: 'QuadDamage' as const },
  ];
  const forward = computeStats(held);
  const reversed = computeStats([...held].reverse());
  assert.deepEqual(
    forward.perWeapon.get('uzi'),
    reversed.perWeapon.get('uzi'),
    'upgrade order changed the result',
  );
  // Original: the best damage tier applies, never the product of them.
  assert.equal(forward.perWeapon.get('uzi')!.damageMul, 4);
  assert.equal(forward.perWeapon.get('uzi')!.ammoMul, 4);
  assert.equal(forward.perWeapon.get('uzi')!.auto, true);
});

// ---- regression tests for the bugs that made the game unplayable ----------

type EnemyOf<T> = T extends { enemies: Array<infer E> } ? E : never;
type Enemy = EnemyOf<World>;
type PlayerOf<T> = T extends { players: Array<infer P> } ? P : never;
type Player = PlayerOf<World>;

/** Reach into the world to place enemies exactly where a test needs them. */
function spawnEnemy(world: World, x: number, y: number): Enemy {
  const enemy = (world as unknown as { addEnemy(id: string, x: number, y: number): Enemy | null })
    .addEnemy('zombie', x, y);
  assert.ok(enemy, 'enemy pool exhausted');
  return enemy;
}

function arm(player: Player, weapon: 'fakewall' | 'grenade' | 'railgun' | 'barrel'): void {
  const slot = player.weapons.get(weapon)!;
  slot.unlocked = true;
  slot.ammo = 10;
  player.current = weapon;
  player.fireCooldown = 0;
}

function command(aimX: number, aimY: number, fire: boolean, moveX = 0, moveY = 0): InputCommand {
  return { ...emptyCommand(), aimX, aimY, fire, moveX, moveY };
}

/** A quiet world: the player parked in the open before any zombie arrives. */
function quietWorld(): { world: World; player: Player } {
  const world = new World({ room, seed: 5, playerCount: 1 });
  const player = world.players[0]!;
  player.invincible = 0;
  return { world, player };
}

test('a fake wall is refused when it would trap the player, and costs no ammo', () => {
  const { world, player } = quietWorld();
  arm(player, 'fakewall');
  // Stand just inside one cell so the wall cell ahead overlaps the body.
  player.x = 9 * world.map.cell - 2;
  player.y = 6 * world.map.cell + 16;
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  assert.equal(world.breakableCells().length, 0, 'wall was built on top of the player');
  assert.equal(player.weapons.get('fakewall')!.ammo, 10, 'ammo was spent on a refused wall');

  const before = player.x;
  for (let i = 0; i < 20; i++) world.step([command(player.x + 100, player.y, false, 1, 0)]);
  assert.ok(player.x > before + 10, 'player could not move after placing a wall');
});

test('a fake wall placed clear of the player is built and does not trap them', () => {
  const { world, player } = quietWorld();
  arm(player, 'fakewall');
  player.x = 8 * world.map.cell + 16;
  player.y = 6 * world.map.cell + 16;
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  assert.equal(world.breakableCells().length, 1, 'wall was not built');
  assert.equal(player.weapons.get('fakewall')!.ammo, 9);

  const before = player.x;
  for (let i = 0; i < 20; i++) world.step([command(player.x + 100, player.y, false, -1, 0)]);
  assert.ok(player.x < before - 10, 'player could not walk away from their own wall');
});

test('a grenade thrown into open space explodes on its fuse', () => {
  const { world, player } = quietWorld();
  arm(player, 'grenade');
  // A grenade charges while held and flies on release.
  world.step([command(player.x + 100, player.y, false)]);
  for (let i = 0; i < 10; i++) world.step([command(player.x + 100, player.y, true)]);
  world.step([command(player.x + 100, player.y, false)]);
  assert.equal(world.shots.length, 1, 'grenade was not thrown');

  let exploded = false;
  for (let i = 0; i < 200 && !exploded; i++) {
    world.step([command(player.x + 100, player.y, false)]);
    exploded = world.effects.some((e) => e.type === 'explosion');
  }
  assert.ok(exploded, 'grenade vanished without exploding');
});

test('a railgun shot runs through every zombie in its path', () => {
  const { world, player } = quietWorld();
  arm(player, 'railgun');
  const targets = [50, 80, 110].map((d) => spawnEnemy(world, player.x + d, player.y));
  world.step([command(player.x + 200, player.y, false)]);
  world.step([command(player.x + 200, player.y, true)]);
  for (let i = 0; i < 4; i++) world.step([command(player.x + 200, player.y, false)]);
  const dead = targets.filter((e) => e.state !== 'alive').length;
  assert.equal(dead, 3, `railgun pierced ${dead} of 3 zombies`);
});

test('bodies collide: a zombie cannot stand inside the player', () => {
  const { world, player } = quietWorld();
  const zombie = spawnEnemy(world, player.x + 4, player.y);
  for (let i = 0; i < 15; i++) world.step([command(player.x, player.y - 100, false)]);
  const gap = Math.hypot(zombie.x - player.x, zombie.y - player.y);
  assert.ok(gap >= player.radius + zombie.radius - 1, `bodies overlap: ${gap.toFixed(1)}px apart`);
});

test('a barrel blocks the player', () => {
  const { world, player } = quietWorld();
  arm(player, 'barrel');
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  const barrel = world.placeables.find((p) => p.ownerId === player.id);
  assert.ok(barrel, 'barrel was not placed');
  for (let i = 0; i < 40; i++) world.step([command(player.x + 100, player.y, false, 1, 0)]);
  assert.ok(
    player.x + player.radius <= barrel.x + 1,
    `player walked through the barrel (${player.x.toFixed(1)} vs ${barrel.x.toFixed(1)})`,
  );
});

test('shooting a barrel blows it up', () => {
  const { world, player } = quietWorld();
  arm(player, 'barrel');
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  const barrel = world.placeables.find((p) => p.ownerId === player.id);
  assert.ok(barrel, 'barrel was not placed');
  player.current = 'pistol';
  player.fireCooldown = 0;
  let exploded = false;
  // The pistol is semi-automatic: tap, do not hold.
  for (let i = 0; i < 60 && !exploded; i++) {
    world.step([command(barrel.x, barrel.y, i % 2 === 0)]);
    exploded = world.effects.some((e) => e.type === 'explosion');
  }
  assert.ok(exploded, 'pistol fire passed through the barrel');
  assert.equal(barrel.alive, false);
});

test('the run ends on a tick the client can wait out', () => {
  const { world, player } = quietWorld();
  player.life = 1;
  for (let i = 0; i < 3; i++) spawnEnemy(world, player.x + 25, player.y);
  for (let i = 0; i < 200 && !world.gameOver; i++) world.step([emptyCommand()]);
  assert.ok(world.gameOver, 'player survived three zombies at 1 hp');
  assert.ok(world.gameOverTick > 0 && world.gameOverTick <= world.tick);
  assert.equal(player.state === 'dying' || player.state === 'dead', true);
});

test('decals carry increasing sequence numbers past the cap', () => {
  const world = run(6000, 31337);
  const seqs = world.decals.map((d) => d.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, 'decal seq not increasing');
  assert.ok(world.decals.length <= 900);
});

test('a snapshot round-trips into an identical world', () => {
  const source = run(2200, 8675309);
  const snapshot = JSON.parse(JSON.stringify(source.snapshot())) as ReturnType<World['snapshot']>;

  const restored = new World({ room, seed: 1 });
  restored.restore(snapshot);

  assert.equal(restored.stateHash(), source.stateHash(), 'restored world differs from the original');
  assert.equal(restored.tick, source.tick);
  assert.equal(restored.score, source.score);
  assert.equal(restored.enemies.length, source.enemies.length);

  // And it must keep simulating in lockstep, which is what a server relies on.
  const rng = new Rng(8675309 ^ 0xabcdef);
  // Advance the scripted stream to where the snapshot was taken.
  for (let tick = 0; tick < 2200; tick++) scriptedCommands(tick, rng);
  for (let tick = 2200; tick < 2500; tick++) {
    const commands = scriptedCommands(tick, rng);
    source.step(commands);
    restored.step(commands);
  }
  assert.equal(restored.stateHash(), source.stateHash(), 'worlds diverged after resuming');
});

test('a snapshot taken at any point resumes in lockstep, ids included', () => {
  // Snapshots land mid explosion chain, with effects alive and fields built;
  // every one of those used to be a way for a restored world to drift.
  const seed = 4242;
  const source = new World({ room, seed, playerCount: 2 });
  const rng = new Rng(seed ^ 0xabcdef);
  const commandsAt = (tick: number): InputCommand[] => {
    const [first] = scriptedCommands(tick, rng);
    const second = { ...first!, moveX: -first!.moveX, fire: tick % 5 !== 0 };
    return [first!, second];
  };
  let checked = 0;
  for (let tick = 0; tick < 2400; tick++) {
    source.step(commandsAt(tick));
    if (tick % 97 !== 0) continue;

    const snapshot = JSON.parse(JSON.stringify(source.snapshot())) as ReturnType<World['snapshot']>;
    const mirror = new World({ room, seed: 1, playerCount: 2 });
    mirror.restore(snapshot);
    // Step both from the same commands; the mirror replays only the future.
    const saved = rng.getState();
    const future: InputCommand[][] = [];
    for (let ahead = 1; ahead <= 40; ahead++) future.push(commandsAt(tick + ahead));
    rng.setState(saved);
    const sourceCopy = new World({ room, seed: 1, playerCount: 2 });
    sourceCopy.restore(JSON.parse(JSON.stringify(source.snapshot())));
    for (const commands of future) {
      sourceCopy.step(commands);
      mirror.step(commands);
    }
    assert.equal(mirror.stateHash(), sourceCopy.stateHash(), `diverged after restoring at tick ${tick}`);
    assert.deepEqual(
      mirror.enemies.map((e) => e.id),
      sourceCopy.enemies.map((e) => e.id),
      `enemy ids differ after restoring at tick ${tick}`,
    );
    assert.deepEqual(
      mirror.effects.map((e) => e.id),
      sourceCopy.effects.map((e) => e.id),
      `effect ids differ after restoring at tick ${tick}`,
    );
    checked += 1;
  }
  assert.ok(checked > 20);
});

test('a live world matches a restored one exactly, not just a copy of itself', () => {
  // The previous test compares two restored worlds; this one pins the live
  // world against a restored mirror, which is what a client actually does.
  const seed = 99;
  const live = new World({ room, seed, playerCount: 1 });
  const rng = new Rng(seed ^ 0xabcdef);
  for (let tick = 0; tick < 1500; tick++) live.step(scriptedCommands(tick, rng));
  const mirror = new World({ room, seed: 1, playerCount: 1 });
  mirror.restore(JSON.parse(JSON.stringify(live.snapshot())));
  for (let tick = 1500; tick < 2100; tick++) {
    const commands = scriptedCommands(tick, rng);
    live.step(commands);
    mirror.step(commands);
    assert.equal(mirror.stateHash(), live.stateHash(), `live and mirror diverged at tick ${tick}`);
  }
});

test('a snapshot without tiles restores onto a map at the same revision only', () => {
  const source = run(600, 7);
  const mirror = new World({ room, seed: 1 });
  mirror.restore(source.snapshot());
  const slim = source.snapshot({ includeMap: false });
  assert.equal(slim.map.tiles, undefined);
  mirror.restore(slim);
  assert.equal(mirror.stateHash(), source.stateHash());

  const fresh = new World({ room, seed: 1 });
  const cell = fresh.map.cellOf(fresh.map.width / 2, fresh.map.height / 2);
  fresh.map.buildWall(cell.cx, cell.cy, 10);
  assert.throws(() => fresh.restore(slim), /revision/);
});

test('an unseated player stays dead and seating them respawns them', () => {
  const world = new World({ room, seed: 3, playerCount: 2 });
  world.setPlayerConnected(1, false);
  const seat = world.players[1]!;
  assert.equal(seat.state, 'dead');
  for (let i = 0; i < 600; i++) world.step([emptyCommand(), emptyCommand()]);
  assert.equal(seat.state, 'dead', 'an empty seat respawned');
  world.setPlayerConnected(1, true, 'bond');
  assert.equal(seat.state, 'alive');
  assert.equal(seat.characterId, 'bond');
  assert.equal(seat.life, seat.maxLife);
});

test('a devil aims through a barrel, and its fireball bursts on it', () => {
  const { world, player } = quietWorld();
  const devil = (world as unknown as { addEnemy(id: string, x: number, y: number): Enemy | null })
    .addEnemy('devil', player.x + 120, player.y)!;
  assert.ok(devil);
  devil.angle = Math.PI;
  arm(player, 'barrel');
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  const barrel = world.placeables.find((p) => p.ownerId === player.id);
  assert.ok(barrel, 'barrel was not placed');
  assert.ok(barrel.x > player.x && barrel.x < devil.x, 'barrel is not between them');

  for (let i = 0; i < 12; i++) world.step([command(player.x + 100, player.y, false)]);
  assert.equal(devil.hasLos, true, 'a barrel hid the player from the devil');

  let fired = false;
  for (let i = 0; i < 200 && barrel.alive; i++) {
    world.step([command(player.x + 100, player.y, false)]);
    fired ||= world.shots.some((s) => s.kind === 'fireball');
  }
  assert.ok(fired, 'the devil never threw');
  assert.equal(barrel.alive, false, 'the fireball passed the barrel by');
});

// ---- fidelity to the original, recovered from the SWF bytecode ------------

type Placeable = World['placeables'][number];

function place(world: World, player: Player, weapon: 'barrel' | 'mine' | 'chargepack'): Placeable {
  const slot = player.weapons.get(weapon)!;
  slot.unlocked = true;
  slot.ammo = Math.max(slot.ammo, 3);
  player.current = weapon;
  player.fireCooldown = 0;
  player.detonateMode = false;
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  const placed = world.placeables.find((p) => p.ownerId === player.id && p.type === weapon && p.alive);
  assert.ok(placed, `${weapon} was not placed`);
  return placed;
}

/** Tap the pistol at a point a few times. */
function pistolAt(world: World, player: Player, x: number, y: number, taps: number): void {
  player.current = 'pistol';
  player.fireCooldown = 0;
  for (let i = 0; i < taps * 2; i++) world.step([command(x, y, i % 2 === 0)]);
}

test('a claymore is immune to bullets: only a body on its cell sets it off', () => {
  const { world, player } = quietWorld();
  const mine = place(world, player, 'mine');
  pistolAt(world, player, mine.x, mine.y, 10);
  assert.equal(mine.alive, true, 'pistol fire set off a claymore');
  assert.ok(!world.effects.some((e) => e.type === 'explosion'), 'something exploded');
});

test('zombies cannot bite a barrel open; it is a wall to them', () => {
  const { world, player } = quietWorld();
  const barrel = place(world, player, 'barrel');
  const zombie = spawnEnemy(world, barrel.x + 30, barrel.y);
  for (let i = 0; i < 400; i++) world.step([command(player.x + 100, player.y, false)]);
  assert.equal(barrel.alive, true, 'a zombie set the barrel off');
  assert.equal(zombie.state, 'alive');
});

test('Big Bang is two more full blasts a cell out, not a wider one', () => {
  const { world, player } = quietWorld();
  player.held.push({ weapon: 'barrel', upgrade: 'BigBang' });
  player.stats = computeStats(player.held);
  const barrel = place(world, player, 'barrel');
  assert.equal(barrel.extraBlasts, 2);
  assert.equal(barrel.splashRadius, WEAPONS.barrel.splash!.radius, 'the blast radius was scaled');
  world.sounds.length = 0;
  pistolAt(world, player, barrel.x, barrel.y, 2);
  for (let i = 0; i < 20; i++) world.step([command(barrel.x, barrel.y, false)]);
  const blasts = world.sounds.filter((s) => s.name === 'Effect.Explosion').length;
  assert.equal(blasts, 3, `expected the blast plus two more, got ${blasts}`);
});

test('Cluster Explode lobs four shells that burst on their own fuses', () => {
  const { world, player } = quietWorld();
  player.held.push({ weapon: 'barrel', upgrade: 'ClusterExplode' });
  player.stats = computeStats(player.held);
  const barrel = place(world, player, 'barrel');
  pistolAt(world, player, barrel.x, barrel.y, 2);
  const shells = world.shots.filter((s) => s.kind === 'grenade');
  assert.equal(shells.length, 4, `expected four shells, got ${shells.length}`);
  assert.equal(shells[0]!.splashDamage, barrel.splashDamage, 'a shell bursts with the parent damage');
  world.sounds.length = 0;
  for (let i = 0; i < 60; i++) world.step([command(barrel.x, barrel.y, false)]);
  const bursts = world.sounds.filter((s) => s.name === 'Effect.Explosion').length;
  assert.equal(bursts, 4, `expected four bursts, got ${bursts}`);
});

test('charge packs: place, then the next press detonates, even with no ammo left', () => {
  const { world, player } = quietWorld();
  const pack = place(world, player, 'chargepack');
  player.weapons.get('chargepack')!.ammo = 0;
  world.step([command(player.x + 100, player.y, false)]);
  assert.equal(player.current, 'chargepack', 'an empty charge pack was swapped away with packs still out');
  world.step([command(player.x + 100, player.y, true)]);
  assert.ok(pack.fuse >= 0, 'the second press did not light the pack');
  for (let i = 0; i < 12; i++) world.step([command(player.x + 100, player.y, false)]);
  assert.equal(pack.alive, false);
});

test('a crate never holds the pistol and can restore life instead', () => {
  const { world, player } = quietWorld();
  // A full UZI is the only draw besides life, and life outweighs it at 1 hp.
  const uzi = player.weapons.get('uzi')!;
  uzi.unlocked = true;
  uzi.ammo = WEAPONS.uzi.totalAmmo;
  const open = (world as unknown as { openCrate(p: Player): void }).openCrate.bind(world);
  let healed = false;
  for (let i = 0; i < 40 && !healed; i++) {
    player.life = 1;
    open(player);
    healed = player.life === player.maxLife;
  }
  assert.ok(healed, 'a hurt player never drew Life up!');
  assert.ok(!world.messages.some((m) => m.text.includes('Pistol')), 'the pistol came out of a crate');
});

test('deathmatch hands out the arsenal unloaded', () => {
  const world = new World({ room, seed: 11, playerCount: 2, mode: 'deathmatch' });
  for (const player of world.players) {
    assert.ok(player.weapons.get('railgun')!.unlocked);
    assert.equal(player.weapons.get('railgun')!.ammo, 0);
    assert.equal(player.current, 'pistol');
  }
});

test('a pistol wears a fake wall down by its damage', () => {
  const { world, player } = quietWorld();
  arm(player, 'fakewall');
  player.x = 8 * world.map.cell + 16;
  player.y = 6 * world.map.cell + 16;
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  const [wall] = world.breakableCells();
  assert.ok(wall, 'wall was not built');
  const centre = world.map.centreOf(wall.cx, wall.cy);
  pistolAt(world, player, centre.x, centre.y, 3);
  const after = world.breakableCells()[0];
  assert.ok(after && after.hp < wall.hp, 'pistol fire left the wall untouched');
});

test('a bite shoves the player and stuns them for the slide', () => {
  const { world, player } = quietWorld();
  const startX = player.x;
  spawnEnemy(world, player.x + 30, player.y);
  let bitten = false;
  for (let i = 0; i < 200 && !bitten; i++) {
    world.step([command(player.x - 100, player.y, false)]);
    bitten = player.life < player.maxLife - 1;
  }
  assert.ok(bitten, 'the zombie never bit');
  assert.ok(player.stun > 0, 'the bite did not stun');
  // Pushing toward the zombie does nothing while stunned; the slide carries the player away.
  for (let i = 0; i < 6; i++) world.step([command(player.x + 100, player.y, false, 1, 0)]);
  assert.ok(player.x < startX - 4, `player was not shoved away (${startX.toFixed(1)} -> ${player.x.toFixed(1)})`);
});

test('a shot stops a zombie in its tracks', () => {
  const { world, player } = quietWorld();
  arm(player, 'railgun');
  const zombie = spawnEnemy(world, player.x + 80, player.y);
  zombie.life = 1e6;
  world.step([command(player.x + 200, player.y, false)]);
  world.step([command(player.x + 200, player.y, true)]);
  assert.ok(zombie.stun > 0, 'the hit did not stun');
  const x = zombie.x;
  world.step([command(player.x + 200, player.y, false)]);
  assert.ok(zombie.x > x, 'the zombie did not slide away from the shot');
});

test('the multiplier window is real time: more ticks at Fast, fewer at Slow', () => {
  // Three seconds at x1 whatever the speed: 150 ticks at Normal, 300 at Fast.
  assert.equal(multiplierWindow(1, 1), 150);
  assert.equal(multiplierWindow(1, 2), 300);
  assert.equal(multiplierWindow(1, 0.5), 75);
});

// ---- regressions from the bug hunt ----------------------------------------

test('a snapshot with a fireball in flight survives JSON and keeps flying', () => {
  const { world, player } = quietWorld();
  const devil = (world as unknown as { addEnemy(id: string, x: number, y: number): Enemy | null })
    .addEnemy('devil', player.x + 120, player.y)!;
  devil.angle = Math.PI;
  for (let i = 0; i < 200 && !world.shots.some((s) => s.kind === 'fireball'); i++) {
    world.step([command(player.x + 100, player.y, false)]);
  }
  assert.ok(world.shots.some((s) => s.kind === 'fireball'), 'no fireball to snapshot');

  const copy = new World({ room, seed: 5, playerCount: 1 });
  copy.restore(JSON.parse(JSON.stringify(world.snapshot())));
  for (let i = 0; i < 5; i++) {
    world.step([command(player.x + 100, player.y, false)]);
    copy.step([command(player.x + 100, player.y, false)]);
  }
  assert.equal(copy.shots.filter((s) => s.kind === 'fireball').length, world.shots.filter((s) => s.kind === 'fireball').length);
  assert.equal(copy.stateHash(), world.stateHash(), 'the JSON round trip changed the simulation');
});

test('a grenade with Big Bang goes off three times', () => {
  const { world, player } = quietWorld();
  arm(player, 'grenade');
  player.held.push({ weapon: 'grenade', upgrade: 'BigBang' });
  player.stats = computeStats(player.held);
  world.step([command(player.x + 100, player.y, false)]);
  for (let i = 0; i < 10; i++) world.step([command(player.x + 100, player.y, true)]);
  world.step([command(player.x + 100, player.y, false)]);
  world.sounds.length = 0;
  for (let i = 0; i < 200; i++) world.step([command(player.x + 100, player.y, false)]);
  const blasts = world.sounds.filter((s) => s.name === 'Effect.Explosion').length;
  assert.equal(blasts, 3, `expected the grenade blast plus two more, got ${blasts}`);
});

test('an award is announced once, however many seats there are', () => {
  const world = new World({ room, seed: 5, playerCount: 4 });
  const player = world.players[0]!;
  player.invincible = 0;
  arm(player, 'railgun');
  for (const d of [40, 60, 80, 100, 120]) spawnEnemy(world, player.x + d, player.y);
  const idle = [emptyCommand(), emptyCommand(), emptyCommand(), emptyCommand()];
  world.step([command(player.x + 200, player.y, false), ...idle.slice(1)]);
  world.step([command(player.x + 200, player.y, true), ...idle.slice(1)]);
  const banners = world.messages.filter((m) => m.text.includes('UZI'));
  assert.equal(banners.length, 1, `UZI banner shown ${banners.length} times`);
});

test('a finished co-op run brings nobody back', () => {
  const { world, player } = quietWorld();
  player.life = 1;
  for (let i = 0; i < 3; i++) spawnEnemy(world, player.x + 25, player.y);
  for (let i = 0; i < 300 && !world.gameOver; i++) world.step([emptyCommand()]);
  assert.ok(world.gameOver);
  for (let i = 0; i < 600; i++) world.step([emptyCommand()]);
  assert.notEqual(player.state, 'alive', 'the player respawned after the run ended');
});

test('a fake wall on a spawn point\'s way out shuts that spawn', () => {
  const world = new World({ room, seed: 5, playerCount: 1, devils: false });
  // Wall every zombie spawn's entry cell: the first open neighbour east, south, west, north.
  for (const spot of world.map.spawns.zombies) {
    const cell = world.map.cellOf(spot.x, spot.y);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      if (world.map.tileAt(cell.cx + dx, cell.cy + dy) === 0) {
        world.map.buildWall(cell.cx + dx, cell.cy + dy, 1000);
        break;
      }
    }
  }
  for (let i = 0; i < 600; i++) world.step([emptyCommand()]);
  assert.equal(world.enemies.length, 0, 'zombies spawned behind a wall across their exit');
});

test('room 3: border spawns behind the prebuilt walls stay shut until the walls fall', async () => {
  const fs = await import('node:fs');
  const art = JSON.parse(fs.readFileSync(new URL('../../../assets/art.json', import.meta.url), 'utf8'));
  const arena = art.rooms[2];
  // Level 10: a 55-zombie wave, so plenty are still queued when the gate falls.
  const world = new World({ room: arena, seed: 3, playerCount: 1, devils: false, startLevel: 10 });
  const player = world.players[0]!;
  player.maxLife = 1e9;
  player.life = 1e9;
  const pocket = new Set(['5,2', '6,2', '7,2', '8,2', '9,2', '10,2']);
  const inPocket = (): number =>
    world.enemies.filter((e) => {
      const c = world.map.cellOf(e.x, e.y);
      return pocket.has(`${c.cx},${c.cy}`);
    }).length;
  for (let i = 0; i < 2000; i++) {
    world.step([emptyCommand()]);
    assert.equal(inPocket(), 0, `a zombie spawned in the sealed pocket at tick ${world.tick}`);
  }
  assert.ok(world.enemies.length > 0, 'nothing spawned anywhere');
  // Knock the gate down: the pocket opens and zombies come through it.
  for (let cx = 5; cx <= 10; cx++) world.map.damageWall(cx, 3, 1e6);
  let came = false;
  for (let i = 0; i < 3000 && !came; i++) {
    world.step([emptyCommand()]);
    came = inPocket() > 0;
  }
  assert.ok(came, 'the pocket never opened after its walls fell');
});

