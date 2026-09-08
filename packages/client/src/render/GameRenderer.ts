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
  CHARACTERS,
  Tile,
  WEAPON_RIG,
  DEATH,
  ENEMIES,
  FAKE_WALL_HP,
  type ArtPack,
  type Decal,
  type Enemy,
  type Player,
  type RoomBlock,
  type SpriteArt,
  type World,
  EFFECT_TICKS,
} from '@boxhead/shared';
import { drawComposed, type DrawOptions, type Palette, type TextureSwap } from './VectorModel.js';
import { CHARACTER_PALETTES } from './HeadArt.js';
import { ClipIndex, composePose, type Layer } from './Rig.js';
import { drawLayers, drawSprite, spriteBounds, spriteFrameCount } from './SpriteRenderer.js';
import type { Camera } from './Camera.js';

/** Model units to world pixels. Characters stand about 30px tall. */
const MODEL_SCALE = 0.26;

/**
 * A character pose rendered once at the current zoom. Puppets are hundreds
 * of polygons each; with a wave on screen, re-tracing them every frame was the
 * single biggest cost in the renderer. Drawing a cached bitmap is one call.
 */
interface CachedPose {
  canvas: HTMLCanvasElement;
  /** Top-left of the bitmap relative to the character origin, in world units. */
  offsetX: number;
  offsetY: number;
  /** Bitmap size in world units, so it lands at exactly 1:1 device pixels. */
  width: number;
  height: number;
}
/** Enough for every creature, direction, frame and skin on screen at once. */
const POSE_CACHE_LIMIT = 1200;
/** Device pixels of slack around a cached pose, for outlines and rounding. */
const POSE_PAD = 3;

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
  /** Sequence number of the newest decal already on the floor layer. */
  private stampedSeq = 0;
  private readonly items: DrawItem[] = [];
  private readonly swapCache = new Map<string, TextureSwap>();
  private readonly poseCache = new Map<string, CachedPose | null>();
  /** Zoom the pose cache was rendered at; a change throws it away. */
  private poseCacheZoom = 0;
  private zoom = 1;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(
    private readonly world: World,
    private readonly pack: ArtPack,
    /** Whose placement outline to draw; -1 for nobody's. */
    private readonly localPlayerIndex = 0,
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
    const layers = this.world.map.floorLayers;
    if (layers && layers.length > 0) {
      // Beyond the painted floor is nothing: the original showed black there,
      // and the camera is held inside the floor so it is rarely seen anyway.
      ctx.fillStyle = '#0d0f12';
      ctx.fillRect(0, 0, this.floor.width, this.floor.height);
      drawLayers(ctx, layers);
      this.grainFloor();
    } else {
      ctx.fillStyle = '#cfc4ad';
      ctx.fillRect(0, 0, this.floor.width, this.floor.height);
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
    // The sim recycles old marks once it hits its cap, so indices shift;
    // sequence numbers say what is new regardless.
    const decals = this.world.decals;
    let start = decals.length;
    while (start > 0 && decals[start - 1]!.seq > this.stampedSeq) start -= 1;
    for (let i = start; i < decals.length; i++) this.stampDecal(decals[i]!);
    if (decals.length > 0) this.stampedSeq = decals[decals.length - 1]!.seq;
  }

  private stampDecal(decal: Decal): void {
    const ctx = this.floorCtx;
    ctx.save();
    if (decal.type === 'scorch') {
      const art = this.sprite('Effect.ScorchMark');
      if (art) {
        // The original stamps its scorch at a fixed size whatever the blast.
        drawSprite(ctx, art, decal.x, decal.y, { rotation: decal.seed * Math.PI * 2 });
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
      // One of the four splat shapes, sized to the drop, rotated at random and
      // squashed a little to lie on the floor rather than stand on it.
      const art = this.sprite('Effect.BloodSplat');
      if (art) {
        ctx.translate(decal.x, decal.y);
        ctx.scale(1, 0.8);
        drawSprite(ctx, art, 0, 0, {
          frame: Math.floor(decal.seed * 4),
          scale: decal.size / 25,
          rotation: decal.seed * Math.PI * 2,
          alpha: 0.85,
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

  /**
   * Map a facing angle to a baked direction frame.
   *
   * Measured against the art itself: direction k of an n-way clip faces
   * (k + 1) * 360/n degrees past west, so frame 3 of a 16-way clip looks
   * exactly north and frame 11 exactly south. Rounding to the nearest frame
   * and stepping back one index is what lines the puppet up with the aim.
   */
  private directionIndex(angle: number, directions: number): number {
    if (directions <= 0) return 0;
    const turns = angle / (Math.PI * 2) + 0.5;
    const nearest = Math.round(turns * directions) - 1;
    return ((nearest % directions) + directions) % directions;
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

  private poseKey(layers: Layer[], skin: string, scale: number, flash: boolean): string {
    let key = '';
    for (const layer of layers) key += `${layer.clip.id}/${layer.direction}/${layer.frame}|`;
    return `${key}${skin}#${scale}${flash ? '#w' : ''}`;
  }

  /**
   * Fetch a pose bitmap, rendering it on first use. `flash` renders the white
   * hit-flash silhouette instead of the textured character.
   */
  private cachedPose(
    key: string,
    layers: Layer[],
    scale: number,
    swap: TextureSwap,
    flash: boolean,
    palette?: Palette,
  ): CachedPose | null {
    if (this.poseCacheZoom !== this.zoom) {
      this.poseCache.clear();
      this.poseCacheZoom = this.zoom;
    }
    const hit = this.poseCache.get(key);
    if (hit !== undefined) return hit;

    const composed = composePose(layers);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const consider = (poly: number[]): void => {
      for (let i = 0; i < poly.length - 1; i += 2) {
        const px = poly[i]!;
        const py = poly[i + 1]!;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    };
    for (const { part } of composed.parts) {
      for (const face of part.faces) consider(face.poly);
      for (const poly of part.outline) consider(poly);
      for (const poly of part.shadow) consider(poly);
    }
    if (!Number.isFinite(minX)) {
      this.poseCache.set(key, null);
      return null;
    }

    // Device pixels per model unit: the pose is drawn at the size it will show.
    const px = scale * this.zoom;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((maxX - minX) * px) + POSE_PAD * 2;
    canvas.height = Math.ceil((maxY - minY) * px) + POSE_PAD * 2;
    const c = canvas.getContext('2d');
    if (!c) return null;
    c.translate(POSE_PAD - minX * px, POSE_PAD - minY * px);
    const options: DrawOptions = flash
      ? { scale: px, clipFallback: 0xffffff }
      : { scale: px, art: { textures: this.pack.textures, swap }, ...(palette ? { palette } : {}) };
    drawComposed(c, composed.parts, options);

    const entry: CachedPose = {
      canvas,
      offsetX: minX * scale - POSE_PAD / this.zoom,
      offsetY: minY * scale - POSE_PAD / this.zoom,
      width: canvas.width / this.zoom,
      height: canvas.height / this.zoom,
    };
    if (this.poseCache.size >= POSE_CACHE_LIMIT) {
      // Drop the oldest entry; insertion order is what Map gives us.
      const oldest = this.poseCache.keys().next().value;
      if (oldest !== undefined) this.poseCache.delete(oldest);
    }
    this.poseCache.set(key, entry);
    return entry;
  }

  private drawPose(ctx: CanvasRenderingContext2D, pose: CachedPose): void {
    ctx.drawImage(pose.canvas, pose.offsetX, pose.offsetY, pose.width, pose.height);
  }

  /** Bitmaps rendered for the pose cache so far, for the stats overlay. */
  get cachedPoses(): number {
    return this.poseCache.size;
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
    // The original's wall symbol carries ten damage states, so a wall visibly
    // crumbles as zombies chew it.
    const wallArt = this.sprite('Object.Wall');
    const cell = map.cell;
    const minCx = Math.max(0, Math.floor(left / cell));
    const maxCx = Math.min(map.cols - 1, Math.ceil(right / cell));
    const minCy = Math.max(0, Math.floor(top / cell));
    const maxCy = Math.min(map.rows - 1, Math.ceil(bottom / cell));
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (map.tileAt(cx, cy) !== Tile.Breakable) continue;
        const hp = map.integrity[map.index(cx, cy)] ?? 0;
        const damage = 1 - Math.min(1, hp / FAKE_WALL_HP);
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
          render: () =>
            wallArt
              ? this.drawBarricade(wallArt, cx, cy, damage)
              : this.drawBlock(block, BREAKABLE_COLORS, damage),
        });
      }
    }
  }

  /** The original wall symbol, scaled to the cell and stepped through its damage frames. */
  private drawBarricade(art: SpriteArt, cx: number, cy: number, damage: number): void {
    const ctx = this.ctx!;
    const cell = this.world.map.cell;
    const b = spriteBounds(art);
    const scale = cell / b.w;
    const frames = spriteFrameCount(art);
    const frame = Math.min(frames - 1, Math.floor(damage * frames));
    // Anchor the art's footprint to the cell: centred, sitting on the cell's bottom edge.
    const x = cx * cell + cell / 2 - (b.x + b.w / 2) * scale;
    const y = cy * cell + cell - (b.y + b.h) * scale;
    drawSprite(ctx, art, x, y, { scale, frame });
  }

  // ---- creatures ----------------------------------------------------------

  private queuePlayer(player: Player, alpha: number): void {
    const x = player.prevX + (player.x - player.prevX) * alpha;
    const y = player.prevY + (player.y - player.prevY) * alpha;
    const step = Math.floor(player.animStep / 5);
    const anim = this.animFor(player, '');

    const character = CHARACTERS.find((c) => c.id === player.characterId);
    const layers: Layer[] = [];
    this.addLayer(layers, 'Player', anim, player.angle, step);
    // Only Bambo has his own head in the art; the others share the default.
    if (character?.headGroup) this.addLayer(layers, character.headGroup, anim, player.angle, step);
    if (anim === 'Stand' || anim === 'Walk') {
      this.addLayer(layers, WEAPON_RIG[player.current], anim, player.angle, step);
    }
    if (layers.length === 0) return;

    const skin = character?.skin ?? 'Swat';
    const swap = this.swapFor(skin);
    const palette = CHARACTER_PALETTES[player.characterId];
    const fading = player.state === 'dead' ? 0.35 : 1;
    const flashing = player.invincible > 0 && Math.floor(player.invincible / 4) % 2 === 0;
    const key = this.poseKey(layers, skin, MODEL_SCALE, false);

    this.items.push({
      sortY: y,
      render: () => {
        const ctx = this.ctx!;
        ctx.save();
        ctx.translate(x, y);
        ctx.globalAlpha = flashing ? 0.45 : fading;
        this.drawShadow(ctx, player.radius);
        const pose = this.cachedPose(key, layers, MODEL_SCALE, swap, false, palette);
        if (pose) this.drawPose(ctx, pose);
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
    if (enemy.windup > 0 && enemy.state === 'alive') anim = isZombie ? 'Zombie_Attack' : 'Devil_Attack';

    const layers: Layer[] = [];
    this.addLayer(layers, 'Player', anim, enemy.angle, step);
    this.addLayer(layers, def.headGroup, anim, enemy.angle, step);
    if (layers.length === 0) return;

    const swap = this.swapFor(def.skin);
    const scale = MODEL_SCALE * def.drawScale;
    const hurt = enemy.hitTicks > 5;
    const key = this.poseKey(layers, def.skin, scale, false);
    const flashKey = hurt ? this.poseKey(layers, def.skin, scale, true) : '';

    this.items.push({
      sortY: y,
      render: () => {
        const ctx = this.ctx!;
        ctx.save();
        ctx.translate(x, y);
        // The corpse lies at full strength and fades away over its last second.
        if (enemy.state === 'dead') {
          const left = DEATH.corpseTicks - enemy.stateTicks;
          ctx.globalAlpha = Math.max(0, Math.min(1, left / DEATH.fadeTicks));
        }
        this.drawShadow(ctx, enemy.radius * def.drawScale);
        const pose = this.cachedPose(key, layers, scale, swap, false);
        if (pose) this.drawPose(ctx, pose);
        if (!isZombie && enemy.windup > 0 && enemy.state === 'alive') {
          // The devil winds up with the fireball already in hand, its clip
          // cycling, as the original's held-fireball effect does.
          const held = this.sprite('Effect.FireBall');
          if (held) {
            const reach = enemy.radius * 0.9;
            drawSprite(
              ctx,
              held,
              Math.cos(enemy.angle) * reach,
              Math.sin(enemy.angle) * reach * 0.6 - 18,
              { frame: Math.floor(this.world.tick / 2) + enemy.id },
            );
          }
        }
        if (hurt) {
          // A brief white flash on impact: the clearest possible hit feedback.
          const flash = this.cachedPose(flashKey, layers, scale, swap, true);
          if (flash) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.3;
            this.drawPose(ctx, flash);
            ctx.globalCompositeOperation = 'source-over';
          }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      },
    });
  }

  /**
   * The cell the local player's barrel, mine, charge pack or wall would land
   * in, drawn as a pale square on the floor, the way Minecraft shows the
   * block under the cursor. Red-tinted when the game would refuse it.
   */
  private drawPlacementOutline(ctx: CanvasRenderingContext2D): void {
    const player = this.world.players[this.localPlayerIndex];
    if (!player || player.state !== 'alive') return;
    const target = this.world.placementTarget(player);
    if (!target) return;
    const cell = this.world.map.cell;
    const x = target.cx * cell;
    const y = target.cy * cell;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = target.ok ? 'rgba(255,255,255,0.75)' : 'rgba(226,0,26,0.7)';
    ctx.fillStyle = target.ok ? 'rgba(255,255,255,0.16)' : 'rgba(226,0,26,0.14)';
    ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
    ctx.restore();
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
          if (art) {
            drawSprite(ctx, art, 0, 0, { scale: 1, frame });
          } else if (type === 'barrel') {
            // No art pack: a plain drum so the object still reads.
            ctx.fillStyle = '#8d2a1e';
            ctx.fillRect(-11, -27, 22, 27);
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = 1;
            ctx.strokeRect(-10.5, -26.5, 21, 26);
          }
          ctx.restore();
        },
      });
    }

    // The original's crate, drawn as-is: one symbol for every pickup, sitting
    // still on the floor with its own painted shadow.
    const pickupArt = this.sprite('Object.Pickup');
    for (const pickup of this.world.pickups) {
      if (!pickup.alive || pickup.hiddenUntil > 0) continue;
      const { x, y } = pickup;
      this.items.push({
        sortY: y,
        render: () => {
          const ctx = this.ctx!;
          ctx.save();
          ctx.translate(x, y);
          if (pickupArt) {
            drawSprite(ctx, pickupArt, 0, 0, { scale: 1 });
          } else {
            this.drawShadow(ctx, 9);
            ctx.fillStyle = '#c83a1c';
            ctx.fillRect(-9, -14, 18, 14);
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
    const bloodSpray = this.sprite('Effect.BloodHitBack');
    const rocketSmoke = this.sprite('Effect.RocketSmoke');
    // The original plays a clip once over an effect's life, one frame per
    // step; this maps that onto whatever frames the symbol has.
    const frameAt = (art: SpriteArt, progress: number): number =>
      Math.min(art.frames.length - 1, Math.floor(progress * art.frames.length));

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
          // Each weapon family has its own flash in the source art, drawn at
          // full size along the aim for a single original frame.
          const name =
            effect.variant === 'shotgun' ? 'Shotgun.MuzzleFlash'
            : effect.variant === 'railgun' ? 'Railgun.MuzzleFlash'
            : effect.variant === 'uzi' ? 'UZI.MuzzleFlash'
            : 'Pistol.MuzzleFlash';
          const flash = this.sprite(name) ?? this.sprite('Pistol.MuzzleFlash');
          if (flash) drawSprite(ctx, flash, 0, -8, { rotation: effect.angle });
          break;
        }
        case 'fireball': {
          // A devil's shot landing: a short flare where it struck.
          const art = this.sprite('Effect.FireBall') ?? explosion;
          if (art) {
            drawSprite(ctx, art, 0, -8, {
              scale: (0.8 + progress * 0.8) * (effect.size / 18),
              alpha: 1 - progress,
              frame: Math.floor(this.world.tick / 2),
            });
          }
          break;
        }
        case 'smoke': {
          // The original's smoke cloud, its clip played once.
          if (smoke) drawSprite(ctx, smoke, 0, -6, { frame: frameAt(smoke, progress) });
          break;
        }
        case 'rocketsmoke': {
          // A rocket exhaust puff: the clip spreads and thins as it drifts.
          if (rocketSmoke) {
            drawSprite(ctx, rocketSmoke, 0, -10, { frame: frameAt(rocketSmoke, progress) });
          } else {
            ctx.globalAlpha = (1 - progress) * 0.4;
            ctx.fillStyle = '#999999';
            ctx.beginPath();
            ctx.arc(0, -10, 10 + progress * 45, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        case 'blood': {
          // The original throws a 75px streak out along the hit, which reads
          // as a solid red cone. Keep a short, fading trace of it for the
          // direction, and let a handful of drops carry the rest: they fly
          // out with the hit, slow down, and fade.
          if (bloodSpray && progress < 0.5) {
            drawSprite(ctx, bloodSpray, 0, -8, {
              frame: frameAt(bloodSpray, progress * 2),
              rotation: effect.angle,
              scale: 0.4,
              alpha: (1 - progress * 2) * 0.8,
            });
          }
          ctx.fillStyle = '#9e1119';
          const ease = 1 - (1 - progress) * (1 - progress);
          for (let i = 0; i < 7; i++) {
            // Per-drop constants from the seed, so each hit looks different
            // but a drop keeps its own path from frame to frame.
            const t = (effect.seed * 97 + i * 13.7) % 1;
            const u = (effect.seed * 61 + i * 7.3) % 1;
            const angle = effect.angle + (t - 0.5) * 1.1;
            const reach = 14 + u * 26;
            const distance = ease * reach;
            const rise = Math.sin(Math.min(1, progress * 1.6) * Math.PI) * (4 + t * 8);
            const size = 1.5 + u * 1.5;
            ctx.globalAlpha = Math.max(0, 1 - progress * 1.15) * 0.9;
            ctx.fillRect(
              Math.cos(angle) * distance - size / 2,
              Math.sin(angle) * distance - 8 - rise - size / 2,
              size,
              size,
            );
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
          // A bullet striking a wall: the original's puff, played once.
          if (bulletHit) drawSprite(ctx, bulletHit, 0, -6, { frame: frameAt(bulletHit, progress) });
        }
      }
      ctx.restore();
    }

    // Projectiles are live geometry rather than sprites.
    const grenade = this.sprite('Shot.Grenade');
    const fireball = this.sprite('Effect.FireBall');
    const rocketArt = this.sprite('Shot.Rocket');
    ctx.save();
    for (const shot of this.world.shots) {
      if (!shot.alive) continue;
      if (shot.kind === 'fireball') {
        // Devil fire: the original cycles the fireball clip a frame a tick.
        if (fireball) {
          drawSprite(ctx, fireball, shot.x, shot.y - 10, {
            frame: Math.floor(this.world.tick / 2) + shot.id,
          });
        } else {
          ctx.fillStyle = 'rgba(255,150,60,0.95)';
          ctx.beginPath();
          ctx.arc(shot.x, shot.y - 10, shot.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (shot.kind === 'railgun') {
        // The original's rail: a two-pixel violet line at three-quarter alpha.
        const fade = Math.max(0, Math.min(1, shot.life / EFFECT_TICKS.tracer));
        ctx.strokeStyle = `rgba(153,102,255,${0.56 * fade})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(shot.prevX, shot.prevY - 10);
        ctx.lineTo(shot.x, shot.y - 10);
        ctx.stroke();
      } else if (shot.kind === 'grenade' && grenade) {
        // A lobbed grenade rises off its ground shadow by its height.
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.ellipse(shot.x, shot.y, 5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
        drawSprite(ctx, grenade, shot.x, shot.y - 4 - shot.z, {
          scale: 1.4,
          rotation: shot.angle + this.world.tick * 0.2,
        });
      } else if (shot.kind === 'rocket') {
        // The original's rocket is a shimmering white cluster, its three-frame
        // clip cycled a frame a tick and never rotated.
        if (rocketArt) {
          drawSprite(ctx, rocketArt, shot.x, shot.y - 10, {
            frame: Math.floor(this.world.tick / 2) + shot.id,
          });
        } else {
          ctx.save();
          ctx.translate(shot.x, shot.y - 10);
          ctx.rotate(shot.angle);
          ctx.fillStyle = '#d8d2c4';
          ctx.fillRect(-5, -2.5, 10, 5);
          ctx.fillStyle = '#b0342a';
          ctx.fillRect(3, -2.5, 2, 5);
          ctx.restore();
        }
      } else {
        // A bullet's tracer: the original's hairline grey at three-quarter
        // alpha, gone after two of its ticks.
        const fade = Math.max(0, Math.min(1, shot.life / EFFECT_TICKS.tracer));
        ctx.strokeStyle = `rgba(204,204,204,${0.75 * fade})`;
        ctx.lineWidth = 1;
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
    this.zoom = camera.zoom;
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
    this.drawPlacementOutline(ctx);

    this.items.length = 0;
    this.queueArena(camera);
    this.queueObjects();
    for (const player of world.players) {
      // An empty seat on a server is a player nobody is driving; leave it out.
      if (!player.connected) continue;
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
    if (world.hurt > 0) this.drawHurtVignette(ctx, world.hurt);
    this.ctx = null;
  }

  /** Red closing in from the edges: taking damage has to be felt, not read. */
  private drawHurtVignette(ctx: CanvasRenderingContext2D, strength: number): void {
    const { width, height } = ctx.canvas;
    const gradient = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.35,
      width / 2, height / 2, Math.max(width, height) * 0.72,
    );
    gradient.addColorStop(0, 'rgba(150,0,0,0)');
    gradient.addColorStop(1, `rgba(150,0,0,${Math.min(0.75, strength * 0.7)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
}
