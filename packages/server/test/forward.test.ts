/**
 * The server forwards each banner and popup once, and a burst of them does
 * not push a later sound out of the publish window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOMS, decodeServerMessage } from '@boxhead/shared';
import type { NetEvent, ServerMessage } from '@boxhead/shared';
import { Room } from '../src/Room.js';

test('a banner and a popup are forwarded once, and a sound after a burst still arrives', () => {
  const received: ServerMessage[] = [];
  // Publish every tick, so what each step forwards is visible at once.
  const room = new Room({ id: 'fwd', rooms: ROOMS, maxPlayers: 2, snapshotInterval: 1 });
  // The room hands its sockets encoded frames; decode them as a client would.
  room.join('A', 'alpha', 'swat', (frame) => {
    const message = decodeServerMessage(frame as never);
    if (message) received.push(message);
  });
  room.join('B', 'beta', 'swat', () => {});
  room.setReady('B', true);
  room.configure('A', { difficulty: 'expert' });
  assert.ok(room.start('A'));
  const world = room.world!;
  // Step the world and publish what it forwarded, as the room's clock does each tick.
  const inner = room as unknown as { step(): void; publish(): void };
  const stepper = { step: () => { inner.step(); inner.publish(); } };
  const events = (): NetEvent[] => received.flatMap((m) => (m.type === 'snapshot' ? m.events : []));

  // The opening banner is already in the world; three ticks must forward it exactly once.
  for (let i = 0; i < 3; i++) stepper.step();
  const banners = events().filter((e) => e.type === 'message');
  assert.equal(banners.length, 1, 'the banner was forwarded ' + banners.length + ' times');

  // A burst of popups on one tick, then a sound on the next: the sound must not be lost.
  received.length = 0;
  const pushPopup = (world as unknown as { pushPopup(x: number, y: number, text: string, kind: 'score'): void }).pushPopup.bind(world);
  for (let i = 0; i < 20; i++) pushPopup(100, 100, '+' + i, 'score');
  stepper.step();
  world.sounds.push({ name: 'Weapon.Pistol.Fire', x: 0, y: 0, rate: 1, ownerId: -1 });
  stepper.step();
  stepper.step();
  const popups = events().filter((e) => e.type === 'popup');
  const sounds = events().filter((e) => e.type === 'sound' && e.name === 'Weapon.Pistol.Fire');
  assert.equal(popups.length, 20, 'popups forwarded ' + popups.length + ' times');
  assert.equal(sounds.length, 1, 'the sound after the burst was lost or duplicated');
});
