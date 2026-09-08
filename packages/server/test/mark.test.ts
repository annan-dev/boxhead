/**
 * A squad mark is relayed to every other seat, never back to its sender,
 * only for the kinds the wheel has, and no faster than four a second.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS, decodeServerMessage } from '@boxhead/shared';
import { Room } from '../src/Room.js';

function collector(): { lines: string[]; send: (text: string) => void } {
  const lines: string[] = [];
  return { lines, send: (text) => lines.push(text) };
}

test('a mark reaches the other seats with the marker’s index, and not the marker', () => {
  const room = new Room({ id: 'mark', rooms: ROOMS, maxPlayers: 3, snapshotInterval: 1 });
  const a = collector();
  const b = collector();
  const c = collector();
  room.join('A', 'alpha', 'swat', a.send);
  const seatB = room.join('B', 'beta', 'bond', b.send);
  room.join('C', 'gamma', 'swat', c.send);
  assert.ok(seatB);
  const before = { a: a.lines.length, b: b.lines.length, c: c.lines.length };

  assert.ok(room.relayMark('B', 'enemy', 300, 200));
  const marks = (lines: string[], from: number) =>
    lines.slice(from).map((l) => decodeServerMessage(l)).filter((m) => m && m.type === 'mark');
  assert.equal(marks(b.lines, before.b).length, 0, 'the marker got their own mark back');
  const toA = marks(a.lines, before.a);
  const toC = marks(c.lines, before.c);
  assert.equal(toA.length, 1);
  assert.equal(toC.length, 1);
  const mark = toA[0]!;
  if (mark && mark.type === 'mark') {
    assert.equal(mark.playerIndex, seatB.playerIndex);
    assert.equal(mark.kind, 'enemy');
    assert.equal(mark.x, 300);
    assert.equal(mark.y, 200);
  }
});

test('a mark of a kind the wheel does not have, or off the arena, is dropped', () => {
  const room = new Room({ id: 'mark2', rooms: ROOMS, maxPlayers: 2, snapshotInterval: 1 });
  const a = collector();
  room.join('A', 'alpha', 'swat', a.send);
  room.join('B', 'beta', 'bond', () => {});
  const from = a.lines.length;
  assert.equal(room.relayMark('B', 'taunt', 10, 10), false);
  assert.equal(room.relayMark('B', 'enemy', Number.NaN, 10), false);
  assert.equal(room.relayMark('B', 'enemy', 1e9, 10), false);
  assert.equal(room.relayMark('nobody', 'enemy', 10, 10), false);
  assert.equal(a.lines.slice(from).filter((l) => decodeServerMessage(l)?.type === 'mark').length, 0);
});

test('a seat gets four marks a second and no more', () => {
  const room = new Room({ id: 'mark3', rooms: ROOMS, maxPlayers: 2, snapshotInterval: 1 });
  const a = collector();
  room.join('A', 'alpha', 'swat', a.send);
  room.join('B', 'beta', 'bond', () => {});
  const from = a.lines.length;
  let accepted = 0;
  for (let i = 0; i < 10; i++) if (room.relayMark('B', 'go', 100 + i, 100)) accepted += 1;
  assert.equal(accepted, 4);
  assert.equal(a.lines.slice(from).filter((l) => decodeServerMessage(l)?.type === 'mark').length, 4);
});
