/**
 * End-to-end check against a running server (`npm run server` first):
 * join, start a match as the lone host, send input, and confirm the server
 * simulates and streams snapshots a mirror world can restore.
 *
 *   tsx packages/server/test/smoke.ts [ws://host:port]
 */
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  ROOMS,
  emptyCommand,
  decodeServerMessage,
  encode,
  worldFromConfig,
} from '@boxhead/shared';
import type { ClientMessage, MatchConfig, StampedCommand, World } from '@boxhead/shared';
import { loadRooms } from '../src/rooms.js';

const url = process.argv[2] ?? `ws://localhost:${DEFAULT_PORT}`;
const rooms = loadRooms(() => {});
const socket = new WebSocket(url);
const send = (message: ClientMessage): void => socket.send(encode(message));

let snapshots = 0;
let firstTick = -1;
let lastTick = -1;
let welcomed = false;
let started = false;
let mirror: World | null = null;
let playerIndex = -1;
let maxPlayers = 0;
let config: MatchConfig | null = null;

socket.on('open', () => {
  send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'smoke', character: 'swat' });
});

socket.on('message', (raw: Buffer) => {
  const message = decodeServerMessage(raw.toString());
  if (!message) return;

  if (message.type === 'reject') {
    console.log(`rejected: ${message.reason}`);
    process.exit(1);
  }

  if (message.type === 'welcome') {
    welcomed = true;
    playerIndex = message.playerIndex;
    maxPlayers = message.maxPlayers;
    config = message.config;
    console.log(
      `welcome: seat ${playerIndex}, room ${message.room}, phase ${message.phase}, ${message.tickMs}ms tick, map ${message.mapHash}`,
    );
    if (message.phase === 'lobby' || message.phase === 'over') send({ type: 'start' });
    else console.log('a match is already running; joining it');
    if (message.snapshot) beginMirroring(message.config, message.snapshot);
  }

  if (message.type === 'start') {
    started = true;
    console.log(`start: seed ${message.config.seed}, room ${message.config.roomId}`);
    beginMirroring(message.config, message.snapshot);
  }

  if (message.type === 'snapshot') {
    snapshots += 1;
    if (firstTick < 0) firstTick = message.tick;
    lastTick = message.tick;
    if (mirror) {
      mirror.restore(message.snapshot);
      if (snapshots % 10 === 0) {
        console.log(`  tick ${message.tick} ack ${message.ackTick} hash ${mirror.stateHash()} events ${message.events.length}`);
      }
    }
  }
});

function beginMirroring(match: MatchConfig, snapshot: Parameters<World['restore']>[0]): void {
  const arena = rooms.find((r) => r.id === match.roomId) ?? ROOMS.find((r) => r.id === match.roomId);
  if (!arena) {
    console.log(`FAIL: no local definition for room ${match.roomId}`);
    process.exit(1);
  }
  mirror = worldFromConfig(arena, match, maxPlayers);
  mirror.cosmetics = false;
  mirror.restore(snapshot);
  console.log(`restored at tick ${mirror.tick}, hash ${mirror.stateHash()}`);

  let tick = 0;
  const timer = setInterval(() => {
    const batch: StampedCommand[] = [];
    for (let i = 0; i < 2; i++) {
      tick += 1;
      const command = emptyCommand();
      command.moveX = tick % 100 < 50 ? 1 : -1;
      command.fire = tick % 6 < 3;
      const player = mirror?.players[playerIndex];
      command.aimX = (player?.x ?? 0) + 100;
      command.aimY = player?.y ?? 0;
      batch.push({ tick, command });
    }
    send({ type: 'input', commands: batch });
    if (tick > 160) clearInterval(timer);
  }, 40);
}

setTimeout(() => {
  const world = mirror;
  console.log(`snapshots: ${snapshots} (server ticks ${firstTick} -> ${lastTick})`);
  if (world) {
    const p = world.players[playerIndex];
    console.log(`mirror: tick ${world.tick}, enemies ${world.enemies.length}, player ${p?.x.toFixed(1)},${p?.y.toFixed(1)}`);
  }
  const ok = welcomed && (started || config !== null) && snapshots > 10 && lastTick > firstTick && world !== null && world.tick > 0;
  console.log(ok ? 'PASS: server is authoritative and streaming' : 'FAIL');
  send({ type: 'leave' });
  socket.close();
  process.exit(ok ? 0 : 1);
}, 4000);
