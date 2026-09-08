/**
 * The grenade: a lob that meets the arena by height, thrown from its own
 * control, and an arc preview that lands where the simulation does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, emptyCommand } from '../src/sim/World.js';
import { GameMap, roomFromAscii } from '../src/map/GameMap.js';
import { stepGrenade, previewGrenade, OBSTACLE_HEIGHT, type GrenadeBody } from '../src/sim/Grenade.js';
import { GRENADE, GUN_IDS, WEAPONS } from '../src/data/weapons.js';
import { ROOMS } from '../src/data/rooms.js';

/** A corridor with one cube in the middle; the cell is 32 px. */
function corridor(): GameMap {
  return new GameMap(
    roomFromAscii({
      id: 'corridor',
      name: 'Corridor',
      tiles: [
        '##########',
        '#........#',
        '#....#...#',
        '#........#',
        '##########',
      ],
    }),
  );
}

const body = (x: number, y: number, z: number, vx: number, vz = 0): GrenadeBody => ({ x, y, z, vx, vy: 0, vz });

/** Step until the grenade bounces or has crossed `pastX`; the bounce, if any. */
function flyEast(map: GameMap, g: GrenadeBody, pastX: number, barrels: Parameters<typeof stepGrenade>[2] = []): ReturnType<typeof stepGrenade> {
  for (let i = 0; i < 20; i++) {
    const bounce = stepGrenade(map, g, barrels);
    if (bounce === 'wall' || bounce === 'barrel') return bounce;
    if (g.x > pastX) return null;
  }
  return null;
}

test('a grenade flying higher than a cube passes over it; one flying lower bounces back', () => {
  const map = corridor();
  // The cube is cell (5, 2): x 160..192. Start just west of it, moving east.
  const high = body(150, 80, 40, 6, 2);
  assert.equal(flyEast(map, high, 165), null, 'a high grenade struck the cube');
  assert.ok(high.x > 160, `a high grenade did not cross into the cube's cell: x ${high.x}`);

  const low = body(150, 80, 10, 6, 0);
  assert.equal(flyEast(map, low, 165), 'wall');
  assert.ok(low.vx < 0, 'a low grenade kept going east through the cube');
  assert.ok(low.x < 160, 'a low grenade moved into the cube');
});

test('a wall taller than the arc blocks a grenade at any height it can reach', () => {
  const room = roomFromAscii({ id: 'post', name: 'Post', tiles: ['##########', '#........#', '#....#...#', '#........#', '##########'] });
  // Make the cube a wall post, as the extracted arenas have them.
  const post = room.blocks.find((b) => b.x === 160 && b.y === 64)!;
  post.rise = 54;
  const map = new GameMap(room);
  const flying = body(150, 80, 50, 6, 0);
  assert.equal(flyEast(map, flying, 165), 'wall');
  const higher = body(150, 80, 60, 6, 0);
  assert.equal(flyEast(map, higher, 165), null, 'a grenade above the post was stopped by it');
});

test("the arena's edge is never cleared, however high the throw", () => {
  const map = corridor();
  const sky = body(10, 80, 500, -20, 0);
  assert.equal(stepGrenade(map, sky, []), 'wall');
});

test('a rolling grenade stops against a barrel; a lobbed one clears it', () => {
  const map = corridor();
  const barrel = { x: 100, y: 80, radius: 13 };
  const rolling = body(80, 80, 0, 6, 0);
  assert.equal(stepGrenade(map, rolling, [barrel]), 'barrel');
  assert.ok(rolling.vx < 0, 'the rolling grenade went through the barrel');
  const lobbed = body(80, 80, OBSTACLE_HEIGHT.barrel + 10, 6, 1);
  assert.equal(stepGrenade(map, lobbed, [barrel]), null);
  assert.ok(lobbed.x > 80);
});

test('a grenade that comes down on a block rests on its top rather than falling through', () => {
  const map = corridor();
  // Directly over the cube, falling.
  const g = body(176, 80, 30, 1, -2);
  for (let i = 0; i < 60; i++) stepGrenade(map, g, []);
  assert.equal(g.z, 26, `the grenade did not come to rest on the cube's top: z ${g.z}`);
  assert.ok(g.x >= 160 && g.x < 192, 'the grenade left the cube');
  // Pushed off the edge, it falls to the floor and lies there.
  g.vx = 8;
  for (let i = 0; i < 60; i++) stepGrenade(map, g, []);
  assert.ok(g.x >= 192 && g.z === 0, `it did not drop off the edge onto the floor: x ${g.x} z ${g.z}`);
});

test('the grenade throws from its own control and leaves the gun in hand', () => {
  const world = new World({ room: ROOMS[0]!, seed: 3, playerCount: 1, devils: false });
  const player = world.players[0]!;
  player.weapons.get('grenade')!.unlocked = true;
  player.weapons.get('grenade')!.ammo = 5;
  player.invincible = 100000;
  const aim = (): ReturnType<typeof emptyCommand> => ({ ...emptyCommand(), aimX: player.x + 200, aimY: player.y });
  for (let i = 0; i < GRENADE.chargeTicks + 5; i++) world.step([{ ...aim(), grenade: true }]);
  assert.equal(world.shots.filter((s) => s.kind === 'grenade').length, 0, 'the grenade flew before the control was let go');
  const preview = world.grenadePreview(player, 1);
  world.step([aim()]);
  const shot = world.shots.find((s) => s.kind === 'grenade');
  assert.ok(shot, 'no grenade was thrown on release');
  assert.equal(player.current, 'pistol', 'the throw changed the weapon in hand');
  assert.equal(player.weapons.get('grenade')!.ammo, 4);

  // The drawn arc is the flight: the shot comes to rest where the preview said.
  for (let i = 0; i < (WEAPONS.grenade.fuse ?? 120) - 2 && shot.alive; i++) world.step([aim()]);
  assert.ok(Math.abs(shot.x - preview.rest.x) < 0.5 && Math.abs(shot.y - preview.rest.y) < 0.5,
    `preview rest (${preview.rest.x.toFixed(1)}, ${preview.rest.y.toFixed(1)}) but the grenade lies at (${shot.x.toFixed(1)}, ${shot.y.toFixed(1)})`);
  assert.ok(preview.points.length > 10);
});

test('the cycle keys step through the guns only, and the grenade is never taken in hand', () => {
  const world = new World({ room: ROOMS[0]!, seed: 4, playerCount: 1, devils: false });
  const player = world.players[0]!;
  for (const id of ['uzi', 'grenade', 'barrel', 'mine', 'rocket'] as const) {
    const slot = player.weapons.get(id)!;
    slot.unlocked = true;
    slot.ammo = 10;
  }
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    world.step([{ ...emptyCommand(), nextWeapon: true, aimX: player.x + 10, aimY: player.y }]);
    seen.add(player.current);
  }
  for (const id of seen) assert.ok(GUN_IDS.includes(id as never), `the cycle landed on ${id}`);
  assert.ok(seen.has('uzi') && seen.has('rocket') && seen.has('pistol'));
  world.step([{ ...emptyCommand(), weaponSlot: WEAPONS.grenade.slot, aimX: player.x + 10, aimY: player.y }]);
  assert.notEqual(player.current, 'grenade');
  world.step([{ ...emptyCommand(), weaponSlot: WEAPONS.barrel.slot, aimX: player.x + 10, aimY: player.y }]);
  assert.equal(player.current, 'barrel', 'a placeable is still chosen by its number');
});

test('a preview of a weak throw at a wall post turns back; a full one over a cube lands beyond it', () => {
  const room = roomFromAscii({ id: 'post2', name: 'Post', tiles: ['############', '#..........#', '#.....#....#', '#..........#', '############'] });
  const cube = room.blocks.find((b) => b.x === 192 && b.y === 64)!;
  const cubeMap = new GameMap(room);
  const start = { x: 100, y: 80, angle: 0 };
  const full = previewGrenade(cubeMap, [], start, 1, WEAPONS.grenade.speed, 120);
  assert.ok(full.rest.x > 224, `a full throw did not clear the cube: rests at ${full.rest.x.toFixed(0)}`);
  cube.rise = 54;
  const postMap = new GameMap(room);
  const weak = previewGrenade(postMap, [], { x: 150, y: 80, angle: 0 }, GRENADE.minPower, WEAPONS.grenade.speed, 120);
  assert.ok(weak.rest.x < 192, `a weak throw passed the post: rests at ${weak.rest.x.toFixed(0)}`);
  assert.ok(weak.bounces.length > 0);
});
