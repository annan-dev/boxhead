/**
 * HUD layout rules that must hold at every window size: the corner panels
 * stay inside the window and never overlap one another.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hud } from '../src/ui/Hud.js';

const scale = (height: number): number => Math.max(1, Math.min(2, height / 620));

for (const [width, height] of [[1280, 720], [1920, 1080], [800, 450], [2560, 1440]] as const) {
  test(`the panels at ${width}x${height} fit the window and keep apart`, () => {
    const s = scale(height);
    const lay = Hud.layout(width, height, s);
    const rects = Object.entries(lay);
    for (const [name, r] of rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height, `${name} runs off screen`);
    }
    for (const [a, ra] of rects) {
      for (const [b, rb] of rects) {
        if (a >= b) continue;
        const apart = ra.x + ra.w <= rb.x || rb.x + rb.w <= ra.x || ra.y + ra.h <= rb.y || rb.y + rb.h <= ra.y;
        assert.ok(apart, `${a} overlaps ${b}`);
      }
    }
    // The grenade chip and the two cards leave the squad room to its left.
    assert.ok(lay.grenade.x > lay.squad.x + lay.squad.w + 8 * s, 'the loadout crowds the squad');
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
