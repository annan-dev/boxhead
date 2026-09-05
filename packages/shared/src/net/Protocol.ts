/**
 * Wire protocol shared by client and server.
 *
 * Kept in the shared package deliberately: both ends compile against the same
 * definitions, so a change to a message shape breaks the build rather than
 * failing at runtime on somebody's machine.
 *
 * The messages are JSON today. The shapes are what matter; swapping in a binary
 * encoding later does not change the choreography.
 */
import type { InputCommand } from '../sim/World.js';
import type { WorldSnapshot } from '../sim/Snapshot.js';

export const PROTOCOL_VERSION = 1;

/** Client to server. */
export type ClientMessage =
  | { type: 'join'; protocol: number; name: string; character: string; room?: string }
  | { type: 'leave' }
  /** One tick of intent. `tick` is the client's own count, for reconciliation. */
  | { type: 'input'; tick: number; command: InputCommand }
  | { type: 'ping'; sent: number };

/** Server to client. */
export type ServerMessage =
  | {
      type: 'welcome';
      protocol: number;
      playerId: number;
      playerIndex: number;
      room: string;
      tickMs: number;
      snapshot: WorldSnapshot;
    }
  | { type: 'reject'; reason: string }
  /** Authoritative state. `ackTick` is the last input the server consumed. */
  | { type: 'snapshot'; tick: number; ackTick: number; snapshot: WorldSnapshot }
  | { type: 'playerJoined'; playerIndex: number; name: string }
  | { type: 'playerLeft'; playerIndex: number }
  | { type: 'pong'; sent: number; serverTime: number };

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

/** Parse an untrusted frame. Returns null rather than throwing on bad input. */
export function decodeClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string') return null;
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== 'string') return null;
    return parsed as ServerMessage;
  } catch {
    return null;
  }
}
