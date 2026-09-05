/**
 * Load benchmark.
 *
 * Plays headless until the waves are large, then measures tick cost. The
 * budget is 20ms per tick (50Hz); anything close to that would mean the
 * simulation, not the renderer, is the limit.
 */
import { World, emptyCommand, ROOMS, levelDef } from '../src/index.js';

const world = new World({ room: ROOMS[0]!, seed: 7, playerCount: 1 });
const player = world.players[0]!;
// An unkillable, fully-armed player, so waves keep climbing under load.
player.maxLife = 1e9;
player.life = 1e9;
for (const slot of player.weapons.values()) {
  slot.unlocked = true;
  slot.ammo = 1e9;
}

function commands(): ReturnType<typeof emptyCommand>[] {
  const command = emptyCommand();
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (const enemy of world.enemies) {
    if (enemy.state !== 'alive') continue;
    const d = (enemy.x - player.x) ** 2 + (enemy.y - player.y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = enemy;
    }
  }
  command.aimX = best ? best.x : player.x + 100;
  command.aimY = best ? best.y : player.y;
  command.fire = best !== null;
  return [command];
}

const TARGET_LEVEL = 30;
while (world.level < TARGET_LEVEL && world.tick < 300000) world.step(commands());

const info = levelDef(world.level);
console.log(
  `warmed to level ${world.level} at tick ${world.tick}; ` +
    `wave = ${info.zombieTotal} zombies + ${info.devilTotal} devils, cap ${info.maxAlive}`,
);

let total = 0;
let peak = 0;
let peakEnemies = 0;
const SAMPLES = 6000;
for (let i = 0; i < SAMPLES; i++) {
  const start = performance.now();
  world.step(commands());
  const elapsed = performance.now() - start;
  total += elapsed;
  if (elapsed > peak) peak = elapsed;
  const alive = world.enemies.length;
  if (alive > peakEnemies) peakEnemies = alive;
}

const mean = total / SAMPLES;
console.log(`mean ${mean.toFixed(3)} ms/tick, worst ${peak.toFixed(2)} ms`);
console.log(`budget 20 ms/tick, so ${(20 / mean).toFixed(0)}x headroom`);
console.log(
  `peak concurrent enemies ${peakEnemies}, level reached ${world.level}, ` +
    `score ${world.score.toLocaleString()}, kills ${world.kills}`,
);
