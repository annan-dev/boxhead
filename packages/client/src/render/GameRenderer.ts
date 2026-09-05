/**
 * Draws the world.
 *
 * Three layers do the work:
 *
 *   floor    a world-sized offscreen canvas holding the arena's own ground art,
 *            painted once and then only stamped into. Blood and scorch build up
 *            there for a whole run and cost one blit per frame, however many
 *            marks exist.
 *   dynamic  blocks, creatures, objects and effects, depth-sorted every frame.
 *   overlay  HUD and messages, drawn in screen space.
 *
 * Arena blocks are depth-sorted entities rather than part of the floor, because
 * the player has to be able to walk behind one and be occluded by it. Each is
 * drawn as a box: the footprint lifted by its height for the top face, and a
 * band joining that back down to the ground for the front.
 */
import {
  Tile,
  WEAPON_RIG,
  ENEMIES,
  type ArtPack,
  type Decal,
  type Enemy,
  type Player,
  type RoomBlock,
  type SpriteArt,
  type World,
} from '@boxhead/shared';
import { drawComposed, type TextureSwap } from './VectorModel.js';
import { ClipIndex, composePose, type Layer } from './Rig.js';
import { drawLayers, drawSprite } from './SpriteRenderer.js';
import type { Camera } from './Camera.js';

/** Model units to world pixels. Characters stand about 30px tall. */
const MODEL_SCALE = 0.26;

/** Warm stone, to sit against the arena's cream floor. */
const BLOCK_COLORS = {
  top: '#e6e3dc',
  bevel: '#f4f2ec',
  front: '#a09c93',
  side: '#87837b',
  edge: '#5f5c56',
};
const BREAKABLE_COLORS = {
  top: '#b39463',
  bevel: '#c9aa78',
  front: '#7d6540',
  side: '#6a5535',
  edge: '#40331f',
};

interface DrawItem {
  /** Sort key: ground Y, so things lower on screen draw in front. */
  sortY: number;
  render: () => void;
}

export class GameRenderer {
  private readonly floor: HTMLCanvasElement;
  private readonly floorCtx: CanvasRenderingContext2D;
  private readonly clips: ClipIndex;
  private stampedDecals = 0;
  private readonly items: DrawItem[] = [];
  private readonly swapCache = new Map<string, TextureSwap>();
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(
    private readonly world: World,
    private readonly pack: ArtPack,
  ) {
    this.clips = new ClipIndex(pack.clips);
    this.floor = document.createElement('canvas');
    this.floor.width = world.map.width;
    this.floor.height = world.map.height;
    const ctx = this.floor.getContext('2d');
    if (!ctx) throw new Error('failed to create the floor layer');
    this.floorCtx = ctx;
    this.paintFloor();
  }

  private sprite(name: string): SpriteArt | undefined {
    return this.pack.sprites[name];
  }

  /** Paint the arena's ground once; from here it is only ever stamped into. */
  private paintFloor(): void {
    const ctx = this.floorCtx;
    // A base colour behind the art, so any gap outside its extent still reads
    // as ground rather than a hole.
    ctx.fillStyle = '#cfc4ad';
    ctx.fillRect(0, 0, this.floor.width, this.floor.height);

    const layers = this.world.map.floorLayers;
    if (layers && layers.length > 0) {
      drawLayers(ctx, layers);
      this.grainFloor();
    } else {
      // Text-authored arenas have no art; give them a plain tiled ground.
      const cell = this.world.map.cell;
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= this.floor.width; x += cell) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, this.floor.height);
      }
      for (let y = 0; y <= this.floor.height; y += cell) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(this.floor.width, y + 0.5);
      }
      ctx.stroke();
    }
  }

  /**
   * The source ground is a flat colour plate. A little seeded grain and a
   * vignette give it depth without inventing a different surface, and it makes
   * blood and scorch read against something rather than floating on a slab.
   */
  private grainFloor(): void {
    const ctx = this.floorCtx;
    const { width, height } = this.floor;
    let seed = 0x9e3779b9;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    ctx.save();
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < (width * height) / 220; i++) {
      const x = random() * width;
      const y = random() * height;
      ctx.fillStyle = random() > 0.5 ? '#000000' : '#ffffff';
      ctx.fillRect(x, y, 1 + random() * 1.5, 1 + random());
    }

    // Faint scuffs, so large open floors are not uniform.
    ctx.globalAlpha = 0.035;
    ctx.strokeStyle = '#3a3128';
    ctx.lineWidth = 2;
    for (let i = 0; i < 90; i++) {
      const x = random() * width;
      const y = random() * height;
      const length = 20 + random() * 90;
      const angle = random() * Math.PI;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      ctx.stroke();
    }

    // Darken the outer edges so the arena reads as enclosed.
    const vignette = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.28,
      width / 2, height / 2, Math.max(width, height) * 0.72,
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(20,14,8,0.34)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  private stampDecals(): void {
    const decals = this.world.decals;
    if (this.stampedDecals > decals.length) this.stampedDecals = 0;
    for (let i = this.stampedDecals; i < decals.length; i++) this.stampDecal(decals[i]!);
    this.stampedDecals = decals.length;
  }

  private stampDecal(decal: Decal): void {
    const ctx = this.floorCtx;
    ctx.save();
    if (decal.type === 'scorch') {
      const art = this.sprite('Effect.ScorchMark');
      if (art) {
        ctx.globalAlpha = 0.85;
        drawSprite(ctx, art, decal.x, decal.y, { scale: decal.size / 60 });
      } else {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = 'rgba(40,36,34,0.8)';
        ctx.beginPath();
        ctx.arc(decal.x, decal.y, decal.size, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (decal.type === 'pock') {
      const art = this.sprite('Effect.WallMark');
      if (art) drawSprite(ctx, art, decal.x, decal.y, { scale: 0.7, alpha: 0.8 });
    } else {
      // Alternate the two blood shapes and jitter them, so no two marks match.
      const art = this.sprite(decal.seed > 0.5 ? 'Effect.BloodPool' : 'Effect.BloodSplat');
      if (art) {
        drawSprite(ctx, art, decal.x, decal.y, {
          scale: (decal.size / 26) * (0.7 + decal.seed * 0.6),
          rotation: decal.seed * Math.PI * 2,
          alpha: 0.9,
        });
      } else {
        ctx.fillStyle = decal.color;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.arc(decal.x, decal.y, decal.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

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

  /** Direction 0 in the source art faces west, so the angle is rotated first. */
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

  private drawShadow(ctx: CanvasRenderingContext2D, radius: number): void {
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.15, radius * 0.62, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
  }

  // ---- arena --------------------------------------------------------------

  /** A box: top face lifted by the block's height, front band down to ground. */
  private drawBlock(block: RoomBlock, colors: typeof BLOCK_COLORS, damage = 0): void {
    const ctx = this.ctx!;
    const rise = Math.max(8, block.rise);
    const topY = block.y - rise;
    const frontY = block.y + block.h - rise;

    ctx.fillStyle = colors.front;
    ctx.fillRect(block.x, frontY, block.w, rise);
    // A darker sliver down the right edge suggests the second visible side.
    ctx.fillStyle = colors.side;
    ctx.fillRect(block.x + block.w - 3, frontY, 3, rise);

    ctx.fillStyle = colors.top;
    ctx.fillRect(block.x, topY, block.w, block.h);
    ctx.fillStyle = colors.bevel;
    ctx.fillRect(block.x, topY, block.w, 2);

    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(block.x + 0.5, topY + 0.5, block.w - 1, block.h + rise - 1);
    ctx.beginPath();
    ctx.moveTo(block.x, frontY + 0.5);
    ctx.lineTo(block.x + block.w, frontY + 0.5);
    ctx.stroke();

    if (damage > 0.05) {
      ctx.strokeStyle = `rgba(25,18,10,${0.3 + damage * 0.5})`;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const y = frontY + 4 + i * (rise / 3.5);
        ctx.moveTo(block.x + 3, y);
        ctx.lineTo(block.x + block.w - 4, y + (i % 2 === 0 ? 3 : -2));
      }
      ctx.stroke();
    }
  }

  private queueArena(camera: Camera): void {
    const map = this.world.map;
    const left = camera.originX - 64;
    const right = camera.originX + camera.viewWidth + 64;
    const top = camera.originY - 96;
    const bottom = camera.originY + camera.viewHeight + 64;

    for (const block of map.blocks) {
      if (block.x + block.w < left || block.x > right) continue;
      if (block.y + block.h < top || block.y > bottom) continue;
      this.items.push({
        sortY: block.y + block.h,
        render: () => this.drawBlock(block, BLOCK_COLORS),
      });
    }

    // Player-built barricades live in the tile grid rather than the layout.
    const cell = map.cell;
    const minCx = Math.max(0, Math.floor(left / cell));
    const maxCx = Math.min(map.cols - 1, Math.ceil(right / cell));
    const minCy = Math.max(0, Math.floor(top / cell));
    const maxCy = Math.min(map.rows - 1, Math.ceil(bottom / cell));
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (map.tileAt(cx, cy) !== Tile.Breakable) continue;
        const hp = map.integrity[map.index(cx, cy)] ?? 0;
        const damage = 1 - Math.min(1, hp / 300);
        const block: RoomBlock = {
          symbol: 'Object.Wall',
          x: cx * cell,
          y: cy * cell,
          w: cell,
          h: cell,
          rise: 26,
        };
        this.items.push({
          sortY: block.y + block.h,
          render: () => this.drawBlock(block, BREAKABLE_COLORS, damage),
        });
      }
    }
  }

  // ---- creatures ----------------------------------------------------------

  private queuePlayer(player: Player, alpha: number): void {
    const x = player.prevX + (player.x - player.prevX) * alpha;
    const y = player.prevY + (player.y - player.prevY) * alpha;
    const step = Math.floor(player.animStep / 5);
    const anim = this.animFor(player, '');

    const layers: Layer[] = [];
    this.addLayer(layers, 'Player', anim, player.angle, step);
    if (anim === 'Stand' || anim === 'Walk') {
      this.addLayer(layers, WEAPON_RIG[player.current], anim, player.angle, step);
    }
    if (layers.length === 0) return;

    const skin = player.characterId === 'bambo' ? 'Bambo'
      : player.characterId === 'bond' ? 'Bond'
      : player.characterId === 'gijoe' ? 'GIJOE'
      : 'Swat';
    const swap = this.swapFor(skin);
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
        if (enemy.state === 'dying') ctx.globalAlpha = Math.max(0, 1 - enemy.stateTicks / 45);
        this.drawShadow(ctx, enemy.radius * def.drawScale);
        const composed = composePose(layers);
        drawComposed(ctx, composed.parts, {
          scale,
          art: { textures: this.pack.textures, swap },
        });
        if (hurt) {
          // A brief white flash on impact: the clearest possible hit feedback.
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.3;
          drawComposed(ctx, composed.parts, { scale, clipFallback: 0xffffff });
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      },
    });
  }

  // ---- objects and effects ------------------------------------------------

  private queueObjects(): void {
    for (const placeable of this.world.placeables) {
      if (!placeable.alive) continue;
      const { x, y, type } = placeable;
      const name = type === 'barrel' ? 'Object.Barrel'
        : type === 'mine' ? 'Object.Mine'
        : 'Object.ChargePack';
      const art = this.sprite(name);
      // Mines and chargepacks carry an armed frame.
      const frame = type === 'mine'
        ? (placeable.armTime <= 0 ? 1 : 0)
        : type === 'chargepack'
          ? (placeable.fuse % 20 < 10 ? 1 : 0)
          : 0;

      this.items.push({
        sortY: y,
        render: () => {
          const ctx = this.ctx!;
          ctx.save();
          ctx.translate(x, y);
          this.drawShadow(ctx, placeable.radius * 0.9);
          if (art) drawSprite(ctx, art, 0, 0, { scale: 1, frame });
          // The barrel symbol is only a silhouette in the source art, so the
          // drum itself is drawn here as a lit cylinder.
          if (type === 'barrel') {
            ctx.fillStyle = '#8d2a1e';
            ctx.fillRect(-11, -27, 22, 27);
            ctx.fillStyle = '#b3402c';
            ctx.fillRect(-11, -27, 22, 4);
            ctx.fillStyle = '#5e1a12';
            ctx.fillRect(7, -27, 4, 27);
            ctx.fillStyle = '#d8cda2';
            ctx.fillRect(-11, -19, 22, 3);
            ctx.fillRect(-11, -9, 22, 3);
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = 1;
            ctx.strokeRect(-10.5, -26.5, 21, 26);
          }
          ctx.restore();
        },
      });
    }

    const pickupArt = this.sprite('Object.Pickup');
    for (const pickup of this.world.pickups) {
      if (!pickup.alive) continue;
      const { x, y } = pickup;
      const bob = Math.sin(this.world.tick * 0.08 + x) * 1.8;
      this.items.push({
        sortY: y,
        render: () => {
          const ctx = this.ctx!;
          ctx.save();
          ctx.translate(x, y);
          this.drawShadow(ctx, 9);
          ctx.translate(0, bob - 6);
          if (pickupArt) {
            // Health boxes are tinted green so they read apart at a glance.
            const options =
              pickup.type === 'life'
                ? { scale: 0.85, tint: { color: '#25c05a', strength: 0.75 } }
                : { scale: 0.85 };
            drawSprite(ctx, pickupArt, 0, 0, options);
          }
          ctx.restore();
        },
      });
    }
  }

  private drawEffects(): void {
    const ctx = this.ctx!;
    const explosion = this.sprite('Effect.Explosion');
    const smoke = this.sprite('Effect.SmokeCloud');
    const bulletHit = this.sprite('Effect.BulletHit');

    for (const effect of this.world.effects) {
      if (!effect.alive) continue;
      const progress = 1 - effect.life / effect.maxLife;
      ctx.save();
      ctx.translate(effect.x, effect.y);

      switch (effect.type) {
        case 'explosion': {
          if (explosion) {
            // Play the original's 18-frame burst across the effect lifetime.
            const frames = explosion.frames.length;
            drawSprite(ctx, explosion, 0, 0, {
              frame: Math.min(frames - 1, Math.floor(progress * frames)),
              scale: effect.size / 70,
            });
          }
          break;
        }
        case 'muzzle': {
          const flash = this.sprite(effect.seed > 0.5 ? 'Pistol.MuzzleFlash' : 'UZI.MuzzleFlash');
          if (flash) {
            ctx.globalAlpha = 1 - progress;
            drawSprite(ctx, flash, 0, -8, { scale: 0.22, rotation: effect.angle });
          }
          break;
        }
        case 'smoke': {
          if (smoke) {
            ctx.globalAlpha = (1 - progress) * 0.5;
            drawSprite(ctx, smoke, 0, -6 - progress * 10, { scale: 0.16 + progress * 0.14 });
          }
          break;
        }
        case 'blood': {
          ctx.globalAlpha = (1 - progress) * 0.9;
          ctx.fillStyle = '#a5121b';
          for (let i = 0; i < 5; i++) {
            const angle = effect.seed * 7 + i * 1.4;
            const distance = progress * effect.size * 2;
            ctx.fillRect(Math.cos(angle) * distance, Math.sin(angle) * distance - 8, 2.5, 2.5);
          }
          break;
        }
        case 'gib': {
          ctx.globalAlpha = 1 - progress;
          ctx.fillStyle = '#7d1015';
          for (let i = 0; i < 4; i++) {
            const angle = effect.seed * 11 + i * 1.6;
            const distance = progress * 20;
            ctx.fillRect(Math.cos(angle) * distance - 2, Math.sin(angle) * distance - 9, 4, 4);
          }
          break;
        }
        default: {
          if (bulletHit) {
            ctx.globalAlpha = 1 - progress;
            drawSprite(ctx, bulletHit, 0, -6, { scale: 0.6, rotation: effect.angle });
          }
        }
      }
      ctx.restore();
    }

    // Projectiles are live geometry rather than sprites.
    const grenade = this.sprite('Shot.Grenade');
    ctx.save();
    for (const shot of this.world.shots) {
      if (!shot.alive) continue;
      if (shot.kind === 'railgun') {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(150,220,255,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(shot.prevX, shot.prevY - 10);
        ctx.lineTo(shot.x, shot.y - 10);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      } else if (shot.kind === 'grenade' && grenade) {
        drawSprite(ctx, grenade, shot.x, shot.y - 8, { scale: 1.4, rotation: shot.angle });
      } else if (shot.kind === 'rocket') {
        ctx.save();
        ctx.translate(shot.x, shot.y - 10);
        ctx.rotate(shot.angle);
        ctx.fillStyle = '#d8d2c4';
        ctx.fillRect(-5, -2.5, 10, 5);
        ctx.fillStyle = '#b0342a';
        ctx.fillRect(3, -2.5, 2, 5);
        ctx.restore();
      } else {
        ctx.strokeStyle = shot.ownerId === -2 ? 'rgba(255,150,60,0.95)' : 'rgba(255,236,160,0.92)';
        ctx.lineWidth = shot.ownerId === -2 ? 4 : 2;
        ctx.beginPath();
        ctx.moveTo(shot.prevX, shot.prevY - 10);
        ctx.lineTo(shot.x, shot.y - 10);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

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

    // One blit for the whole accumulated floor, however many decals it holds.
    ctx.drawImage(this.floor, 0, 0);

    this.items.length = 0;
    this.queueArena(camera);
    this.queueObjects();
    for (const player of world.players) {
      if (camera.isVisible(player.x, player.y)) this.queuePlayer(player, alpha);
    }
    for (const enemy of world.enemies) {
      if (camera.isVisible(enemy.x, enemy.y)) this.queueEnemy(enemy, alpha);
    }

    this.items.sort((a, b) => a.sortY - b.sortY);
    for (const item of this.items) item.render();

    this.drawEffects();
    ctx.restore();

    if (world.flash > 0) {
      ctx.fillStyle = `rgba(255,240,220,${world.flash * 0.3})`;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    this.ctx = null;
  }
}
