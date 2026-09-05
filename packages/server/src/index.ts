/**
 * Authoritative game server.
 *
 * A working skeleton, not a stub: it accepts real WebSocket connections, runs
 * the same simulation the browser runs, and broadcasts authoritative snapshots.
 * What it does not yet do is client-side prediction, reconciliation or delta
 * compression -- those build on this rather than replacing it.
 *
 *   npm run server            # listens on 8787
 *   PORT=9000 npm run server
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  ROOMS,
  TICK_MS,
  decodeClientMessage,
  type ServerMessage,
} from '@boxhead/shared';
import { Room } from './Room.js';

const PORT = Number(process.env.PORT ?? 8787);
const rooms = new Map<string, Room>();

function roomFor(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    const def = ROOMS.find((r) => r.id === id) ?? ROOMS[0]!;
    room = new Room({ id, room: def });
    room.start();
    rooms.set(id, room);
  }
  return room;
}

const http = createServer((request, response) => {
  if (request.url === '/health') {
    const body = JSON.stringify({
      ok: true,
      protocol: PROTOCOL_VERSION,
      tickMs: TICK_MS,
      rooms: [...rooms.values()].map((room) => ({
        id: room.id,
        players: room.playerCount,
        tick: room.world.tick,
        level: room.world.level,
      })),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (socket: WebSocket) => {
  const clientId = randomUUID();
  let joined: { room: Room } | null = null;

  const send = (message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  socket.on('message', (raw: Buffer) => {
    // Everything off the wire is untrusted; a malformed frame must not throw.
    const message = decodeClientMessage(raw.toString());
    if (!message) return;

    switch (message.type) {
      case 'join': {
        if (joined) return;
        if (message.protocol !== PROTOCOL_VERSION) {
          send({ type: 'reject', reason: `protocol ${PROTOCOL_VERSION} required` });
          socket.close();
          return;
        }
        const room = roomFor(message.room ?? ROOMS[0]!.id);
        const participant = room.join(
          clientId,
          String(message.name ?? 'player').slice(0, 24),
          String(message.character ?? 'swat'),
          (text) => {
            if (socket.readyState === socket.OPEN) socket.send(text);
          },
        );
        if (!participant) {
          send({ type: 'reject', reason: 'room is full' });
          socket.close();
          return;
        }
        joined = { room };
        send({
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          playerId: room.world.players[participant.playerIndex]?.id ?? -1,
          playerIndex: participant.playerIndex,
          room: room.id,
          tickMs: TICK_MS,
          snapshot: room.snapshot(),
        });
        room.broadcast(
          JSON.stringify({
            type: 'playerJoined',
            playerIndex: participant.playerIndex,
            name: participant.name,
          }),
        );
        console.log(`[${room.id}] ${participant.name} joined (${room.playerCount} players)`);
        break;
      }
      case 'input': {
        if (!joined) return;
        joined.room.applyInput(clientId, message.tick, message.command);
        break;
      }
      case 'ping': {
        send({ type: 'pong', sent: message.sent, serverTime: Date.now() });
        break;
      }
      case 'leave': {
        socket.close();
        break;
      }
    }
  });

  socket.on('close', () => {
    if (!joined) return;
    const participant = joined.room.leave(clientId);
    if (participant) {
      joined.room.broadcast(
        JSON.stringify({ type: 'playerLeft', playerIndex: participant.playerIndex }),
      );
      console.log(`[${joined.room.id}] ${participant.name} left (${joined.room.playerCount} players)`);
    }
    // Stop simulating an empty room rather than burning a timer forever.
    if (joined.room.isEmpty) {
      joined.room.stop();
      rooms.delete(joined.room.id);
      console.log(`[${joined.room.id}] closed`);
    }
    joined = null;
  });

  socket.on('error', () => socket.close());
});

http.listen(PORT, () => {
  console.log(`boxhead server listening on :${PORT}`);
  console.log(`  protocol v${PROTOCOL_VERSION}, ${TICK_MS}ms tick`);
  console.log(`  health: http://localhost:${PORT}/health`);
});
