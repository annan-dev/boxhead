/**
 * Head portraits for the squad bars: each character drawn once with the real
 * rig, facing the camera, then cropped to the head and cached at the size
 * the HUD asks for, so the bar shows the face the arena shows.
 */
import { CHARACTERS, type ArtPack } from '@boxhead/shared';
import { drawComposed, type TextureSwap } from '../render/VectorModel.js';
import { ClipIndex, composePose, type Layer } from '../render/Rig.js';
import { CHARACTER_PALETTES } from '../render/HeadArt.js';

export class Portraits {
  private readonly clips: ClipIndex;
  private readonly cache = new Map<string, HTMLCanvasElement | null>();

  constructor(private readonly pack: ArtPack) {
    this.clips = new ClipIndex(pack.clips);
  }

  /** The character's head, `size` pixels square, or null when the rig lacks it. */
  headOf(characterId: string, size: number): HTMLCanvasElement | null {
    const key = `${characterId}@${size}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const canvas = this.render(characterId, size);
    this.cache.set(key, canvas);
    return canvas;
  }

  private render(characterId: string, size: number): HTMLCanvasElement | null {
    const character = CHARACTERS.find((c) => c.id === characterId);
    const base = this.clips.get('Player', 'Stand');
    if (!base) return null;
    // Facing south, straight at the camera.
    const direction = Math.round(base.directions * 0.6875) % base.directions;
    const layers: Layer[] = [{ clip: base, direction, frame: 0 }];
    const head = character?.headGroup ? this.clips.get(character.headGroup, 'Stand') : null;
    if (head) layers.push({ clip: head, direction: direction % head.directions, frame: 0 });
    const swap: TextureSwap = {};
    for (const piece of ['Body', 'Head'] as const) {
      for (const facing of ['Front', 'Back', 'Side', 'Top'] as const) {
        const specific = `${character?.skin ?? 'Swat'}_${piece}_${facing}`;
        if (this.pack.textures[specific]) swap[`${piece}_${facing}_MC`] = specific;
      }
    }
    const composed = composePose(layers);

    // Draw the whole figure on a scratch canvas about its own origin, find
    // where the ink is, and take its top part: the head is the top of any
    // standing pose. The rig's units are large; a scale of one fills a
    // fair part of the canvas already.
    const scratch = document.createElement('canvas');
    const big = 320;
    scratch.width = big;
    scratch.height = big;
    const sctx = scratch.getContext('2d');
    if (!sctx) return null;
    sctx.save();
    sctx.translate(big / 2, big / 2);
    const palette = CHARACTER_PALETTES[characterId];
    drawComposed(sctx, composed.parts, {
      scale: 1,
      art: { textures: this.pack.textures, swap },
      ...(palette ? { palette } : {}),
    });
    sctx.restore();
    const data = sctx.getImageData(0, 0, big, big).data;
    let top = big;
    let bottom = 0;
    let left = big;
    let right = 0;
    for (let y = 0; y < big; y++) {
      for (let x = 0; x < big; x++) {
        if (data[(y * big + x) * 4 + 3]! < 40) continue;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (bottom <= top || right <= left) return null;
    // The head is roughly the top two fifths of the figure.
    const headH = (bottom - top) * 0.42;
    const headW = Math.min(right - left, headH * 1.1);
    const cx = (left + right) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const box = Math.max(headW, headH) * 1.12;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, cx - box / 2, top - box * 0.06, box, box, 0, 0, size, size);
    return canvas;
  }
}
