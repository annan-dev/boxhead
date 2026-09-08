/**
 * The debrief's tallies: accuracy counts volleys, kills are credited to the
 * weapon that made them, and all of it survives a snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, emptyCommand, type InputCommand } from '../src/sim/World.js';
import { ROOMS } from '../src/data/rooms.js';
import type { Enemy, Player } from '../src/sim/types.js';
import type { WeaponId } from '../src/data/weapons.js';

const room = ROOMS[0]!;

function quietWorld(): { world: World; player: Player } {
  const world = new World({ room, seed: 5, playerCount: 1, devils: false });
  const player = world.players[0]!;
  player.invincible = 100000;
  return { world, player };
}

function spawnEnemy(world: World, x: number, y: number): Enemy {
  const enemy = (world as unknown as { addEnemy(id: string, x: number, y: number): Enemy | null })
    .addEnemy('zombie', x, y);
  assert.ok(enemy, 'enemy pool exhausted');
  enemy.life = 10000;
  return enemy;
}

function arm(player: Player, weapon: WeaponId, ammo = 10): void {
  const slot = player.weapons.get(weapon)!;
  slot.unlocked = true;
  slot.ammo = ammo;
  player.current = weapon;
  player.fireCooldown = 0;
}

function command(aimX: number, aimY: number, fire: boolean): InputCommand {
  return { ...emptyCommand(), aimX, aimY, fire };
}

test('a shotgun volley with every pellet in a zombie is one hit of one shot', () => {
  const { world, player } = quietWorld();
  arm(player, 'shotgun');
  const zombie = spawnEnemy(world, player.x + 60, player.y);
  zombie.radius = 40;
  world.step([command(zombie.x, zombie.y, false)]);
  world.step([command(zombie.x, zombie.y, true)]);
  assert.equal(world.stats.shotsFired, 1);
  assert.equal(world.stats.shotsHit, 1);
});

test('a miss is a shot without a hit', () => {
  const { world, player } = quietWorld();
  arm(player, 'uzi');
  world.step([command(player.x, player.y - 100, false)]);
  world.step([command(player.x, player.y - 100, true)]);
  assert.equal(world.stats.shotsFired, 1);
  assert.equal(world.stats.shotsHit, 0);
});

test('a rocket whose blast reaches a zombie counts as a hit, and the kill goes to the rocket', () => {
  const { world, player } = quietWorld();
  arm(player, 'rocket');
  // A zombie standing well off the line of fire but inside the blast where
  // the rocket meets the wall to the east.
  const wallX = 19 * world.map.cell;
  const zombie = spawnEnemy(world, wallX - 40, player.y + 40);
  zombie.life = 1;
  world.step([command(player.x + 100, player.y, false)]);
  world.step([command(player.x + 100, player.y, true)]);
  for (let i = 0; i < 120 && zombie.state === 'alive'; i++) world.step([command(player.x + 100, player.y, false)]);
  assert.notEqual(zombie.state, 'alive', 'the blast never reached the zombie');
  assert.equal(world.stats.shotsFired, 1);
  assert.equal(world.stats.shotsHit, 1);
  assert.equal(world.stats.killsByWeapon.rocket, 1);
});

test('the longest streak and the weapon tallies survive a snapshot', () => {
  const { world, player } = quietWorld();
  arm(player, 'uzi', 200);
  for (let n = 0; n < 4; n++) {
    const zombie = spawnEnemy(world, player.x + 60, player.y);
    zombie.life = 1;
    world.step([command(zombie.x, zombie.y, false)]);
    for (let i = 0; i < 4 && zombie.state === 'alive'; i++) world.step([command(zombie.x, zombie.y, i % 2 === 0)]);
  }
  assert.ok(world.stats.longestStreak >= 2, `streak ${world.stats.longestStreak}`);
  assert.ok((world.stats.killsByWeapon.uzi ?? 0) >= 2);

  const restored = new World({ room, seed: 1, playerCount: 1, devils: false });
  restored.restore(JSON.parse(JSON.stringify(world.snapshot())));
  assert.deepEqual(restored.stats, world.stats);
});
