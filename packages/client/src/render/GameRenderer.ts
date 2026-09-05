/**
 * Draws the world.
 *
 * Three layers do the work:
 *
 *   floor    a world-sized offscreen canvas, painted once and then only ever
 *            stamped into. Blood and scorch accumulate there for the whole run
 *            and cost one blit per frame regardless of how many marks exist.
 *   dynamic  walls, creatures, objects and effects, depth-sorted every frame.
 *   overlay  HUD and messages, drawn in screen space.
 *
 * Walls are ordinary depth-sorted entities rather than a baked layer, because
 * the player has to be able to walk behind one and be occluded by it.
 */
import {
  CELL_SIZE,
  Tile,
  WEAPON_RIG,
  ENEMIES,
  type ArtPack,
  type Decal,
  type Effect,
  type Enemy,
  type Player,
  type World,
} from '@boxhead/shared';
import { drawComposed, type TextureSwap } from './VectorModel.js';
import { ClipIndex, composePose, type Layer } from './Rig.js';
import type { Camera } from './Camera.js';

/** Model units to world pixels. Characters stand about 30px tall. */
const MODEL_SCALE = 0.26;
/** Height of a wall block in the oblique projection. */
const WALL_HEIGHT = 30;

interface DrawItem {
  /** Sort key: ground Y, so things lower on screen draw in front. */
  sortY: number;
  render: () => void;
}

const FLOOR_STYLES: Record<string, { base: string; grout: string; speck: string }> = {
  concrete: { base: '#4a4d52', grout: '#3f4247', speck: '#54575c' },
  asphalt: { base: '#3c3e42', grout: '#333539', speck: '#46484c' },
  tile: { base: '#525056', grout: '#45434a', speck: '#5b595f' },
};

export class GameRenderer {
  private readonly floor: HTMLCanvasElement;
  private readonly floorCtx: CanvasRenderingContext2D;
  private readonly clips: ClipIndex;
  /** How many decals have already been stamped into the floor. */
  private stampedDecals = 0;
  private readonly items: DrawItem[] = [];
  private readonly swapCache = new Map<string, TextureSwap>();

  constructor(
    private readonly world: World,
    private readonly pack: ArtPack,
    floorStyle: string = 'concrete',
  ) {
    this.clips = new ClipIndex(pack.clips);
    this.floor = document.createElement('canvas');
    this.floor.width = world.map.width;
    this.floor.height = world.map.height;
    const ctx = this.floor.getContext('2d');
    if (!ctx) throw new Error('failed to create the floor layer');
    this.floorCtx = ctx;
    this.paintFloor(floorStyle);
  }

  /** Paint the base floor once; from here on it is only ever stamped into. */
  private paintFloor(styleName: string): void {
    const ctx = this.floorCtx;
    const style = FLOOR_STYLES[styleName] ?? FLOOR_STYLES.concrete!;
    ctx.fillStyle = style.base;
    ctx.fillRect(0, 0, this.floor.width, this.floor.height);

    // Seeded speckle and grout lines, so the floor is not a flat colour.
    const map = this.world.map;
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    ctx.strokeStyle = style.grout;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let cx = 0; cx <= map.cols; cx++) {
      ctx.moveTo(cx * CELL_SIZE + 0.5, 0);
      ctx.lineTo(cx * CELL_SIZE + 0.5, this.floor.height);
    }
    for (let cy = 0; cy <= map.rows; cy++) {
      ctx.moveTo(0, cy * CELL_SIZE + 0.5);
      ctx.lineTo(this.floor.width, cy * CELL_SIZE + 0.5);
    }
    ctx.stroke();

    ctx.fillStyle = style.speck;
    for (let i = 0; i < map.cols * map.rows * 6; i++) {
      const x = random() * this.floor.width;
      const y = random() * this.floor.height;
      ctx.fillRect(x, y, 1 + random(), 1 + random());
    }
  }

  /** Stamp any decals the simulation has produced since the last frame. */
  private stampDecals(): void {
    const decals = this.world.decals;
    // The queue is capped and shifts from the front, so re-sync if it wrapped.
    if (this.stampedDecals > decals.length) this.stampedDecals = 0;
    for (let i = this.stampedDecals; i < decals.length; i++) {
      this.stampDecal(decals[i]!);
    }
    this.stampedDecals = decals.length;
  }

  private stampDecal(decal: Decal): void {
    const ctx = this.floorCtx;
    ctx.save();
    if (decal.type === 'scorch') {
      // Multiply keeps a scorch mark reading as burn rather than paint.
      ctx.globalCompositeOperation = 'multiply';
      const gradient = ctx.createRadialGradient(
        decal.x,
        decal.y,
        0,
        decal.x,
        decal.y,
        decal.size,
      );
      gradient.addColorStop(0, 'rgba(30,28,30,0.92)');
      gradient.addColorStop(0.6, 'rgba(60,56,58,0.55)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(decal.x, decal.y, decal.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (decal.type === 'pock') {
      ctx.fillStyle = decal.color;
      ctx.fillRect(decal.x - 1.5, decal.y - 1.5, 3, 3);
    } else {
      // Blood: a few overlapping ellipses plus spatter, so no two look alike.
      ctx.fillStyle = decal.color;
      ctx.globalAlpha = 0.78;
      const blobs = 4 + Math.floor(decal.seed * 4);
      for (let i = 0; i < blobs; i++) {
        const angle = decal.seed * Math.PI * 2 + i * 1.7;
        const spread = decal.size * 0.45;
        ctx.beginPath();
        ctx.ellipse(
          decal.x + Math.cos(angle) * spread,
          decal.y + Math.sin(angle) * spread * 0.7,
          decal.size * (0.4 + decal.seed * 0.4),
          decal.size * (0.3 + decal.seed * 0.3),
          angle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 0.6;
      for (let i = 0; i < 6; i++) {
        const angle = decal.seed * 9 + i * 2.1;
        const distance = decal.size * (0.8 + i * 0.3);
        ctx.fillRect(
          decal.x + Math.cos(angle) * distance,
          decal.y + Math.sin(angle) * distance,
          1.5,
          1.5,
        );
      }
    }
    ctx.restore();
  }

  /** Cached per-character material substitutions. */
  private swapFor(prefix: string): TextureSwap {
    const cached = this.swapCache.get(prefix);
    if (cached) return cached;
    const swap: TextureSwap = {};
    for (const piece of ['Body', 'Head'] as const) {
      for (const facing of ['Front', 'Back', 'Side', 'Top'] as const) {
        const specific = `${prefix}_${piece}_${facing}`;
        if (this.pack.textures[specific]) swap[`${piece}_${facing}_MC`] = specific;
      }
    }
    this.swapCache.set(prefix, swap);
    return swap;
  }

  /**
   * Facing index for a clip. Direction 0 in the source art faces west, so the
   * angle is rotated half a turn before quantising.
   */
  private directionIndex(angle: number, directions: number): number {
    if (directions <= 0) return 0;
    const turns = angle / (Math.PI * 2) + 0.5;
    return ((Math.round(turns * directions) % directions) + directions) % directions;
  }

  private frameIndex(clip: { sequence: number[] | null; frames: number }, step: number): number {
    if (clip.frames <= 0) return 0;
    if (!clip.sequence || clip.sequence.length === 0) return step % clip.frames;
    const at = ((step % clip.sequence.length) + clip.sequence.length) % clip.sequence.length;
    return clip.sequence[at] ?? 0;
  }

  private addLayer(layers: Layer[], group: string, anim: string, angle: number, step: number): void {
    const clip = this.clips.get(group, anim);
    if (!clip) return;
    layers.push({
      clip,
      direction: this.directionIndex(angle, clip.directions),
      frame: this.frameIndex(clip, step),
    });
  }

  /** Animation name for a creature's current state. */
  private animFor(
    creature: { state: string; moving: boolean; hitTicks: number; hitFromRear: boolean },
    prefix: '' | 'Zombie_',
  ): string {
    if (creature.state === 'dying') return 'Dying';
    if (creature.state === 'dead' || creature.state === 'respawning') return 'Dead';
    if (creature.hitTicks > 0) return creature.hitFromRear ? 'HitRear' : 'HitFront';
    if (creature.moving) return `${prefix}Walk`;
    return `${prefix}Stand`;
  }

  private queuePlayer(player: Player, alpha: number): void {
    const x = player.prevX + (player.x - player.prevX) * alpha;
    const y = player.prevY + (player.y - player.prevY) * alpha;
    // Walk cycles advance about every fifth tick.
    const step = Math.floor(player.animStep / 5);
    const anim = this.animFor(player, '');

    const layers: Layer[] = [];
    this.addLayer(layers, 'Player', anim, player.angle, step);
    if (anim === 'Stand' || anim === 'Walk') {
      this.addLayer(layers, WEAPON_RIG[player.current], anim, player.angle, step);
    }
    if (layers.length === 0) return;

    const swap = this.swapFor(player.characterId === 'bambo' ? 'Bambo' : 'Swat');
    const fading = player.state === 'dead' ? 0.35 : 1;
    const flashing = player.invincible > 0 && Math.floor(player.invincible / 4) % 2 === 0;

    this.items.push({
      sortY: y,
      render: () => {
        const ctx = this.ctx!;
        ctx.save();
        ctx.translate(x, y);
        ctx.globalAlpha = flashing ? 0.45 : fading;
        this.drawShadow(ctx, player.radius);
        const composed = composePose(layers);
        drawComposed(ctx, composed.parts, {
          scale: MODEL_SCALE,
          art: { textures: this.pack.textures, swap },
        });
        ctx.globalAlpha = 1;
        ctx.restore();
      },
    });
  }

  private queueEnemy(enemy: Enemy, alpha: number): void {
    const x = enemy.prevX + (enemy.x - enemy.prevX) * alpha;
    const y = enemy.prevY + (enemy.y - enemy.prevY) * alpha;
    const def = ENEMIES[enemy.defId];
    const step = Math.floor(enemy.animStep / 5);
    const isZombie = def.headGroup === 'Zombie';

    // Zombies use the shuffling body cycle; devils use the upright one.
    let anim = this.animFor(enemy, isZombie ? 'Zombie_' : '');
    if (enemy.windup > 0) anim = isZombie ? 'Zombie_Attack' : 'Devil_Attack';

    const layers: Layer[] = [];
    this.addLayer(layers, 'Player', anim, enemy.angle, step);
    this.addLayer(layers, def.headGroup, anim, enemy.angle, step);
    if (layers.length === 0) return;

    const swap = this.swapFor(def.skin);
    const scale = MODEL_SCALE * def.drawScale;
    const hurt = enemy.hitTicks > 5;

    this.items.push({
      sortY: y,
      render: () => {
        const ctx = this.ctx!;
        ctx.save();
        ctx.translate(x, y);
        if (enemy.state === 'dying') {
          // Sink and fade as the body settles.
          ctx.globalAlpha = Math.max(0, 1 - enemy.stateTicks / 45);
        }
        this.drawShadow(ctx, enemy.radius * def.drawScale);
        const composed = composePose(layers);
        drawComposed(ctx, composed.parts, {
          scale,
          art: { textures: this.pack.textures, swap },
        });
        if (hurt) {
          // Brief white flash on impact; the clearest possible hit feedback.
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.35;
          drawComposed(ctx, composed.parts, { scale, clipFallback: 0xffffff });
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      },
    });
  }

  /** A soft ellipse under every body; it is what sells the height illusion. */
  private drawShadow(ctx: CanvasRenderingContext2D, radius: number): void {
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.15, radius * 0.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fill();
  }

  private queueWalls(camera: Camera): void {
    const map = this.world.map;
    const minCx = Math.max(0, Math.floor((camera.originX - CELL_SIZE) / CELL_SIZE));
    const maxCx = Math.min(map.cols - 1, Math.ceil((camera.originX + camera.viewWidth) / CELL_SIZE));
    const minCy = Math.max(0, Math.floor((camera.originY - CELL_SIZE) / CELL_SIZE));
    const maxCy = Math.min(
      map.rows - 1,
      Math.ceil((camera.originY + camera.viewHeight + WALL_HEIGHT) / CELL_SIZE),
    );

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const tile = map.tileAt(cx, cy);
        if (tile === Tile.Floor) continue;
        const breakable = tile === Tile.Breakable;
        const left = cx * CELL_SIZE;
        const top = cy * CELL_SIZE;
        const hp = breakable ? (map.integrity[map.index(cx, cy)] ?? 0) : 0;
        this.items.push({
          sortY: top + CELL_SIZE,
          render: () => this.drawWall(left, top, breakable, hp),
        });
      }
    }
  }

  /**
   * An oblique block. The cell footprint is the base; the cap is that square
   * lifted by WALL_HEIGHT, and the front face is the band joining the two.
   * Matching the character art, the top is lit and the front falls into shadow.
   */
  private drawWall(left: number, top: number, breakable: boolean, hp: number): void {
    const ctx = this.ctx!;
    const capY = top - WALL_HEIGHT;
    const frontY = top + CELL_SIZE - WALL_HEIGHT;

    const cap = breakable ? '#8d7550' : '#767c86';
    const front = breakable ? '#5a4a30' : '#474c54';
    const edge = breakable ? '#33291a' : '#2b2f35';

    // Front face first, then the cap over it.
    ctx.fillStyle = front;
    ctx.fillRect(left, frontY, CELL_SIZE, WALL_HEIGHT);
    ctx.fillStyle = cap;
    ctx.fillRect(left, capY, CELL_SIZE, CELL_SIZE);

    // A lighter lip along the leading edge reads as a bevel.
    ctx.fillStyle = breakable ? '#a58a5f' : '#8b929c';
    ctx.fillRect(left, capY, CELL_SIZE, 3);

    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, capY + 0.5, CELL_SIZE - 1, CELL_SIZE + WALL_HEIGHT - 1);
    ctx.beginPath();
    ctx.moveTo(left, frontY + 0.5);
    ctx.lineTo(left + CELL_SIZE, frontY + 0.5);
    ctx.stroke();

    if (breakable) {
      // Cracks deepen as the barricade takes damage, so it reads as failing.
      const damage = 1 - Math.min(1, hp / 300);
      if (damage > 0.1) {
        ctx.strokeStyle = `rgba(20,14,8,${0.3 + damage * 0.55})`;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const y = frontY + 6 + i * 8;
          ctx.moveTo(left + 4, y);
          ctx.lineTo(left + CELL_SIZE - 6, y + (i % 2 === 0 ? 4 : -3));
        }
        ctx.stroke();
      }
    }
  }

  private queueObjects(): void {
    for (const placeable of this.world.placeables) {
      if (!placeable.alive) continue;
      const { x, y, type } = placeable;
      this.items.push({
        sortY: y,
        render: () => {
          const ctx = this.ctx!;
          ctx.save();
          ctx.translate(x, y);
          this.drawShadow(ctx, placeable.radius);
          if (type === 'barrel') {
            ctx.fillStyle = '#7a2b22';
            ctx.fillRect(-11, -26, 22, 26);
            ctx.fillStyle = '#9c3a2c';
            ctx.fillRect(-11, -26, 22, 5);
            ctx.fillStyle = '#c9be8a';
            ctx.fillRect(-11, -17, 22, 4);
          } else if (type === 'mine') {
            const armed = placeable.armTime <= 0;
            ctx.fillStyle = '#3d4a35';
            ctx.fillRect(-9, -6, 18, 8);
            ctx.fillStyle = armed ? '#ff4a3a' : '#6b6b6b';
            ctx.fillRect(-2, -9, 4, 4);
          } else {
            ctx.fillStyle = '#2f4f6b';
            ctx.fillRect(-10, -20, 20, 20);
            // Blink faster as the fuse runs down.
            const urgency = Math.max(1, Math.floor(placeable.fuse / 12));
            ctx.fillStyle = placeable.fuse % urgency < urgency / 2 ? '#ffd23a' : '#7a6a20';
            ctx.fillRect(-4, -16, 8, 4);
          }
          ctx.restore();
        },
      });
    }

    for (const pickup of this.world.pickups) {
      if (!pickup.alive) continue;
      const { x, y } = pickup;
      const bob = Math.sin(this.world.tick * 0.08 + x) * 2;
      this.items.push({
        sortY: y,
        render: () => {
          const ctx = this.ctx!;
          ctx.save();
          ctx.translate(x, y);
          this.drawShadow(ctx, 8);
          ctx.translate(0, bob);
          if (pickup.type === 'life') {
            ctx.fillStyle = '#d63a4a';
            ctx.fillRect(-8, -14, 16, 10);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(-2, -12, 4, 6);
            ctx.fillRect(-5, -10, 10, 2);
          } else {
            ctx.fillStyle = '#c8a53c';
            ctx.fillRect(-7, -12, 14, 9);
            ctx.fillStyle = '#8a6f22';
            ctx.fillRect(-7, -12, 14, 2);
          }
          ctx.restore();
        },
      });
    }
  }

  private drawEffects(): void {
    const ctx = this.ctx!;
    for (const effect of this.world.effects) {
      if (!effect.alive) continue;
      const t = 1 - effect.life / effect.maxLife;
      ctx.save();
      ctx.translate(effect.x, effect.y);
      switch (effect.type) {
        case 'explosion': {
          const radius = effect.size * (0.3 + t * 0.8);
          const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
          gradient.addColorStop(0, `rgba(255,246,200,${0.95 * (1 - t)})`);
          gradient.addColorStop(0.4, `rgba(255,150,40,${0.8 * (1 - t)})`);
          gradient.addColorStop(1, 'rgba(120,40,10,0)');
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(0, 0, radius, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'muzzle': {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = '#ffe9a8';
          ctx.beginPath();
          ctx.arc(0, -10, effect.size * (1 - t * 0.5), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'blood': {
          ctx.globalAlpha = (1 - t) * 0.85;
          ctx.fillStyle = '#8e1119';
          for (let i = 0; i < 5; i++) {
            const angle = effect.seed * 7 + i * 1.4;
            const distance = t * effect.size * 2;
            ctx.fillRect(Math.cos(angle) * distance, Math.sin(angle) * distance - 8, 2.5, 2.5);
          }
          break;
        }
        case 'gib': {
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = '#6d0f14';
          for (let i = 0; i < 4; i++) {
            const angle = effect.seed * 11 + i * 1.6;
            const distance = t * 22;
            ctx.fillRect(Math.cos(angle) * distance - 2, Math.sin(angle) * distance - 10, 4, 4);
          }
          break;
        }
        case 'smoke': {
          ctx.globalAlpha = (1 - t) * 0.45;
          ctx.fillStyle = '#9aa0a6';
          ctx.beginPath();
          ctx.arc(0, -6 - t * 10, effect.size * (0.4 + t), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        default: {
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = '#ffd9a0';
          ctx.fillRect(-2, -2, 4, 4);
        }
      }
      ctx.restore();
    }

    // Shots are drawn as live geometry rather than sprites.
    ctx.save();
    for (const shot of this.world.shots) {
      if (!shot.alive) continue;
      if (shot.kind === 'railgun') {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(150,220,255,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(shot.prevX, shot.prevY);
        ctx.lineTo(shot.x, shot.y);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      } else if (shot.kind === 'rocket' || shot.kind === 'grenade') {
        ctx.fillStyle = shot.kind === 'rocket' ? '#d8d2c4' : '#4a5a3a';
        ctx.save();
        ctx.translate(shot.x, shot.y - 10);
        ctx.rotate(shot.angle);
        ctx.fillRect(-5, -2.5, 10, 5);
        ctx.restore();
      } else {
        ctx.strokeStyle = shot.ownerId === -2 ? 'rgba(255,150,60,0.95)' : 'rgba(255,232,150,0.9)';
        ctx.lineWidth = shot.ownerId === -2 ? 4 : 2;
        ctx.beginPath();
        ctx.moveTo(shot.prevX, shot.prevY - 10);
        ctx.lineTo(shot.x, shot.y - 10);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private ctx: CanvasRenderingContext2D | null = null;

  /** Draw a frame. `alpha` interpolates between the last two simulation steps. */
  draw(ctx: CanvasRenderingContext2D, camera: Camera, alpha: number): void {
    this.ctx = ctx;
    this.stampDecals();

    const world = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // Shake is applied to the view only; the simulation never sees it.
    const shakeX = world.shake > 0 ? (Math.random() - 0.5) * world.shake * 2 : 0;
    const shakeY = world.shake > 0 ? (Math.random() - 0.5) * world.shake * 2 : 0;

    ctx.save();
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.originX + shakeX, -camera.originY + shakeY);

    // One blit for the entire accumulated floor, however many decals it holds.
    ctx.drawImage(this.floor, 0, 0);

    this.items.length = 0;
    this.queueWalls(camera);
    this.queueObjects();
    for (const player of world.players) {
      if (camera.isVisible(player.x, player.y)) this.queuePlayer(player, alpha);
    }
    for (const enemy of world.enemies) {
      if (camera.isVisible(enemy.x, enemy.y)) this.queueEnemy(enemy, alpha);
    }

    // Painter's order by ground Y, so nearer things overlap further ones.
    this.items.sort((a, b) => a.sortY - b.sortY);
    for (const item of this.items) item.render();

    this.drawEffects();
    ctx.restore();

    if (world.flash > 0) {
      ctx.fillStyle = `rgba(255,240,220,${world.flash * 0.35})`;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    this.ctx = null;
  }
}
