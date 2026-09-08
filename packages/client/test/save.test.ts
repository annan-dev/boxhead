/**
 * The save file's rules, which run the same in Node: no localStorage means
 * defaults and no persistence, and nothing else changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaveData } from '../src/state/SaveData.js';

test('a best on one difficulty leaves the others alone', () => {
  const save = new SaveData();
  save.recordRun('r1', 0, { score: 1000, level: 4, kills: 10, startLevel: 1, difficulty: 'beginner' }, true, 18);
  const nightmare = save.recordRun(
    'r1',
    0,
    { score: 900, level: 35, kills: 3, startLevel: 35, difficulty: 'nightmare' },
    true,
    18,
  );
  assert.equal(nightmare.isBest, true, 'a first nightmare run is its own best');
  assert.equal(nightmare.unlockedNext, false, 'dying at the start level unlocks nothing');
  assert.equal(save.bestAt('r1', 'beginner').score, 1000);
  assert.equal(save.bestAt('r1', 'nightmare').score, 900);
  assert.equal(save.recordFor('r1').score, 1000, 'the overall best is still the higher score');
});

test('the next room unlocks after three cleared waves from the preset start', () => {
  const save = new SaveData();
  const early = save.recordRun('r1', 0, { score: 1, level: 22, kills: 1, startLevel: 20, difficulty: 'expert' }, true, 18);
  assert.equal(early.unlockedNext, false);
  const done = save.recordRun('r1', 0, { score: 1, level: 23, kills: 1, startLevel: 20, difficulty: 'expert' }, true, 18);
  assert.equal(done.unlockedNext, true);
  assert.equal(save.isRoomUnlocked(1), true);
});

test('a practice run records nothing', () => {
  const save = new SaveData();
  const outcome = save.recordRun('r1', 0, { score: 5000, level: 9, kills: 50 }, false, 18);
  assert.deepEqual(outcome, { isBest: false, unlockedNext: false });
  assert.equal(save.recordFor('r1').score, 0);
  assert.equal(save.history.length, 0);
});

test('a progress code carries bests and unlocks and merges upward', () => {
  const source = new SaveData();
  source.recordRun('r1', 0, { score: 1000, level: 4, kills: 10, startLevel: 1, difficulty: 'beginner' }, true, 18);
  source.recordRun('r2', 1, { score: 300, level: 2, kills: 3, startLevel: 1, difficulty: 'beginner' }, true, 18);
  const code = source.exportCode();
  assert.ok(code.startsWith('BH1.'));

  const target = new SaveData();
  target.recordRun('r1', 0, { score: 1500, level: 3, kills: 4, startLevel: 1, difficulty: 'beginner' }, true, 18);
  assert.equal(target.importCode('nonsense'), false);
  assert.equal(target.importCode(code), true);
  assert.equal(target.recordFor('r1').score, 1500, 'the higher best stays');
  assert.equal(target.recordFor('r1').level, 4, 'the higher level arrives');
  assert.equal(target.recordFor('r2').score, 300, 'a room not played here arrives');
  assert.equal(target.isRoomUnlocked(1), true, 'the unlock arrives');
  assert.equal(target.history.length, 3);
});
