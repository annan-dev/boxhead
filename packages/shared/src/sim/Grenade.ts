/**
 * A grenade in flight: the one integrator the simulation steps every tick and
 * the client runs ahead of time to draw the throw's arc.
 *
 * The lob is the original's (`CThing_Shot_Grenade.Process_Normal`): launched
 * from hand height with an upward pace that scales with how long the trigger
 * was held, pulled down by gravity, bouncing off the floor with half its
 * pace and halving again every tick once it is rolling. What the original
 * never modelled and this does is height against the arena: a grenade only
 * meets a wall, a barricade or a barrel that stands taller than it is flying
 * at that moment, so a full throw clears a low cube or a fake wall and lands
 * in the pocket behind, while a weak underhand one bounces back off the
 * same wall. Anything taller than the arc (the wall posts) blocks at every
 * height. A grenade that comes down onto a block rests on its top and rolls
 * off the edge.
 */
import type { GameMap } from '../map/GameMap.js';
import { GRENADE } from '../data/weapons.js';

/** How tall the things a grenade can fly over stand, in world pixels. */
export const OBSTACLE_HEIGHT = {
  /** A player-built fake wall: one cube's worth. */
  fakeWall: 26,
  /** A barrel; a rolling grenade stops on it, a lobbed one clears it. */
  barrel: 24,
} as const;

export interface GrenadeBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface Obstacle {
  x: number;
  y: number;
  radius: number;
}

export type GrenadeBounce = 'floor' | 'wall' | 'barrel' | null;

/**
 * Height of what stands on a cell: 0 for open floor, a block's rise, a fake
 * wall's height, and Infinity for the arena's edge or a solid cell no block
 * stands on (the void beyond the floor), which nothing flies over.
 */
export function obstacleHeight(map: GameMap, cx: number, cy: number): number {
  return map.obstacleHeight(cx, cy);
}

/** True when a point at height `z` would strike whatever stands on its cell. */
function blockedAt(map: GameMap, x: number, y: number, z: number): boolean {
  return obstacleHeight(map, Math.floor(x / map.cell), Math.floor(y / map.cell)) > z + 0.01;
}

/**
 * Advance a grenade one tick. `barrels` are the solid objects it may strike
 * when low. Returns what it bounced off, for the sound, or null.
 */
export function stepGrenade(map: GameMap, body: GrenadeBody, barrels: readonly Obstacle[]): GrenadeBounce {
  let bounce: GrenadeBounce = null;

  // Vertical: fall, and land on whatever is under it (the floor, or a block's top).
  body.vz -= GRENADE.gravity;
  body.z += body.vz;
  const under = obstacleHeight(map, Math.floor(body.x / map.cell), Math.floor(body.y / map.cell));
  const floor = Number.isFinite(under) ? under : 0;
  if (body.z <= floor) {
    body.z = floor;
    if (body.vz < -0.8) {
      body.vz = -body.vz * GRENADE.floorBounce;
      body.vx *= GRENADE.floorBounce;
      body.vy *= GRENADE.floorBounce;
      bounce = 'floor';
    } else {
      body.vz = 0;
      body.vx *= GRENADE.groundDrag;
      body.vy *= GRENADE.groundDrag;
      if (body.vx * body.vx + body.vy * body.vy < 0.01) {
        body.vx = 0;
        body.vy = 0;
      }
    }
  }

  if (body.vx === 0 && body.vy === 0) return bounce;

  // Horizontal: a wall taller than the grenade is flying turns it back,
  // reflected about the face it struck. Each axis is tried on its own so a
  // corner is not simply reversed.
  const nx = body.x + body.vx;
  const ny = body.y + body.vy;
  const hitX = blockedAt(map, nx, body.y, body.z);
  const hitY = blockedAt(map, body.x, ny, body.z);
  if (hitX || hitY || blockedAt(map, nx, ny, body.z)) {
    if (hitX) body.vx = -body.vx;
    if (hitY) body.vy = -body.vy;
    if (!hitX && !hitY) {
      body.vx = -body.vx;
      body.vy = -body.vy;
    }
    body.vx *= GRENADE.wallBounce;
    body.vy *= GRENADE.wallBounce;
    return 'wall';
  }

  // A barrel stops a grenade flying at or below its top; it deflects off the
  // barrel's side and loses most of its pace, as against a wall.
  if (body.z <= OBSTACLE_HEIGHT.barrel) {
    for (const barrel of barrels) {
      const reach = barrel.radius + 3;
      const dx = nx - barrel.x;
      const dy = ny - barrel.y;
      if (dx * dx + dy * dy > reach * reach) continue;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const along = body.vx * ux + body.vy * uy;
      if (along >= 0) continue;
      body.vx = (body.vx - 2 * along * ux) * GRENADE.wallBounce;
      body.vy = (body.vy - 2 * along * uy) * GRENADE.wallBounce;
      return 'barrel';
    }
  }

  body.x = nx;
  body.y = ny;
  return bounce;
}

export interface GrenadePreview {
  /** The path in world space, one point a tick, until the fuse runs out or it stops. */
  points: Array<{ x: number; y: number; z: number }>;
  /** Where each bounce happened. */
  bounces: Array<{ x: number; y: number }>;
  /** Where the grenade will lie when it goes off. */
  rest: { x: number; y: number };
}

/**
 * The whole flight ahead of time, for drawing the arc the way modern
 * shooters do. Pure: the same numbers the simulation will use, so what is
 * drawn is where it lands.
 */
export function previewGrenade(
  map: GameMap,
  barrels: readonly Obstacle[],
  start: { x: number; y: number; angle: number },
  power: number,
  speed: number,
  fuse: number,
): GrenadePreview {
  const body: GrenadeBody = {
    x: start.x,
    y: start.y,
    z: GRENADE.startZ,
    vx: Math.cos(start.angle) * speed * power,
    vy: Math.sin(start.angle) * speed * power,
    vz: GRENADE.launchVz * power,
  };
  const points: GrenadePreview['points'] = [{ x: body.x, y: body.y, z: body.z }];
  const bounces: GrenadePreview['bounces'] = [];
  for (let tick = 0; tick < fuse; tick++) {
    const bounce = stepGrenade(map, body, barrels);
    if (bounce) bounces.push({ x: body.x, y: body.y });
    points.push({ x: body.x, y: body.y, z: body.z });
    if (body.vx === 0 && body.vy === 0 && body.vz === 0 && body.z <= 0.01) break;
  }
  return { points, bounces, rest: { x: body.x, y: body.y } };
}
