/**
 * Networking tests.
 *
 * Two things must hold or online play is a mess of jolts:
 *
 *   1. Every client restores the same authoritative state from the same
 *      snapshot, over real sockets, with real input flowing.
 *   2. A client that restores a snapshot and replays its own commands newer
 *      than `ackTick` lands on exactly the server's state. That is the
 *      reconciliation contract; if it drifts, prediction cannot work.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  ROOMS,
  decodeServerMessage,
  emptyCommand,
  encode,
  worldFromConfig,
} from '@boxhead/shared';
import type {
  ClientMessage,
  InputCommand,
  MatchConfig,
  ServerMessage,
  StampedCommand,
  World,
  WorldSnapshot,
} from '@boxhead/shared';
import { createGameServer, type GameServer } from '../src/server.js';
import { Room } from '../src/Room.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A scripted command stream: trigger pulsed (the pistol is semi-automatic), movement wandering with the tick. */
function scripted(tick: number, world: World, playerIndex: number): InputCommand {
  const command = emptyCommand();
  const phase = tick * 0.05;
  command.moveX = Math.cos(phase) > 0.2 ? 1 : Math.cos(phase) < -0.2 ? -1 : 0;
  command.moveY = Math.sin(phase * 0.7) > 0.3 ? 1 : Math.sin(phase * 0.7) < -0.3 ? -1 : 0;
  command.fire = tick % 6 < 3;
  const player = world.players[playerIndex];
  command.aimX = (player?.x ?? 0) + Math.cos(phase) * 200;
  command.aimY = (player?.y ?? 0) + Math.sin(phase) * 200;
  return command;
}

// ---- 1. two headless clients over sockets ----------------------------------

interface HeadlessClient {
  socket: WebSocket;
  messages: ServerMessage[];
  playerIndex: number;
  config: MatchConfig | null;
  maxPlayers: number;
  send(message: ClientMessage): void;
  waitFor<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>>;
}

function connect(port: number, name: string): Promise<HeadlessClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: ServerMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
  const client: HeadlessClient = {
    socket,
    messages,
    playerIndex: -1,
    config: null,
    maxPlayers: 0,
    send: (message) => socket.send(encode(message)),
    waitFor: (type) =>
      new Promise((resolve) => {
        const found = messages.find((m) => m.type === type);
        if (found) resolve(found as never);
        else waiters.push({ type, resolve: resolve as (m: ServerMessage) => void });
      }),
  };
  socket.on('message', (raw: Buffer) => {
    const message = decodeServerMessage(raw.toString());
    if (!message) return;
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.type === message.type) waiters.splice(i, 1)[0]!.resolve(message);
    }
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      client.send({ type: 'join', protocol: PROTOCOL_VERSION, name, character: 'swat' });
      resolve(client);
    });
    socket.once('error', reject);
  });
}

let server: GameServer | null = null;

after(async () => {
  if (server) await server.close();
});

test('two clients over sockets restore identical state from every snapshot', async () => {
  server = await createGameServer({ port: 0, rooms: ROOMS, log: () => {} });
  const a = await connect(server.port, 'alpha');
  const b = await connect(server.port, 'beta');

  for (const client of [a, b]) {
    const welcome = await client.waitFor('welcome');
    assert.equal(welcome.phase, 'lobby');
    assert.equal(welcome.snapshot, null);
    client.playerIndex = welcome.playerIndex;
    client.config = welcome.config;
    client.maxPlayers = welcome.maxPlayers;
  }
  assert.notEqual(a.playerIndex, b.playerIndex);

  a.send({ type: 'ready', ready: true });
  b.send({ type: 'ready', ready: true });
  await sleep(50);
  a.send({ type: 'start' });

  const mirrors = new Map<HeadlessClient, World>();
  for (const client of [a, b]) {
    const start = await client.waitFor('start');
    const arena = ROOMS.find((r) => r.id === start.config.roomId)!;
    const mirror = worldFromConfig(arena, start.config, client.maxPlayers);
    mirror.cosmetics = false;
    mirror.restore(start.snapshot);
    mirrors.set(client, mirror);
  }
  assert.equal(mirrors.get(a)!.stateHash(), mirrors.get(b)!.stateHash());

  // Drive both clients for a while, one stamped command per 20ms.
  const TICKS = 150;
  for (let tick = 1; tick <= TICKS; tick++) {
    for (const client of [a, b]) {
      const mirror = mirrors.get(client)!;
      const commands: StampedCommand[] = [{ tick, command: scripted(tick, mirror, client.playerIndex) }];
      client.send({ type: 'input', commands });
    }
    await sleep(20);
  }
  await sleep(100);

  // Restore every snapshot in order and record the hash at each server tick.
  const hashes = new Map<HeadlessClient, Map<number, number>>();
  for (const client of [a, b]) {
    const mirror = mirrors.get(client)!;
    const byTick = new Map<number, number>();
    let lastAck = -1;
    let count = 0;
    for (const message of client.messages) {
      if (message.type !== 'snapshot') continue;
      assert.ok(message.ackTick >= lastAck, `ackTick went backwards: ${lastAck} -> ${message.ackTick}`);
      lastAck = message.ackTick;
      mirror.restore(message.snapshot);
      byTick.set(message.tick, mirror.stateHash());
      count += 1;
    }
    assert.ok(count > 20, `expected a stream of snapshots, got ${count}`);
    assert.ok(lastAck > TICKS / 2, `server consumed only up to input tick ${lastAck}`);
    hashes.set(client, byTick);
  }

  let compared = 0;
  for (const [tick, hash] of hashes.get(a)!) {
    const other = hashes.get(b)!.get(tick);
    if (other === undefined) continue;
    assert.equal(hash, other, `state hash differs at server tick ${tick}`);
    compared += 1;
  }
  assert.ok(compared > 20, `only ${compared} common snapshot ticks`);

  a.send({ type: 'leave' });
  b.send({ type: 'leave' });
  await sleep(50);
});

// ---- 2. reconciliation without sockets -------------------------------------

test('a mirror that restores a snapshot and replays its own inputs matches the server', () => {
  const inbox = new Map<string, ServerMessage[]>();
  const sendTo = (id: string) => (text: string) => {
    const message = decodeServerMessage(text);
    if (message) inbox.get(id)!.push(message);
  };
  inbox.set('A', []);
  inbox.set('B', []);

  const room = new Room({ id: 'test', rooms: ROOMS, maxPlayers: 4, snapshotInterval: 3 });
  const a = room.join('A', 'alpha', 'swat', sendTo('A'))!;
  room.join('B', 'beta', 'swat', sendTo('B'));
  room.setReady('B', true);
  assert.ok(room.start('A'));
  const world = room.world!;

  const start = inbox.get('A')!.find((m) => m.type === 'start')!;
  assert.equal(start.type, 'start');
  const arena = ROOMS.find((r) => r.id === start.config.roomId)!;
  const mirror = worldFromConfig(arena, start.config, room.maxPlayers);
  mirror.cosmetics = false;

  // Snapshots arrive `LAG` ticks after the server produced them, by which
  // time the client has already sent (and predicted) LAG more commands.
  const LAG = 2;
  const sent = new Map<number, InputCommand>();
  const pending: Array<{ tick: number; ackTick: number; snapshot: WorldSnapshot }> = [];
  let captured = 0;

  const emptyRow = (): InputCommand[] => {
    const row: InputCommand[] = [];
    for (let i = 0; i < room.maxPlayers; i++) row[i] = emptyCommand();
    return row;
  };

  for (let tick = 1; tick <= 600; tick++) {
    const command = scripted(tick, world, a.playerIndex);
    sent.set(tick, command);
    room.applyInput('A', [{ tick, command }]);
    const before = inbox.get('A')!.length;
    room.advance(1);
    assert.equal(room.phase, 'playing', `run ended at tick ${tick}; pick a longer script`);
    for (const message of inbox.get('A')!.slice(before)) {
      if (message.type === 'snapshot') pending.push(message);
    }

    // Deliver whatever snapshot is LAG ticks old, then reconcile.
    while (pending.length > 0 && pending[0]!.tick <= world.tick - LAG) {
      const message = pending.shift()!;
      mirror.restore(message.snapshot);
      assert.equal(mirror.tick, message.tick);
      for (let replay = message.ackTick + 1; mirror.tick < world.tick; replay++) {
        const row = emptyRow();
        row[a.playerIndex] = sent.get(replay) ?? emptyCommand();
        mirror.step(row);
      }
      assert.equal(mirror.tick, world.tick);
      assert.equal(
        mirror.stateHash(),
        world.stateHash(),
        `mirror drifted after restoring tick ${message.tick} (ack ${message.ackTick}) and replaying to ${world.tick}`,
      );
      captured += 1;
    }
  }
  assert.ok(captured >= 190, `only ${captured} snapshots reconciled`);
  room.stop();
});
