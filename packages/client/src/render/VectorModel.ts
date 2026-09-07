/**
 * Draws the extracted vector puppets.
 *
 * Each pose is a back-to-front list of parts; each part is a set of flat
 * polygons carrying a material and a Flash-style brightness. Because the
 * geometry is already projected at the original 45-degree camera tilt, drawing
 * is a straight 2D fill -- no 3D transform is needed at runtime.
 */
import type { Clip, Material, Part, Pose, Texture } from '@boxhead/shared';

/** Per-character material overrides, e.g. recolouring skin or clothing. */
export type Palette = Record<string, number>;

/**
 * Substitutes a material's texture symbol for another, which is how the
 * original dresses one rig as four different characters: the generic
 * `Body_Front_MC` becomes `Swat_Body_Front`, `Zombie_Body_Front`, and so on.
 */
export type TextureSwap = Record<string, string>;

export interface TextureSet {
  textures: Record<string, Texture>;
  swap?: TextureSwap;
}

/** Cache of built Path2D per texture, keyed by symbol name. */
const texturePathCache = new Map<string, Array<{ path: Path2D; fill: string }>>();

function buildTexturePaths(texture: Texture): Array<{ path: Path2D; fill: string }> {
  const cached = texturePathCache.get(texture.name);
  if (cached) return cached;

  const built: Array<{ path: Path2D; fill: string }> = [];
  for (const layer of texture.layers) {
    const [a, b, c, d, e, f] = layer.matrix;
    for (const sub of layer.paths) {
      const path = new Path2D();
      for (const cmd of sub.commands) {
        const tx = (x: number, y: number): [number, number] => [
          a * x + c * y + e,
          b * x + d * y + f,
        ];
        if (cmd.op === 'M') {
          const [x, y] = tx(cmd.x, cmd.y);
          path.moveTo(x, y);
        } else if (cmd.op === 'L') {
          const [x, y] = tx(cmd.x, cmd.y);
          path.lineTo(x, y);
        } else {
          const [cx, cy] = tx(cmd.cx, cmd.cy);
          const [x, y] = tx(cmd.x, cmd.y);
          path.quadraticCurveTo(cx, cy, x, y);
        }
      }
      path.closePath();
      const hex = sub.color.toString(16).padStart(6, '0');
      built.push({ path, fill: `#${hex}` });
    }
  }
  texturePathCache.set(texture.name, built);
  return built;
}

export interface DrawOptions {
  scale?: number;
  /** Draw the ambient-occlusion polygons. */
  shadows?: boolean;
  /** Stroke the silhouette. */
  outlines?: boolean;
  palette?: Palette;
  /** Fill colour for faces whose material names a texture we could not resolve. */
  clipFallback?: number;
  /** Face textures, plus any per-character substitutions. */
  art?: TextureSet;
}

/** Texture symbols span a 64px square, which SWF stores as 1280 twips. */
const TEXTURE_SPAN = 1280;

/**
 * Paint a texture into a face quad.
 *
 * The face is a projected box side, so the texture's square is mapped onto it
 * by an affine built from three of its corners -- exact for a parallelogram,
 * and clipped to the true polygon either way.
 */
function drawTexturedFace(
  ctx: CanvasRenderingContext2D,
  poly: number[],
  texture: Texture,
  brightness: number,
  scale: number,
): void {
  const x0 = poly[0]!;
  const y0 = poly[1]!;
  const x1 = poly[2]!;
  const y1 = poly[3]!;
  const xn = poly[poly.length - 2]!;
  const yn = poly[poly.length - 1]!;

  ctx.save();
  ctx.beginPath();
  tracePolygon(ctx, poly, scale);
  ctx.clip();

  ctx.transform(
    ((x1 - x0) / TEXTURE_SPAN) * scale,
    ((y1 - y0) / TEXTURE_SPAN) * scale,
    ((xn - x0) / TEXTURE_SPAN) * scale,
    ((yn - y0) / TEXTURE_SPAN) * scale,
    x0 * scale,
    y0 * scale,
  );

  for (const entry of buildTexturePaths(texture)) {
    ctx.fillStyle = entry.fill;
    ctx.fill(entry.path);
  }
  ctx.restore();

  // Re-apply the face's shading, which a flat fill gets for free.
  if (brightness !== 0) {
    ctx.save();
    ctx.beginPath();
    tracePolygon(ctx, poly, scale);
    ctx.clip();
    ctx.fillStyle = brightness > 0 ? '#ffffff' : '#000000';
    ctx.globalAlpha = Math.min(Math.abs(brightness), 1);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/**
 * Flash's brightness control: positive values blend toward white, negative
 * toward black, which is what `Shape_Brightness` encodes.
 */
function shade(color: number, brightness: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  let out: [number, number, number];
  if (brightness >= 0) {
    const t = Math.min(brightness, 1);
    out = [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t];
  } else {
    const t = Math.max(1 + brightness, 0);
    out = [r * t, g * t, b * t];
  }
  return `rgb(${out[0] | 0},${out[1] | 0},${out[2] | 0})`;
}

function tracePolygon(ctx: CanvasRenderingContext2D, poly: number[], scale: number): void {
  if (poly.length < 6) return;
  ctx.moveTo(poly[0]! * scale, poly[1]! * scale);
  for (let i = 2; i < poly.length - 1; i += 2) {
    ctx.lineTo(poly[i]! * scale, poly[i + 1]! * scale);
  }
  ctx.closePath();
}

/**
 * Resolve a material's texture symbol, applying the character substitution
 * first (Body_Front_MC -> Swat_Body_Front) and falling back to the generic
 * symbol when a character has no art of its own for that face.
 */
function resolveTexture(art: TextureSet, symbol: string): Texture | undefined {
  const swapped = art.swap?.[symbol];
  if (swapped) {
    const hit = art.textures[swapped];
    if (hit) return hit;
  }
  return art.textures[symbol];
}

/** Resolve a face's fill, honouring any palette override for that material. */
function resolveFill(
  clip: Clip,
  materialIndex: number,
  brightness: number,
  palette: Palette | undefined,
  clipFallback: number,
): { fill: string; alpha: number } {
  const name = clip.materialNames[materialIndex];
  const material: Material | undefined = clip.materials[materialIndex];
  const override = name !== undefined ? palette?.[name] : undefined;
  const base = override ?? material?.color ?? (material?.clip !== undefined ? clipFallback : 0x808080);
  return { fill: shade(base, brightness), alpha: material?.alpha ?? 1 };
}

interface ResolvedOptions {
  scale: number;
  shadows: boolean;
  outlines: boolean;
  clipFallback: number;
  palette: Palette | undefined;
  art: TextureSet | undefined;
}

function resolveOptions(options: DrawOptions): ResolvedOptions {
  return {
    scale: options.scale ?? 1,
    shadows: options.shadows ?? true,
    outlines: options.outlines ?? true,
    clipFallback: options.clipFallback ?? 0x9aa0a6,
    palette: options.palette,
    art: options.art,
  };
}

/**
 * Draw one part. Exported so composed characters, whose parts come from several
 * clips, can be drawn without flattening their materials first.
 */
export function drawPart(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  part: Part,
  opts: ResolvedOptions,
): void {
  const { scale, palette, clipFallback, art } = opts;

  // Faces sharing a flat fill are batched into one path, so a whole character
  // is a handful of fills rather than one per polygon. Textured faces carry
  // printed detail and are drawn individually.
  let runStart = 0;
  while (runStart < part.faces.length) {
    const first = part.faces[runStart]!;
    const symbol = clip.materials[first.mat]?.clip;
    const texture = symbol !== undefined && art ? resolveTexture(art, symbol) : undefined;

    if (texture) {
      drawTexturedFace(ctx, first.poly, texture, first.bright, scale);
      runStart += 1;
      continue;
    }

    const { fill, alpha } = resolveFill(clip, first.mat, first.bright, palette, clipFallback);
    let runEnd = runStart + 1;
    while (runEnd < part.faces.length) {
      const next = part.faces[runEnd]!;
      if (next.mat !== first.mat || next.bright !== first.bright) break;
      if (clip.materials[next.mat]?.clip !== undefined && art) break;
      runEnd += 1;
    }
    ctx.beginPath();
    for (let i = runStart; i < runEnd; i++) tracePolygon(ctx, part.faces[i]!.poly, scale);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.fill();
    runStart = runEnd;
  }
  ctx.globalAlpha = 1;

  if (opts.shadows && part.shadow.length > 0) {
    ctx.beginPath();
    for (const poly of part.shadow) tracePolygon(ctx, poly, scale);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill();
  }

  if (opts.outlines && part.outline.length > 0) {
    ctx.beginPath();
    for (const poly of part.outline) tracePolygon(ctx, poly, scale);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(0.6, scale * 1.2);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** Draw one pose at the current transform origin. */
export function drawPose(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  pose: Pose,
  options: DrawOptions = {},
): void {
  const opts = resolveOptions(options);
  for (const part of pose.parts) drawPart(ctx, clip, part, opts);
}

/** Draw a character assembled from several clips (see Rig.composePose). */
export function drawComposed(
  ctx: CanvasRenderingContext2D,
  parts: ReadonlyArray<{ part: Part; clip: Clip }>,
  options: DrawOptions = {},
): void {
  const opts = resolveOptions(options);
  for (const entry of parts) drawPart(ctx, entry.clip, entry.part, opts);
}

/** Look up a pose, wrapping direction and frame indices. */
export function getPose(clip: Clip, direction: number, frame: number): Pose | null {
  if (clip.directions === 0) return null;
  const d = ((direction % clip.directions) + clip.directions) % clip.directions;
  const frames = clip.poses[d];
  if (!frames || frames.length === 0) return null;
  const f = ((frame % frames.length) + frames.length) % frames.length;
  return frames[f] ?? null;
}

/**
 * Map a facing angle (radians, 0 = +x, growing clockwise on screen) to the
 * clip's direction index. Direction k faces (k + 1) steps past west, so the
 * nearest frame is one index back from the rounded step; see
 * GameRenderer.directionIndex, which this mirrors.
 */
export function directionFor(clip: Clip, angle: number): number {
  if (clip.directions === 0) return 0;
  const turns = angle / (Math.PI * 2) + 0.5;
  const nearest = Math.round(turns * clip.directions) - 1;
  return ((nearest % clip.directions) + clip.directions) % clip.directions;
}

/** Resolve a playback step through `sequence` when the clip defines one. */
export function frameFor(clip: Clip, step: number): number {
  if (!clip.sequence || clip.sequence.length === 0) return step % Math.max(clip.frames, 1);
  const idx = ((step % clip.sequence.length) + clip.sequence.length) % clip.sequence.length;
  return clip.sequence[idx] ?? 0;
}

/** Bounding box of a pose in model units, for centring and sizing. */
export function poseBounds(pose: Pose): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (poly: number[]): void => {
    for (let i = 0; i < poly.length - 1; i += 2) {
      const x = poly[i]!;
      const y = poly[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  };
  for (const part of pose.parts) {
    for (const face of part.faces) consider(face.poly);
    for (const poly of part.outline) consider(poly);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
