/**
 * End-to-end check: connect a real client, send input, and confirm the server
 * simulates and streams authoritative snapshots back.
 */
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, World, ROOMS, emptyCommand, decodeServerMessage } from '@boxhead/shared';

const socket = new WebSocket('ws://localhost:8787');
let snapshots = 0;
let firstTick = -1;
let lastTick = -1;
let welcomed = false;
let mirrored: World | null = null;

socket.on('open', () => {
  socket.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, name: 'smoke', character: 'swat' }));
});

socket.on('message', (raw: Buffer) => {
  const message = decodeServerMessage(raw.toString());
  if (!message) return;

  if (message.type === 'welcome') {
    welcomed = true;
    console.log(`welcome: player ${message.playerIndex}, room ${message.room}, ${message.tickMs}ms tick`);
    mirrored = new World({ room: ROOMS[0]!, seed: 1 });
    mirrored.restore(message.snapshot);
    console.log(`restored at tick ${mirrored.tick}, hash ${mirrored.stateHash()}`);

    let tick = 0;
    const timer = setInterval(() => {
      const command = emptyCommand();
      command.moveX = 1;
      command.fire = true;
      const player = mirrored?.players[message.playerIndex];
      command.aimX = (player?.x ?? 0) + 100;
      command.aimY = player?.y ?? 0;
      socket.send(JSON.stringify({ type: 'input', tick: tick++, command }));
      if (tick > 80) clearInterval(timer);
    }, 20);
  }

  if (message.type === 'snapshot') {
    snapshots += 1;
    if (firstTick < 0) firstTick = message.tick;
    lastTick = message.tick;
    if (mirrored) mirrored.restore(message.snapshot);
  }
});

setTimeout(() => {
  const world = mirrored;
  console.log(`snapshots: ${snapshots} (server ticks ${firstTick} -> ${lastTick})`);
  if (world) {
    const p = world.players[0];
    console.log(`mirrored: tick ${world.tick}, enemies ${world.enemies.length}, player ${p?.x.toFixed(1)},${p?.y.toFixed(1)}`);
  }
  const ok = welcomed && snapshots > 10 && lastTick > firstTick && world !== null && world.tick > 0;
  console.log(ok ? 'PASS: server is authoritative and streaming' : 'FAIL');
  socket.close();
  process.exit(ok ? 0 : 1);
}, 2500);
