/**
 * Development-only art gallery: renders every extracted world symbol so the
 * shapes, colours and animation frames can be checked at a glance.
 *
 * Reached at /#gallery. Excluded from production builds.
 */
import type { ArtPack, SpriteArt } from '@boxhead/shared';
import { drawSprite, spriteBounds } from '../render/SpriteRenderer.js';

export function mountGallery(root: HTMLElement, pack: ArtPack): void {
  const names = Object.keys(pack.sprites).sort();
  root.innerHTML = `
    <style>
      body { margin: 0; background: #14161a; color: #dfe3e8;
             font: 12px ui-monospace, Menlo, Consolas, monospace; }
      .bar { padding: 12px 16px; border-bottom: 1px solid #2a2f36;
             display: flex; gap: 18px; align-items: center; }
      .bar h1 { font-size: 12px; margin: 0; letter-spacing: .12em;
                text-transform: uppercase; color: #8b939e; }
      .bar label { color: #7d858f; }
      .grid { display: grid; gap: 10px; padding: 16px;
              grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
      .cell { background: #1b1e23; border: 1px solid #272c33; border-radius: 5px;
              padding: 8px; }
      .cell canvas { display: block; width: 100%; height: 130px;
                     background: #22262c; border-radius: 3px; }
      .cell .name { margin-top: 6px; color: #cdd4dd; word-break: break-all; }
      .cell .meta { color: #6f7883; }
    </style>
    <div class="bar">
      <h1>World art &mdash; ${names.length} symbols</h1>
      <label><input type="checkbox" id="animate" checked> animate</label>
      <label><input type="checkbox" id="light"> light background</label>
      <label>zoom <input type="range" id="zoom" min="20" max="300" value="100"></label>
    </div>
    <div class="grid" id="grid"></div>
  `;

  const grid = root.querySelector<HTMLDivElement>('#grid')!;
  const animate = root.querySelector<HTMLInputElement>('#animate')!;
  const light = root.querySelector<HTMLInputElement>('#light')!;
  const zoomInput = root.querySelector<HTMLInputElement>('#zoom')!;

  const cells: Array<{ ctx: CanvasRenderingContext2D; sprite: SpriteArt }> = [];
  for (const name of names) {
    const sprite = pack.sprites[name]!;
    const bounds = spriteBounds(sprite);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `
      <canvas></canvas>
      <div class="name">${name}</div>
      <div class="meta">${sprite.frames.length}f &middot; ${Math.round(bounds.w)}x${Math.round(bounds.h)}px</div>
    `;
    grid.append(cell);
    const canvas = cell.querySelector('canvas')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr) || 300;
    canvas.height = Math.round(130 * dpr);
    cells.push({ ctx: canvas.getContext('2d')!, sprite });
  }

  let step = 0;
  let last = 0;
  function frame(now: number): void {
    requestAnimationFrame(frame);
    if (animate.checked && now - last > 90) {
      step += 1;
      last = now;
    }
    const zoom = Number(zoomInput.value) / 100;
    const background = light.checked ? '#c9ccd1' : '#22262c';

    for (const { ctx, sprite } of cells) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

      const bounds = spriteBounds(sprite);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Fit the art to the cell, then apply the user's zoom on top.
      const fit = Math.min(
        (ctx.canvas.width * 0.8) / Math.max(bounds.w, 1),
        (ctx.canvas.height * 0.8) / Math.max(bounds.h, 1),
      );
      const scale = fit * zoom;

      // Mark the symbol origin, which is what positioning code aligns to.
      const cx = ctx.canvas.width / 2 - (bounds.x + bounds.w / 2) * scale;
      const cy = ctx.canvas.height / 2 - (bounds.y + bounds.h / 2) * scale;
      ctx.strokeStyle = 'rgba(255,90,90,0.5)';
      ctx.beginPath();
      ctx.moveTo(cx - 6 * dpr, cy);
      ctx.lineTo(cx + 6 * dpr, cy);
      ctx.moveTo(cx, cy - 6 * dpr);
      ctx.lineTo(cx, cy + 6 * dpr);
      ctx.stroke();

      drawSprite(ctx, sprite, cx, cy, { scale, frame: step });
    }
  }
  requestAnimationFrame(frame);
}
