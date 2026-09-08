/**
 * The network edge: an HTTP listener that serves the built client and a
 * health page, and a WebSocket endpoint that turns frames into room calls.
 *
 * Everything off the wire is untrusted. A frame is decoded, its type is
 * switched on, and each field is coerced before it reaches a room; a
 * malformed message is dropped rather than allowed to throw inside the
 * simulation loop, where it would take every player in the room down with it.
 *
 * Built as a function returning a handle rather than a module that listens
 * on import, so tests can bring a server up on port 0 and tear it down.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, TICK_MS, decodeClientMessage, encode } from '@boxhead/shared';
import type { ExtractedRoom, ServerMessage, StampedCommand } from '@boxhead/shared';
import { Room } from './Room.js';

export interface GameServerOptions {
  port: number;
  rooms: ExtractedRoom[];
  /** The single-file client build; when absent `/` explains how to get one. */
  clientHtml?: string;
  log?: (line: string) => void;
}

export interface GameServer {
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

const MAX_NAME = 24;
/** Rooms a single server will host at once. */
const MAX_ROOMS = 32;
/** Largest frame accepted; a real client sends a few hundred bytes. */
const MAX_PAYLOAD = 16 * 1024;
/** Silence after which a socket is presumed dead and its seat released for reclaim. */
const IDLE_TIMEOUT_MS = 15_000;
/** A connection that never joins is dropped after this long. */
const JOIN_TIMEOUT_MS = 10_000;
const ROOM_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Printable characters only, so a name cannot forge log lines or the health page. */
function cleanText(value: unknown, max: number, fallback: string): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, max);
  return text || fallback;
}

export function createGameServer(options: GameServerOptions): Promise<GameServer> {
  const log = options.log ?? console.log;
  const arenas = options.rooms;
  const rooms = new Map<string, Room>();

  function roomFor(id: string): Room | null {
    let room = rooms.get(id);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) return null;
      const created = new Room({
        id,
        rooms: arenas,
        log,
        onEmpty: () => {
          // Stop simulating an empty room rather than burning a timer forever.
          created.stop();
          rooms.delete(id);
          log(`[${id}] closed`);
        },
      });
      room = created;
      rooms.set(id, room);
    }
    return room;
  }

  const http = createServer((request, response) => {
    // Only the path matters: a shared link carries the server in its query.
    const url = (request.url ?? '/').split('?')[0]!;
    if (url === '/' || url === '/index.html') {
      if (options.clientHtml !== undefined) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(options.clientHtml);
      } else {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(
          'boxhead server is running, but the client is not built.\n' +
            'Run `npm run build` in the repo and restart, or open a client and point it here.\n' +
            'Status: /health\n',
        );
      }
      return;
    }
    if (url === '/health') {
      const body = JSON.stringify({
        ok: true,
        protocol: PROTOCOL_VERSION,
        tickMs: TICK_MS,
        rooms: [...rooms.values()].map((room) => ({
          id: room.id,
          phase: room.phase,
          players: room.playerCount,
          tick: room.tick,
          level: room.world?.level ?? 0,
        })),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, perMessageDeflate: true, maxPayload: MAX_PAYLOAD });

  // Liveness: a socket that goes silent (a laptop lid, a dropped Wi-Fi link)
  // never sends a close frame, and the OS may take minutes to notice. The
  // client pings every second, so silence is a clear sign.
  const lastSeen = new Map<WebSocket, number>();
  const hasJoined = new Map<WebSocket, boolean>();
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [client, seen] of lastSeen) {
      const limit = hasJoined.get(client) ? IDLE_TIMEOUT_MS : JOIN_TIMEOUT_MS;
      if (now - seen > limit) client.terminate();
    }
  }, 2_000);
  reaper.unref();

  wss.on('connection', (socket: WebSocket) => {
    const clientId = randomUUID();
    let joined: Room | null = null;
    lastSeen.set(socket, Date.now());
    hasJoined.set(socket, false);

    const send = (message: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(encode(message));
    };
    // Room broadcasts that arrive while a join is still being answered wait
    // behind the welcome, so the client always learns its seat first.
    let welcomed = false;
    const held: string[] = [];
    const sendText = (text: string): void => {
      if (!welcomed) {
        held.push(text);
        return;
      }
      if (socket.readyState === socket.OPEN) socket.send(text);
    };
    const flush = (): void => {
      welcomed = true;
      for (const text of held) sendText(text);
      held.length = 0;
    };

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      lastSeen.set(socket, Date.now());
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
          const requested = typeof message.room === 'string' ? message.room : '';
          const roomId = ROOM_ID.test(requested) ? requested : arenas[0]!.id;
          const room = roomFor(roomId);
          if (!room) {
            send({ type: 'reject', reason: 'server is full' });
            socket.close();
            return;
          }
          const name = cleanText(message.name, MAX_NAME, 'player');
          const character = cleanText(message.character, 24, 'swat');
          const token = typeof message.token === 'string' ? message.token : undefined;
          const participant = token === undefined
            ? room.join(clientId, name, character, sendText)
            : room.join(clientId, name, character, sendText, token);
          if (!participant) {
            send({ type: 'reject', reason: 'room is full' });
            socket.close();
            if (room.isEmpty) {
              room.stop();
              rooms.delete(room.id);
            }
            return;
          }
          joined = room;
          hasJoined.set(socket, true);
          send(room.welcomeFor(participant));
          flush();
          log(`[${room.id}] ${participant.name} joined as seat ${participant.playerIndex} (${room.playerCount} connected)`);
          break;
        }
        case 'input': {
          if (!joined || !Array.isArray(message.commands)) return;
          joined.applyInput(clientId, message.commands as StampedCommand[]);
          break;
        }
        case 'ping': {
          send({ type: 'pong', sent: Number(message.sent) || 0, serverTime: Date.now(), tick: joined?.tick ?? 0 });
          break;
        }
        case 'ready': {
          if (!joined) return;
          joined.setReady(clientId, message.ready === true);
          break;
        }
        case 'mark': {
          if (!joined) return;
          joined.relayMark(clientId, message.kind, Number(message.x), Number(message.y));
          break;
        }
        case 'configure': {
          if (!joined || !message.config || typeof message.config !== 'object') return;
          joined.configure(clientId, message.config);
          break;
        }
        case 'start': {
          if (!joined) return;
          if (joined.start(clientId)) log(`[${joined.id}] match started, seed ${joined.config.seed}`);
          break;
        }
        case 'leave': {
          if (joined) {
            const participant = joined.leave(clientId, { reserve: false });
            if (participant) log(`[${joined.id}] ${participant.name} left`);
            joined = null;
          }
          socket.close();
          break;
        }
      }
    });

    socket.on('close', () => {
      lastSeen.delete(socket);
      hasJoined.delete(socket);
      if (!joined) return;
      const participant = joined.leave(clientId);
      if (participant) log(`[${joined.id}] ${participant.name} dropped; seat ${participant.playerIndex} held`);
      joined = null;
    });

    socket.on('error', () => socket.close());
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(reaper);
            for (const room of rooms.values()) room.stop();
            rooms.clear();
            for (const client of wss.clients) client.terminate();
            wss.close(() => {
              http.close(() => done());
            });
          }),
      });
    });
  });
}
