/**
 * HUD layout rules that must hold at every window size: two seats' weapon
 * strips never cross, and a full arsenal fits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hud } from '../src/ui/Hud.js';

const scale = (height: number): number => Math.max(1, Math.min(2, height / 620));

for (const [width, height] of [[1280, 720], [1920, 1080], [800, 450], [2560, 1440]] as const) {
  test(`two full strips at ${width}x${height} fit their halves and do not cross`, () => {
    const s = scale(height);
    const left = Hud.layoutStrip(width, s, 10, -1);
    const right = Hud.layoutStrip(width, s, 10, 1);
    assert.ok(left.left >= 0, `left strip starts off screen at ${left.left}`);
    assert.ok(right.left + right.width <= width, 'right strip runs off screen');
    assert.ok(left.left + left.width < right.left, 'the two strips overlap');
    assert.ok(left.slotWidth >= 30 * s, 'slots collapsed below the floor');
  });

  test(`one full strip at ${width}x${height} fits the window`, () => {
    const s = scale(height);
    const strip = Hud.layoutStrip(width, s, 10, 0);
    assert.ok(strip.left >= 0 && strip.left + strip.width <= width, 'a single strip runs off screen');
  });
}
