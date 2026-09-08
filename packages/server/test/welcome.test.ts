/**
 * A client arriving mid-match is handed the banners still on the room's
 * strip with its welcome, life remaining, so its strip matches the room's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS } from '@boxhead/shared';
import { Room } from '../src/Room.js';

test('a late joiner’s welcome carries the live banners', () => {
  const room = new Room({ id: 'welcome', rooms: ROOMS, maxPlayers: 3, snapshotInterval: 1 });
  room.join('A', 'alpha', 'swat', () => {});
  room.join('B', 'beta', 'swat', () => {});
  room.setReady('B', true);
  room.configure('A', { difficulty: 'expert' });
  assert.ok(room.start('A'));
  const inner = room as unknown as { step(): void; publish(): void };
  for (let i = 0; i < 10; i++) {
    inner.step();
    inner.publish();
  }
  const late = room.join('C', 'gamma', 'swat', () => {});
  assert.ok(late, 'no seat for the late joiner');
  const welcome = room.welcomeFor(late);
  assert.equal(welcome.type, 'welcome');
  if (welcome.type !== 'welcome') return;
  assert.ok(welcome.snapshot, 'a running match comes with a snapshot');
  const banner = (welcome.messages ?? []).find((m) => m.kind === 'level');
  assert.ok(banner, 'the opening banner was not in the welcome');
  assert.ok(banner.life > 0 && banner.life < 200, `life ${banner.life} is not the remaining life`);
});
