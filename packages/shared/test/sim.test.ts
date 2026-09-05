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
  const world = run(9000, 4242);
  assert.ok(world.kills > 0, 'nothing died in 3 minutes of play');
  assert.ok(world.score > 0, 'no score was earned');
  assert.ok(world.level > 1, `never advanced past level 1 (kills: ${world.kills})`);
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

test('upgrades are order independent', async () => {
  const { computeStats } = await import('../src/data/upgrades.js');
  const held = [
    { weapon: 'uzi' as const, upgrade: 'DoubleDamage' as const },
    { weapon: 'uzi' as const, upgrade: 'RapidFire' as const },
    { weapon: 'uzi' as const, upgrade: 'QuadAmmo' as const },
  ];
  const forward = computeStats(held);
  const reversed = computeStats([...held].reverse());
  assert.deepEqual(
    forward.perWeapon.get('uzi'),
    reversed.perWeapon.get('uzi'),
    'upgrade order changed the result',
  );
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
