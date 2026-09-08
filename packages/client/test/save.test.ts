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

test('a poisoned progress code cannot write a bad best', () => {
  const save = new SaveData();
  save.recordRun('r1', 0, { score: 1000, level: 4, kills: 10, startLevel: 1, difficulty: 'beginner' }, true, 18);
  const bad = { v: 1, rooms: { r1: { level: 9, kills: 1, plays: 1 }, r2: { score: 'x', level: 2, kills: 0, plays: 1 }, r3: { score: -5, level: 1, kills: 0, plays: 1 } }, unlockedRooms: 'lots', history: [{ roomId: 'r1', at: 'never', score: 5, level: 1 }] };
  const code = `BH1.${Buffer.from(JSON.stringify(bad), 'utf8').toString('base64')}`;
  assert.equal(save.importCode(code), true);
  assert.equal(save.recordFor('r1').score, 1000, 'a record without a score was ignored');
  assert.equal(save.recordFor('r2').score, 0, 'a record with a string score was ignored');
  assert.equal(save.recordFor('r3').score, 0, 'a negative score was ignored');
  assert.equal(save.unlockedRooms, 2, 'a nonsense unlock count was ignored (the first run had earned room 2)');
  assert.equal(save.history.length, 1, 'a history entry without a time was dropped');
  assert.ok(Number.isFinite(save.totalBest));
});

test('a custom start level marks the run as practice', () => {
  const save = new SaveData();
  assert.equal(save.startLevel, 0);
  save.setStartLevel(15);
  assert.equal(save.startLevel, 15);
  assert.equal(save.countsForHighScores, false);
  assert.match(save.practiceReason ?? '', /custom start at level 15/);
  save.setStartLevel(0);
  assert.equal(save.countsForHighScores, true);
});

test('the second seat and the pad rebind without stepping on each other, and reset together', () => {
  const save = new SaveData();
  const seatB = { up: ['ArrowUp'], fire: ['Enter', 'ShiftRight'], pause: ['Backspace'] };
  save.setKeyB('pause', 'Enter', seatB);
  assert.deepEqual(save.keysB['pause'], ['Enter']);
  assert.deepEqual(save.keysB['fire'], ['ShiftRight'], 'the key was taken from fire');
  save.setKeyB('fire', 'KeyL', seatB, true);
  assert.deepEqual(save.keysB['fire'], ['ShiftRight', 'KeyL'], 'shift-click adds beside the first');

  const pad = { fire: [7, 0], next: [5], prev: [4], menu: [1, 3], pause: [9] };
  save.setPadButton('next', 0, pad);
  assert.deepEqual(save.pad['next'], [0]);
  assert.deepEqual(save.pad['fire'], [7], 'A was taken from fire');

  save.resetKeys();
  assert.deepEqual(save.keysB, {});
  assert.deepEqual(save.pad, {});
  assert.deepEqual(save.keys, {});
});

test("a room's record line comes from the player's own runs", () => {
  const save = new SaveData();
  assert.equal(save.recordLine('r1', 'expert'), null);
  save.recordRun('r1', 0, { score: 100, level: 21, kills: 5, startLevel: 20, difficulty: 'expert', seconds: 20 }, true, 18);
  save.recordRun('r1', 0, { score: 300, level: 22, kills: 9, startLevel: 20, difficulty: 'expert', seconds: 60 }, true, 18);
  save.recordRun('r1', 0, { score: 50, level: 20, kills: 1, startLevel: 20, difficulty: 'expert', seconds: 9 }, true, 18);
  const line = save.recordLine('r1', 'expert');
  assert.ok(line);
  assert.equal(line.runs, 3);
  assert.equal(line.bestLevel, 22);
  assert.equal(line.medianSeconds, 20);
  assert.equal(save.recordLine('r1', 'beginner'), null, 'another preset is another record');
});
