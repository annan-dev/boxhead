/**
 * Draws the extracted world art: wall blocks, objects, pickups and effects.
 *
 * These come out of the SWF as vector paths in twips (1/20 px), so everything
 * is scaled by 1/20 to land in world pixels. Paths are converted to Path2D once
 * and cached, because a wall block is redrawn every frame for every visible
 * cell and rebuilding its geometry each time would dominate the frame.
 */
import type { SpriteArt, TextureLayer } from '@boxhead/shared';

/** SWF stores coordinates in twips; 20 of them to the pixel. */
const TWIPS = 20;

interface CachedPath {
  path: Path2D;
  fill: string;
  alpha: number;
}

const cache = new Map<string, CachedPath[][]>();

/** Build (and memoise) the Path2D list for every frame of a symbol. */
function framesOf(sprite: SpriteArt): CachedPath[][] {
  const hit = cache.get(sprite.name);
  if (hit) return hit;

  const built: CachedPath[][] = sprite.frames.map((frame) => {
    const paths: CachedPath[] = [];
    for (const layer of frame.layers) {
      const [a, b, c, d, e, f] = layer.matrix;
      for (const sub of layer.paths) {
        const path = new Path2D();
        for (const cmd of sub.commands) {
          // Fold the layer transform and the twips scale into the geometry, so
          // drawing is a plain fill with no per-frame transform maths.
          const px = (a * cmd.x + c * cmd.y + e) / TWIPS;
          const py = (b * cmd.x + d * cmd.y + f) / TWIPS;
          if (cmd.op === 'M') {
            path.moveTo(px, py);
          } else if (cmd.op === 'L') {
            path.lineTo(px, py);
          } else {
            const cx = (a * cmd.cx + c * cmd.cy + e) / TWIPS;
            const cy = (b * cmd.cx + d * cmd.cy + f) / TWIPS;
            path.quadraticCurveTo(cx, cy, px, py);
          }
        }
        path.closePath();
        paths.push({
          path,
          fill: `#${sub.color.toString(16).padStart(6, '0')}`,
          alpha: sub.alpha,
        });
      }
    }
    return paths;
  });

  cache.set(sprite.name, built);
  return built;
}

export interface SpriteDrawOptions {
  /** Extra scale on top of the twips conversion. */
  scale?: number;
  /** Frame index; wraps, so callers need not clamp. */
  frame?: number;
  alpha?: number;
  /** Rotation in radians, applied about the draw position. */
  rotation?: number;
  /** Tint blended over the art, e.g. a white hit flash. */
  tint?: { color: string; strength: number };
}

/**
 * Draw a symbol with its own origin at (x, y).
 * The caller positions it; `spriteBounds` reports where the art actually sits.
 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteArt,
  x: number,
  y: number,
  options: SpriteDrawOptions = {},
): void {
  const frames = framesOf(sprite);
  if (frames.length === 0) return;
  const index = ((options.frame ?? 0) % frames.length + frames.length) % frames.length;
  const paths = frames[index]!;
  if (paths.length === 0) return;

  const scale = options.scale ?? 1;
  ctx.save();
  ctx.translate(x, y);
  if (options.rotation) ctx.rotate(options.rotation);
  if (scale !== 1) ctx.scale(scale, scale);
  if (options.alpha !== undefined) ctx.globalAlpha = options.alpha;

  for (const entry of paths) {
    ctx.globalAlpha = (options.alpha ?? 1) * entry.alpha;
    ctx.fillStyle = entry.fill;
    ctx.fill(entry.path);
  }

  if (options.tint && options.tint.strength > 0) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.globalAlpha = options.tint.strength;
    ctx.fillStyle = options.tint.color;
    for (const entry of paths) ctx.fill(entry.path);
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Symbol extent in world pixels, relative to its own origin. */
export function spriteBounds(sprite: SpriteArt): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const b = sprite.bounds;
  return {
    x: b.xMin / TWIPS,
    y: b.yMin / TWIPS,
    w: (b.xMax - b.xMin) / TWIPS,
    h: (b.yMax - b.yMin) / TWIPS,
  };
}

/** Number of frames a symbol carries. */
export function spriteFrameCount(sprite: SpriteArt): number {
  return sprite.frames.length;
}

/**
 * Draw a set of already-positioned layers, such as a room's floor art.
 * Coordinates are in twips and are scaled to world pixels here.
 */
export function drawLayers(
  ctx: CanvasRenderingContext2D,
  layers: readonly TextureLayer[],
): void {
  for (const layer of layers) {
    const [a, b, c, d, e, f] = layer.matrix;
    for (const sub of layer.paths) {
      const path = new Path2D();
      for (const cmd of sub.commands) {
        const px = (a * cmd.x + c * cmd.y + e) / TWIPS;
        const py = (b * cmd.x + d * cmd.y + f) / TWIPS;
        if (cmd.op === 'M') {
          path.moveTo(px, py);
        } else if (cmd.op === 'L') {
          path.lineTo(px, py);
        } else {
          const cx = (a * cmd.cx + c * cmd.cy + e) / TWIPS;
          const cy = (b * cmd.cx + d * cmd.cy + f) / TWIPS;
          path.quadraticCurveTo(cx, cy, px, py);
        }
      }
      path.closePath();
      ctx.globalAlpha = sub.alpha;
      ctx.fillStyle = `#${sub.color.toString(16).padStart(6, '0')}`;
      ctx.fill(path);
    }
  }
  ctx.globalAlpha = 1;
}
