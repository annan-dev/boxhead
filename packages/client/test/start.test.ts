/**
 * A custom start banks the multiplier the presets' curve says it should.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiplierForStart } from '../src/session/LocalSession.js';

test("a custom start level sits on the presets' multiplier curve", () => {
  assert.equal(multiplierForStart(1), 1);
  assert.equal(multiplierForStart(10), 10);
  assert.equal(multiplierForStart(15), 20);
  assert.equal(multiplierForStart(20), 30);
  assert.equal(multiplierForStart(35), 50);
  assert.ok(multiplierForStart(45) > 50, 'past the last preset the curve keeps climbing');
  assert.ok(multiplierForStart(5) > 1 && multiplierForStart(5) < 10);
});
