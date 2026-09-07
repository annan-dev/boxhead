/**
 * Game mode tests: the rules that separate deathmatch from co-op.
 *
 * The helpers mirror the ones in sim.test.ts rather than importing them, so
 * each test file stands on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, emptyCommand, type InputCommand } from '../src/sim/World.js';
import { MODES } from '../src/data/modes.js';
import { ROOMS } from '../src/data/rooms.js';
import { Rng } from '../src/math/Rng.js';
import type { GameMode } from '../src/net/Protocol.js';

const room = ROOMS[0]!;

type PlayerOf<T> = T extends { players: Array<infer P> } ? P : never;
type Player = PlayerOf<World>;

function command(aimX: number, aimY: number, fire: boolean, moveX = 0, moveY = 0): InputCommand {
  return { ...emptyCommand(), aimX, aimY, fire, moveX, moveY };
}

/**
 * Two players in the open, sixty pixels apart on a line, neither protected:
 * the second stands exactly where sim.test.ts parks its target zombies.
 */
function duel(mode: GameMode): { world: World; shooter: Player; target: Player } {
  const world = new World({ room, seed: 5, playerCount: 2, mode });
  const shooter = world.players[0]!;
  const target = world.players[1]!;
  shooter.invincible = 0;
  target.invincible = 0;
  target.x = shooter.x + 60;
  target.y = shooter.y;
  target.prevX = target.x;
  target.prevY = target.y;
  world.hash.move(target.id, target.x, target.y);
  shooter.current = 'pistol';
  shooter.fireCooldown = 0;
  return { world, shooter, target };
}

/** One pistol tap from the shooter at the target; the target stands still. */
function shoot(world: World, shooter: Player, target: Player): void {
  const idle = emptyCommand();
  idle.aimX = target.x + 100;
  idle.aimY = target.y;
  world.step([command(target.x, target.y, false), idle]);
  world.step([command(target.x, target.y, true), idle]);
}

test('deathmatch: a pistol shot at the other player takes their life', () => {
  const { world, shooter, target } = duel('deathmatch');
  const before = target.life;
  shoot(world, shooter, target);
  assert.ok(target.life < before - 1, `target unharmed (${before} -> ${target.life})`);
  assert.equal(shooter.life, shooter.maxLife, 'the shooter hurt themselves');
});

test('co-op: the same shot passes the teammate by', () => {
  const { world, shooter, target } = duel('coop');
  shoot(world, shooter, target);
  assert.equal(target.life, target.maxLife, 'a teammate was hit in co-op');
});

test('deathmatch: a kill is credited and the victim comes back', () => {
  const { world, shooter, target } = duel('deathmatch');
  target.life = 1;
  shoot(world, shooter, target);
  assert.equal(target.state, 'dying');
  assert.equal(shooter.kills, 1);
  assert.equal(shooter.score, 1);
  assert.equal(target.kills, 0);
  assert.ok(!world.gameOver, 'one kill ended the match');
  // The original drops a crate where a deathmatch victim fell.
  assert.ok(world.pickups.some((p) => !p.permanent), 'no crate dropped on the victim');

  const respawnTicks = MODES.deathmatch.respawnTicks!;
  let waited = 0;
  while (target.state !== 'alive' && waited < 400) {
    world.step([emptyCommand(), emptyCommand()]);
    waited += 1;
  }
  assert.equal(target.state, 'alive', 'the victim never respawned');
  assert.ok(waited >= respawnTicks, `respawned after ${waited} ticks, before the ${respawnTicks}-tick wait`);
  assert.equal(target.life, target.maxLife);
  assert.equal(target.invincible, MODES.deathmatch.respawnInvincibleTicks);
});

test('deathmatch: reaching the kill target ends the match with a winner', () => {
  const { world, shooter, target } = duel('deathmatch');
  const killTarget = MODES.deathmatch.killTarget!;
  shooter.kills = killTarget - 1;
  target.life = 1;
  shoot(world, shooter, target);
  assert.equal(shooter.kills, killTarget);
  assert.ok(world.gameOver, 'the match did not end at the kill target');
  assert.equal(world.winnerIndex, 0);
  assert.equal(world.gameOverTick, world.tick);
});

test('deathmatch: no horde, every weapon owned from the start', () => {
  const world = new World({ room, seed: 11, playerCount: 2, mode: 'deathmatch' });
  for (let i = 0; i < 1500; i++) world.step([emptyCommand(), emptyCommand()]);
  assert.equal(world.enemies.length, 0, 'zombies spawned in deathmatch');
  assert.equal(world.level, 1);
  for (const player of world.players) {
    assert.ok(player.weapons.get('railgun')!.unlocked, 'railgun not banked in deathmatch');
  }
});

test('a deathmatch snapshot resumes in lockstep, mode included', () => {
  const seed = 2024;
  const live = new World({ room, seed, playerCount: 2, mode: 'deathmatch' });
  const rng = new Rng(seed ^ 0xabcdef);
  const commandsAt = (tick: number): InputCommand[] => {
    const phase = tick * 0.02;
    const first = emptyCommand();
    first.moveX = Math.cos(phase);
    first.moveY = Math.sin(phase * 0.7);
    first.aimX = 400 + Math.cos(phase * 1.3) * 200;
    first.aimY = 260 + Math.sin(phase * 1.1) * 160;
    first.fire = tick % 7 !== 0;
    if (tick % 300 === 0) first.weaponSlot = rng.int(1, 3);
    const second = { ...first, moveX: -first.moveX, fire: tick % 5 !== 0 };
    return [first, second];
  };
  for (let tick = 0; tick < 800; tick++) live.step(commandsAt(tick));

  // The mirror is built as co-op on purpose: the snapshot must carry the mode.
  const mirror = new World({ room, seed: 1, playerCount: 2 });
  mirror.restore(JSON.parse(JSON.stringify(live.snapshot())));
  assert.equal(mirror.mode, 'deathmatch');
  assert.equal(mirror.stateHash(), live.stateHash(), 'restored world differs');

  for (let tick = 800; tick < 1100; tick++) {
    const commands = commandsAt(tick);
    live.step(commands);
    mirror.step(commands);
    assert.equal(mirror.stateHash(), live.stateHash(), `live and mirror diverged at tick ${tick}`);
  }
  assert.deepEqual(
    mirror.players.map((p) => [p.kills, p.score]),
    live.players.map((p) => [p.kills, p.score]),
  );
});
