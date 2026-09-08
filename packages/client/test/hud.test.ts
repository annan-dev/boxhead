/**
 * HUD layout rules that must hold at every window size: a full arsenal fits
 * the weapon strip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hud } from '../src/ui/Hud.js';

const scale = (height: number): number => Math.max(1, Math.min(2, height / 620));

for (const [width, height] of [[1280, 720], [1920, 1080], [800, 450], [2560, 1440]] as const) {
  test(`a full strip at ${width}x${height} fits the window`, () => {
    const s = scale(height);
    const strip = Hud.layoutStrip(width, s, 10);
    assert.ok(strip.left >= 0 && strip.left + strip.width <= width, 'the strip runs off screen');
    assert.ok(strip.slotWidth >= 30 * s, 'slots collapsed below the floor');
  });
}

test('the heartbeat is a lub and a dub, faster as life falls, and silent above 30%', () => {
  const peaks = (ratio: number, period: number): number[] => {
    const out: number[] = [];
    let prev = 0;
    let rising = false;
    for (let t = 0; t <= period; t++) {
      const v = Hud.heartbeatAt(t, ratio);
      if (v > prev) rising = true;
      else if (rising && v < prev) {
        out.push(t - 1);
        rising = false;
      }
      prev = v;
    }
    return out;
  };
  assert.equal(Hud.heartbeatAt(10, 0.5), 0, 'no beat above 30%');
  assert.equal(peaks(0.3, 60).length, 2, 'two beats a period at 30%');
  assert.equal(peaks(0, 35).length, 2, 'two beats a period at none');
  assert.ok(Hud.heartbeatAt(4, 0.2) > Hud.heartbeatAt(19, 0.2), 'the dub is softer than the lub');
  assert.ok(Hud.heartbeatAt(4, 0.2) > 0.9);
});
