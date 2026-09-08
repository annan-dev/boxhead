/**
 * The title screen's key art, painted from the game's own assets.
 *
 * A lone SWAT stands at the bottom left with the shotgun up, muzzle lit,
 * while a horde of zombies and a couple of devils bear down on him across a
 * real arena floor strewn with blood, scorch marks and barrels. Everything is
 * the actual in-game art -- the vector rigs, the floor plates, the effect
 * symbols -- composed at poster scale, then graded with fog, a warm muzzle
 * light and a vignette. It is drawn once per size on a full-screen canvas;
 * the menus sit on top of it.
 */
import type { ArtPack, ExtractedRoom, SpriteArt } from '@boxhead/shared';
import { drawComposed, directionFor, frameFor, type Palette, type TextureSwap } from '../render/VectorModel.js';
import { ClipIndex, composePose, type Layer } from '../render/Rig.js';
import { drawLayers, drawSprite } from '../render/SpriteRenderer.js';
import { CHARACTER_PALETTES } from '../render/HeadArt.js';

/** The composition is laid out in this space and cover-fitted to the screen. */
const W = 1920;
const H = 1080;
/** Where the hero stands and where his shot goes. */
const HERO = { x: 1130, y: 850 };
const AIM = { x: 1620, y: 430 };

/** A small deterministic generator, so the scene is the same every visit. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Figure {
  x: number;
  y: number;
  scale: number;
  kind: 'zombie' | 'devil' | 'hero';
  step: number;
}

export class TitleArt {
  private readonly clips: ClipIndex;
  private readonly swaps = new Map<string, TextureSwap>();

  constructor(
    private readonly pack: ArtPack,
    private readonly rooms: ExtractedRoom[],
  ) {
    this.clips = new ClipIndex(pack.clips);
  }

  /** Size the canvas to the window and paint the scene into it. */
  draw(canvas: HTMLCanvasElement): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, window.innerWidth);
    const ch = Math.max(1, window.innerHeight);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = Math.max(cw / W, ch / H) * dpr;
    ctx.setTransform(s, 0, 0, s, (cw * dpr - W * s) / 2, (ch * dpr - H * s) / 2);
    this.paint(ctx);
  }

  private sprite(name: string): SpriteArt | undefined {
    return this.pack.sprites[name];
  }

  private swapFor(prefix: string): TextureSwap {
    const cached = this.swaps.get(prefix);
    if (cached) return cached;
    const swap: TextureSwap = {};
    for (const piece of ['Body', 'Head'] as const) {
      for (const facing of ['Front', 'Back', 'Side', 'Top'] as const) {
        const specific = `${prefix}_${piece}_${facing}`;
        if (this.pack.textures[specific]) swap[`${piece}_${facing}_MC`] = specific;
      }
    }
    this.swaps.set(prefix, swap);
    return swap;
  }

  private paint(ctx: CanvasRenderingContext2D): void {
    const random = rng(0xb0c5ead);
    ctx.fillStyle = '#08080b';
    ctx.fillRect(-W, -H, W * 3, H * 3);

    this.paintFloor(ctx);

    // A warm pool of light on the ground around the hero, before anything
    // stands in it, so the figures near him are lit from below.
    const pool = ctx.createRadialGradient(HERO.x + 140, HERO.y - 60, 40, HERO.x + 140, HERO.y - 60, 620);
    pool.addColorStop(0, 'rgba(255,150,80,0.30)');
    pool.addColorStop(1, 'rgba(255,150,80,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, W, H);

    this.paintDecals(ctx, random);
    this.paintBarrels(ctx);

    const figures = this.layoutHorde(random);
    figures.push({ x: HERO.x, y: HERO.y, scale: 2.05, kind: 'hero', step: 0 });
    figures.sort((a, b) => a.y - b.y);
    for (const figure of figures) this.paintFigure(ctx, figure);

    this.paintMuzzle(ctx);
    this.paintAtmosphere(ctx, random);
  }

  /** A real arena floor, scaled past the frame and pushed into the dark. */
  private paintFloor(ctx: CanvasRenderingContext2D): void {
    const room = this.rooms.find((r) => r.floor.layers.length > 0 && r.width > 900) ?? this.rooms[0];
    if (!room || room.floor.layers.length === 0) {
      ctx.fillStyle = '#4a4238';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    const f = Math.max(W / room.width, H / room.height) * 1.35;
    ctx.save();
    ctx.translate((W - room.width * f) / 2 - 140, (H - room.height * f) / 2 + 60);
    ctx.scale(f, f);
    drawLayers(ctx, room.floor.layers);
    ctx.restore();
    // Night: the floor is barely there, a cold wash over warm stone.
    ctx.fillStyle = 'rgba(8,8,14,0.70)';
    ctx.fillRect(0, 0, W, H);
  }

  private paintDecals(ctx: CanvasRenderingContext2D, random: () => number): void {
    const scorch = this.sprite('Effect.ScorchMark');
    const pool = this.sprite('Effect.BloodPool');
    const splat = this.sprite('Effect.BloodSplat');
    if (scorch) {
      for (const [x, y, s] of [[1420, 640, 2.6], [1700, 330, 2.0], [1150, 330, 1.8], [900, 700, 1.9]] as const) {
        drawSprite(ctx, scorch, x, y, { scale: s, alpha: 0.85, rotation: random() * Math.PI * 2 });
      }
    }
    for (let i = 0; i < 26; i++) {
      const art = random() < 0.55 ? pool : splat;
      if (!art) continue;
      const x = 760 + random() * 1150;
      const y = 240 + random() * 800;
      drawSprite(ctx, art, x, y, { scale: 0.7 + random() * 0.9, alpha: 0.8, rotation: random() * Math.PI * 2 });
    }
  }

  private paintBarrels(ctx: CanvasRenderingContext2D): void {
    const barrel = this.sprite('Object.Barrel');
    if (!barrel) return;
    for (const [x, y, s] of [[820, 960, 2.4], [1760, 940, 2.8], [1560, 230, 1.9]] as const) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(x, y + 4, 26 * s, 12 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      drawSprite(ctx, barrel, x, y, { scale: s });
    }
  }

  /** The horde: dense at the back, spreading and growing toward the hero. */
  private layoutHorde(random: () => number): Figure[] {
    const figures: Figure[] = [];
    const rows = 7;
    for (let row = 0; row < rows; row++) {
      const t = row / (rows - 1);
      const y = 150 + t * 760;
      const count = Math.round(10 - t * 4);
      const left = 1000 - t * 160;
      const right = 1960;
      for (let i = 0; i < count; i++) {
        const x = left + ((i + 0.5) / count) * (right - left) + (random() - 0.5) * 120;
        const jitterY = (random() - 0.5) * 90;
        // Nobody stands in the shot's path or on the hero.
        if (Math.hypot(x - HERO.x, y + jitterY - HERO.y) < 260) continue;
        figures.push({
          x,
          y: y + jitterY,
          scale: 0.85 + t * 1.0 + random() * 0.12,
          kind: random() < 0.06 ? 'devil' : 'zombie',
          step: Math.floor(random() * 8),
        });
      }
    }
    // Two devils for certain, one looming at the back right, one mid-field.
    figures.push({ x: 1720, y: 300, scale: 1.25, kind: 'devil', step: 2 });
    figures.push({ x: 1480, y: 700, scale: 1.75, kind: 'devil', step: 4 });
    return figures;
  }

  private paintFigure(ctx: CanvasRenderingContext2D, figure: Figure): void {
    const angle =
      figure.kind === 'hero'
        ? Math.atan2(AIM.y - figure.y, AIM.x - figure.x)
        : Math.atan2(HERO.y - figure.y, HERO.x - figure.x);
    const layers: Layer[] = [];
    let swap: TextureSwap;
    let palette: Palette | undefined;
    let outlines = true;
    if (figure.kind === 'hero') {
      this.addLayer(layers, 'Player', 'Stand', angle, figure.step);
      this.addLayer(layers, 'Player_Shotgun', 'Stand', angle, figure.step);
      swap = this.swapFor('Swat');
      palette = CHARACTER_PALETTES['swat'];
    } else if (figure.kind === 'devil') {
      this.addLayer(layers, 'Player', 'Walk', angle, figure.step);
      this.addLayer(layers, 'Devil', 'Walk', angle, figure.step);
      swap = this.swapFor('Devil');
    } else {
      this.addLayer(layers, 'Player', 'Zombie_Walk', angle, figure.step);
      this.addLayer(layers, 'Zombie', 'Zombie_Walk', angle, figure.step);
      swap = this.swapFor('Zombie');
      outlines = figure.scale > 1.2;
    }
    if (layers.length === 0) return;
    const composed = composePose(layers);

    // Ground shadow, then the figure.
    ctx.save();
    ctx.translate(figure.x, figure.y);
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, 2, 14 * figure.scale, 6.5 * figure.scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // The back of the horde fades into the dark.
    if (figure.kind !== 'hero') ctx.globalAlpha = Math.min(1, 0.45 + figure.scale * 0.35);
    drawComposed(ctx, composed.parts, {
      scale: figure.scale,
      outlines,
      art: { textures: this.pack.textures, swap },
      ...(palette ? { palette } : {}),
    });
    ctx.restore();

    if (figure.kind === 'hero' && composed.muzzle) {
      this.muzzle = { x: figure.x + composed.muzzle.x * figure.scale, y: figure.y + composed.muzzle.y * figure.scale, angle };
    }
  }

  private muzzle: { x: number; y: number; angle: number } | null = null;

  private addLayer(layers: Layer[], group: string, anim: string, angle: number, step: number): void {
    const clip = this.clips.get(group, anim);
    if (!clip) return;
    layers.push({ clip, direction: directionFor(clip, angle), frame: frameFor(clip, step) });
  }

  /** The shot: flash at the muzzle, a hot tracer, and light thrown on the nearest zombies. */
  private paintMuzzle(ctx: CanvasRenderingContext2D): void {
    const m = this.muzzle ?? { x: HERO.x + 60, y: HERO.y - 70, angle: Math.atan2(AIM.y - HERO.y, AIM.x - HERO.x) };
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(m.x, m.y, 10, m.x, m.y, 520);
    glow.addColorStop(0, 'rgba(255,200,120,0.55)');
    glow.addColorStop(0.25, 'rgba(255,130,60,0.22)');
    glow.addColorStop(1, 'rgba(255,90,40,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // Tracer.
    const length = 760;
    const ex = m.x + Math.cos(m.angle) * length;
    const ey = m.y + Math.sin(m.angle) * length;
    const line = ctx.createLinearGradient(m.x, m.y, ex, ey);
    line.addColorStop(0, 'rgba(255,230,170,0.95)');
    line.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.strokeStyle = line;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.restore();
    const flash = this.sprite('Shotgun.MuzzleFlash');
    if (flash) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      drawSprite(ctx, flash, m.x, m.y, { scale: 2.4, rotation: m.angle, alpha: 0.95 });
      ctx.restore();
    }
  }

  private paintAtmosphere(ctx: CanvasRenderingContext2D, random: () => number): void {
    // Smoke drifting over the far end of the field.
    const smoke = this.sprite('Effect.SmokeCloud');
    if (smoke) {
      ctx.save();
      for (let i = 0; i < 7; i++) {
        drawSprite(ctx, smoke, 900 + random() * 1000, 120 + random() * 360, {
          scale: 3.5 + random() * 3,
          alpha: 0.16 + random() * 0.12,
          rotation: random() * Math.PI * 2,
        });
      }
      ctx.restore();
    }
    // Depth fog from the top, a floor haze at the bottom.
    const fog = ctx.createLinearGradient(0, 0, 0, H);
    fog.addColorStop(0, 'rgba(7,7,11,0.82)');
    fog.addColorStop(0.42, 'rgba(7,7,11,0.08)');
    fog.addColorStop(0.9, 'rgba(7,7,11,0.10)');
    fog.addColorStop(1, 'rgba(7,7,11,0.70)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, W, H);
    // Blood-red glow low on the hero's side, cold vignette everywhere else.
    const ember = ctx.createRadialGradient(HERO.x - 200, H, 60, HERO.x - 200, H, 900);
    ember.addColorStop(0, 'rgba(224,17,31,0.30)');
    ember.addColorStop(1, 'rgba(224,17,31,0)');
    ctx.fillStyle = ember;
    ctx.fillRect(0, 0, W, H);
    const vignette = ctx.createRadialGradient(W * 0.5, H * 0.5, H * 0.35, W * 0.5, H * 0.5, H * 1.05);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.88)');
    ctx.fillStyle = vignette;
    ctx.fillRect(-W, -H, W * 3, H * 3);
  }
}
