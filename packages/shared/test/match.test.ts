/**
 * A match config's practice start reaches the world, on either end, and a
 * bad one is ignored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS } from '../src/data/rooms.js';
import { DEFAULT_MATCH_CONFIG, matchWorld, multiplierForStart, practiceStart, worldFromConfig } from '../src/net/Match.js';

const room = ROOMS[0]!;
const config = (extra: Partial<Parameters<typeof worldFromConfig>[1]>) => ({
  ...DEFAULT_MATCH_CONFIG,
  roomId: room.id,
  seed: 7,
  ...extra,
});

test('a practice start in the match config opens the world there with the curve’s multiplier', () => {
  const world = worldFromConfig(room, config({ difficulty: 'beginner', startLevel: 15 }), 2);
  assert.equal(world.level, 15);
  assert.equal(world.awardsBankedUpTo, multiplierForStart(15));
});

test('a practice start out of range is the preset', () => {
  assert.equal(practiceStart({ startLevel: 1 }), 0);
  assert.equal(practiceStart({ startLevel: 99 }), 0);
  assert.equal(practiceStart({ startLevel: Number.NaN }), 0);
  assert.equal(practiceStart({}), 0);
  const world = worldFromConfig(room, config({ difficulty: 'expert', startLevel: 99 }), 2);
  assert.equal(world.level, 20);
});

test('a match world announces the wave it opens on, unless it is the first', () => {
  const late = matchWorld(room, config({ difficulty: 'expert' }), 2);
  assert.ok(late.messages.some((m) => m.kind === 'level' && m.text.includes('20')), 'no opening banner');
  const first = matchWorld(room, config({ difficulty: 'beginner' }), 2);
  assert.equal(first.messages.length, 0);
  const versus = matchWorld(room, config({ mode: 'deathmatch' }), 2);
  assert.equal(versus.messages.filter((m) => m.kind === 'level').length, 0, 'a deathmatch has no wave to announce');
});
