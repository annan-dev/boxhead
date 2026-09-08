/**
 * Wire protocol shared by client and server.
 *
 * Kept in the shared package deliberately: both ends compile against the same
 * definitions, so a change to a message shape breaks the build rather than
 * failing at runtime on somebody's machine.
 *
 * The messages are JSON today. The shapes are what matter; swapping in a binary
 * encoding later does not change the choreography.
 *
 * Choreography, version 2:
 *
 *   client  join ─────────────────▶ server
 *   client ◀───────────── welcome   (seat, config, phase, and a snapshot if a match is running)
 *   client ◀───────────── lobby     (whenever seats, readiness or the config change)
 *   host    configure / start ────▶
 *   client ◀───────────── start     (fresh world, everybody restores it)
 *   client  input {commands[]} ───▶ (one stamped command per simulated tick)
 *   client ◀───────────── snapshot  (authoritative state every few ticks, with
 *                                    the last input tick the server consumed)
 *
 * A client predicts ahead of the server by stepping the same simulation with
 * its own commands, then on each snapshot restores it and replays every
 * command newer than `ackTick`.
 */
import type { InputCommand } from '../sim/World.js';
import type { WorldSnapshot } from '../sim/Snapshot.js';
import type { Message, Popup } from '../sim/types.js';

export const PROTOCOL_VERSION = 2;

/** Default port a server listens on, and the one a bare address implies. */
export const DEFAULT_PORT = 8787;

export type GameMode = 'coop' | 'deathmatch';

/** What the host chose; the server fills in the seed when the match starts. */
export interface MatchConfig {
  /** `ExtractedRoom.id`; both ends must hold the same arena definition. */
  roomId: string;
  mode: GameMode;
  /** A `DIFFICULTIES` id, which sets the opening level and multiplier. */
  difficulty: string;
  /** A `GAME_SPEEDS` id; the server steps at TICK_MS / factor of wall time. */
  gameSpeed: string;
  devils: boolean;
  /** A practice start on this level instead of the preset's; 0 or absent for the preset. */
  startLevel?: number;
  seed: number;
}

export type RoomPhase = 'lobby' | 'playing' | 'over';

export interface LobbyPlayer {
  index: number;
  name: string;
  character: string;
  ready: boolean;
  host: boolean;
  /** False for a seat that is reserved but whose socket is currently gone. */
  connected: boolean;
}

/** One tick of intent, numbered by the client so the server can echo it back. */
/**
 * Coerce a command off the wire into something the simulation can trust:
 * finite numbers, movement clamped to the unit square, aim clamped to the
 * arena, booleans that are really booleans, a slot that is a digit or null.
 * Returns null for anything that is not an object.
 */
export function sanitizeCommand(raw: unknown, width: number, height: number): InputCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const slot = r['weaponSlot'];
  return {
    moveX: clamp(num(r['moveX']), -1, 1),
    moveY: clamp(num(r['moveY']), -1, 1),
    aimX: clamp(num(r['aimX']), -width, width * 2),
    aimY: clamp(num(r['aimY']), -height, height * 2),
    fire: r['fire'] === true,
    weaponSlot: typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot <= 9 ? slot : null,
    nextWeapon: r['nextWeapon'] === true,
    prevWeapon: r['prevWeapon'] === true,
  };
}

export interface StampedCommand {
  tick: number;
  command: InputCommand;
}

/**
 * Cosmetic happenings the server saw that a client cannot reproduce from
 * state alone, because it was not the one who caused them.
 */
export type NetEvent =
  | { type: 'sound'; tick: number; name: string; x: number; y: number; rate: number; ownerId: number }
  | { type: 'popup'; tick: number; seq: number; x: number; y: number; text: string; kind: Popup['kind'] }
  | { type: 'message'; tick: number; seq: number; text: string; kind: Message['kind']; life: number };

/** Client to server. */
export type ClientMessage =
  | {
      type: 'join';
      protocol: number;
      name: string;
      character: string;
      room?: string;
      /** From an earlier `welcome`, to reclaim the same seat after a drop. */
      token?: string;
    }
  | { type: 'leave' }
  /** Normally one command; several only when a stall left some unsent. */
  | { type: 'input'; commands: StampedCommand[] }
  | { type: 'ping'; sent: number }
  | { type: 'ready'; ready: boolean }
  /** Host only. */
  | { type: 'configure'; config: Partial<Omit<MatchConfig, 'seed'>> }
  /** Host only. */
  | { type: 'start' };

/** Server to client. */
export type ServerMessage =
  | {
      type: 'welcome';
      protocol: number;
      playerIndex: number;
      room: string;
      token: string;
      maxPlayers: number;
      /** Wall milliseconds per simulated tick at the current game speed. */
      tickMs: number;
      phase: RoomPhase;
      config: MatchConfig;
      /** `GameMap.layoutHash()` of the arena, so a mismatched art pack is caught early. */
      mapHash: number;
      tick: number;
      /** Present when a match is running; null in the lobby. */
      snapshot: WorldSnapshot | null;
      /** The banners still on screen, so a rejoining client's strip matches the room's. */
      messages?: Array<{ seq: number; text: string; kind: Message['kind']; life: number }>;
    }
  | { type: 'reject'; reason: string }
  | { type: 'lobby'; phase: RoomPhase; config: MatchConfig; players: LobbyPlayer[] }
  | {
      type: 'start';
      config: MatchConfig;
      tickMs: number;
      mapHash: number;
      tick: number;
      snapshot: WorldSnapshot;
    }
  /** Authoritative state. `ackTick` is the newest input tick the server has consumed. */
  | { type: 'snapshot'; tick: number; ackTick: number; snapshot: WorldSnapshot; events: NetEvent[] }
  | { type: 'playerJoined'; playerIndex: number; name: string; character: string }
  | { type: 'playerLeft'; playerIndex: number }
  | { type: 'pong'; sent: number; serverTime: number; tick: number };

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

/**
 * Turn what a person typed into a WebSocket URL. Accepts a bare host, a
 * host:port, or a full ws:// / wss:// / http:// / https:// URL. A bare address
 * gets the default port, and the scheme follows the page: a page served over
 * https can only open wss.
 */
export function serverUrl(raw: string, pageIsSecure = false): string {
  let text = raw.trim();
  if (text === '') text = 'localhost';
  let scheme = pageIsSecure ? 'wss' : 'ws';
  const match = /^([a-z]+):\/\/(.*)$/i.exec(text);
  if (match) {
    const given = match[1]!.toLowerCase();
    scheme = given === 'https' || given === 'wss' ? 'wss' : 'ws';
    text = match[2]!;
  }
  text = text.replace(/\/.*$/, '');
  // An IPv6 literal carries its own colons; only add a port when there is none.
  const hasPort = /^\[.*\]:\d+$/.test(text) || (!text.startsWith('[') && /:\d+$/.test(text));
  if (!hasPort) text = `${text}:${DEFAULT_PORT}`;
  return `${scheme}://${text}`;
}
