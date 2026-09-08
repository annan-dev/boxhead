/**
 * One game room: a lobby that becomes a match that becomes a lobby again.
 *
 * The room owns the authoritative World and steps it on a fixed clock with
 * the same simulation module the browser runs. Clients send numbered
 * commands; the room consumes exactly one per participant per tick, in
 * order, and tells each client the newest tick it consumed (`ackTick`). That
 * is what lets a client predict ahead and then replay only what the server
 * has not seen yet: if the server skipped or merged commands the client's
 * replay would diverge from the truth and every snapshot would be a jolt.
 *
 * A seat survives a dropped socket for a grace period. Wi-Fi hiccups are
 * common and a player who reconnects with their token gets the same seat,
 * character and score back rather than a fresh spawn in a full room.
 *
 * Phases: `lobby` (host configures, everyone readies up), `playing` (the
 * world ticks), `over` (the run ended; the host can start another).
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MATCH_CONFIG,
  DIFFICULTIES,
  GAME_SPEEDS,
  GameMap,
  PROTOCOL_VERSION,
  World,
  emptyCommand,
  encode,
  tickMsFor,
  worldFromConfig,
  sanitizeCommand,
} from '@boxhead/shared';
import type {
  ExtractedRoom,
  InputCommand,
  LobbyPlayer,
  MatchConfig,
  NetEvent,
  RoomPhase,
  ServerMessage,
  StampedCommand,
  WorldSnapshot,
} from '@boxhead/shared';

/** Ticks a client's last command is repeated while nothing new arrives. */
const IDLE_HOLD_TICKS = 10;

export interface Participant {
  /** Connection id; changes when the same person reconnects. */
  id: string;
  /** Secret handed out in `welcome`, presented again to reclaim the seat. */
  token: string;
  name: string;
  character: string;
  /** Index into the world's player list. */
  playerIndex: number;
  ready: boolean;
  host: boolean;
  connected: boolean;
  /** Commands not yet consumed, oldest first. */
  queue: StampedCommand[];
  /** The command last consumed; held while the queue is empty. */
  last: InputCommand;
  /** Client tick of `last`; echoed back as `ackTick`. */
  lastTick: number;
  /** Ticks stepped since a command was consumed; a silent client stops moving. */
  idleTicks: number;
  /** Map revisions this client has received tile arrays for. */
  sentMapRevision: number;
  sentIntegrityRevision: number;
  send: (message: string) => void;
}

export interface RoomOptions {
  id: string;
  /** Arenas the host may pick from; the first is the default. */
  rooms: ExtractedRoom[];
  maxPlayers?: number;
  /** Ticks between broadcasts; 3 gives about 17 updates a second. */
  snapshotInterval?: number;
  /** Called when the last seat is released, reserved ones included. */
  onEmpty?: () => void;
  /** Where to write one-line notices; silent when absent. */
  log?: (line: string) => void;
}

/** Ticks after the last player falls before the room returns to the lobby. */
const OVER_DELAY_TICKS = 75;
/** How long a dropped seat is held for its token. */
const RECLAIM_GRACE_MS = 60_000;
/** Commands buffered per seat; older ones are dropped, they are stale intent. */
const MAX_QUEUE = 8;
/** Cosmetic events buffered between snapshots. */
const MAX_EVENTS = 64;
/** Commands accepted from one frame; a client sends a handful at most. */
const MAX_COMMANDS_PER_FRAME = 16;

let seedCounter = 0;

export class Room {
  readonly id: string;
  readonly maxPlayers: number;
  readonly rooms: ExtractedRoom[];
  config: MatchConfig;
  phase: RoomPhase = 'lobby';
  /** Null in the lobby; built when the host starts. */
  world: World | null = null;

  private readonly participants = new Map<string, Participant>();
  private readonly reclaimTimers = new Map<string, NodeJS.Timeout>();
  private readonly snapshotInterval: number;
  private readonly onEmpty: (() => void) | undefined;
  private readonly log: ((line: string) => void) | undefined;
  private readonly hashes = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private tickMs: number;
  /** Wall-clock accumulator, so a slow host still runs the right tick count. */
  private accumulator = 0;
  private lastTime = 0;
  private lastPublishedTick = 0;
  private pendingEvents: NetEvent[] = [];
  private lastForwardedSeq = 0;

  constructor(options: RoomOptions) {
    this.id = options.id;
    this.rooms = options.rooms;
    this.maxPlayers = options.maxPlayers ?? 4;
    this.snapshotInterval = options.snapshotInterval ?? 3;
    this.onEmpty = options.onEmpty;
    this.log = options.log;
    const first = options.rooms[0];
    if (!first) throw new Error('a room needs at least one arena');
    this.config = { ...DEFAULT_MATCH_CONFIG, roomId: first.id, seed: 0 };
    this.tickMs = tickMsFor(this.config.gameSpeed);
  }

  // ---- seats ----------------------------------------------------------------

  /** Seats with a socket behind them. */
  get playerCount(): number {
    let count = 0;
    for (const p of this.participants.values()) if (p.connected) count += 1;
    return count;
  }

  /** True once no seat is held, reserved ones included. */
  get isEmpty(): boolean {
    return this.participants.size === 0;
  }

  get tick(): number {
    return this.world?.tick ?? 0;
  }

  get arena(): ExtractedRoom {
    return this.rooms.find((r) => r.id === this.config.roomId) ?? this.rooms[0]!;
  }

  participant(id: string): Participant | undefined {
    return this.participants.get(id);
  }

  /**
   * Claim a seat. A token from an earlier welcome reclaims the seat it was
   * issued for if that seat is waiting for its owner; otherwise the lowest
   * free seat is taken. Null when the room is full.
   */
  join(
    id: string,
    name: string,
    character: string,
    send: (message: string) => void,
    token?: string,
  ): Participant | null {
    if (token !== undefined) {
      const reserved = [...this.participants.values()].find((p) => p.token === token && !p.connected);
      if (reserved) {
        this.clearReclaim(reserved.id);
        this.participants.delete(reserved.id);
        reserved.id = id;
        reserved.name = name;
        reserved.character = character;
        reserved.send = send;
        reserved.connected = true;
        reserved.ready = false;
        this.resetInput(reserved);
        this.participants.set(id, reserved);
        this.world?.setPlayerConnected(reserved.playerIndex, true, character);
        this.resumeClock();
        this.announce(reserved, 'playerJoined');
        return reserved;
      }
    }

    const taken = new Set([...this.participants.values()].map((p) => p.playerIndex));
    let playerIndex = -1;
    for (let i = 0; i < this.maxPlayers; i++) {
      if (!taken.has(i)) {
        playerIndex = i;
        break;
      }
    }
    if (playerIndex < 0) return null;

    const participant: Participant = {
      id,
      token: randomUUID(),
      name,
      character,
      playerIndex,
      ready: false,
      host: false,
      connected: true,
      queue: [],
      last: emptyCommand(),
      lastTick: 0,
      idleTicks: 0,
      sentMapRevision: -1,
      sentIntegrityRevision: -1,
      send,
    };
    // The first person in hosts. If the only host is a reserved seat whose
    // owner may never come back, the newcomer takes over rather than waiting.
    if (![...this.participants.values()].some((p) => p.host && p.connected)) {
      for (const p of this.participants.values()) p.host = false;
      participant.host = true;
    }
    this.participants.set(id, participant);
    this.world?.setPlayerConnected(playerIndex, true, character);
    this.resumeClock();
    this.announce(participant, 'playerJoined');
    return participant;
  }

  /**
   * Release a seat. A dropped socket keeps the seat reserved for a while so
   * the same person can come back; an explicit leave frees it at once.
   */
  leave(id: string, options: { reserve?: boolean } = {}): Participant | undefined {
    const participant = this.participants.get(id);
    if (!participant) return undefined;
    const reserve = options.reserve ?? true;

    participant.connected = false;
    participant.ready = false;
    this.resetInput(participant);
    this.world?.setPlayerConnected(participant.playerIndex, false);
    this.passHost(participant);
    // Nobody left to play: hold the clock so the world waits for them.
    if (this.playerCount === 0) this.stopTimer();

    if (reserve) {
      const timer = setTimeout(() => this.release(participant), RECLAIM_GRACE_MS);
      timer.unref();
      this.reclaimTimers.set(id, timer);
      this.announce(participant, 'playerLeft');
    } else {
      this.release(participant, true);
    }
    return participant;
  }

  private release(participant: Participant, announce = false): void {
    this.clearReclaim(participant.id);
    if (this.participants.get(participant.id) !== participant) return;
    this.participants.delete(participant.id);
    this.passHost(participant);
    if (announce) this.announce(participant, 'playerLeft');
    else this.broadcast(this.lobbyMessage());
    if (this.participants.size === 0) this.onEmpty?.();
  }

  private clearReclaim(id: string): void {
    const timer = this.reclaimTimers.get(id);
    if (timer) clearTimeout(timer);
    this.reclaimTimers.delete(id);
  }

  /** Hand hosting to the lowest-seated connected player when the host is gone. */
  private passHost(leaving: Participant): void {
    if (!leaving.host) return;
    const candidates = [...this.participants.values()]
      .filter((p) => p !== leaving && p.connected)
      .sort((a, b) => a.playerIndex - b.playerIndex);
    const next = candidates[0];
    if (!next) return;
    leaving.host = false;
    next.host = true;
  }

  private resetInput(participant: Participant): void {
    participant.queue = [];
    participant.last = emptyCommand();
    participant.lastTick = 0;
  }

  private announce(participant: Participant, kind: 'playerJoined' | 'playerLeft'): void {
    const notice: ServerMessage =
      kind === 'playerJoined'
        ? {
            type: 'playerJoined',
            playerIndex: participant.playerIndex,
            name: participant.name,
            character: participant.character,
          }
        : { type: 'playerLeft', playerIndex: participant.playerIndex };
    const lobby = this.lobbyMessage();
    for (const other of this.participants.values()) {
      if (!other.connected || other === participant) continue;
      other.send(encode(notice));
    }
    this.broadcast(lobby);
  }

  // ---- lobby ----------------------------------------------------------------

  setReady(id: string, ready: boolean): void {
    const participant = this.participants.get(id);
    if (!participant) return;
    participant.ready = ready;
    this.broadcast(this.lobbyMessage());
  }

  /** Host only, outside a match. Unknown or invalid fields are ignored. */
  configure(id: string, partial: Partial<Omit<MatchConfig, 'seed'>>): boolean {
    const participant = this.participants.get(id);
    if (!participant?.host || this.phase === 'playing') return false;
    const next = { ...this.config };
    if (typeof partial.roomId === 'string' && this.rooms.some((r) => r.id === partial.roomId)) {
      next.roomId = partial.roomId;
    }
    if (partial.mode === 'coop' || partial.mode === 'deathmatch') next.mode = partial.mode;
    if (typeof partial.difficulty === 'string' && DIFFICULTIES.some((d) => d.id === partial.difficulty)) {
      next.difficulty = partial.difficulty;
    }
    if (typeof partial.gameSpeed === 'string' && GAME_SPEEDS.some((s) => s.id === partial.gameSpeed)) {
      next.gameSpeed = partial.gameSpeed;
    }
    if (typeof partial.devils === 'boolean') next.devils = partial.devils;
    this.config = next;
    this.broadcast(this.lobbyMessage());
    return true;
  }

  /** Whether `start` would be accepted from this participant right now. */
  canStart(id: string): boolean {
    const participant = this.participants.get(id);
    if (!participant?.host || !participant.connected || this.phase === 'playing') return false;
    const connected = [...this.participants.values()].filter((p) => p.connected);
    if (connected.length === 1) return true;
    return connected.every((p) => p.ready || p === participant);
  }

  /** Host only. Builds a fresh world and starts the clock. */
  start(id: string): boolean {
    if (!this.canStart(id)) return false;
    seedCounter += 1;
    this.config = { ...this.config, seed: (Date.now() & 0xffff) ^ seedCounter };

    const characters: string[] = [];
    for (const p of this.participants.values()) characters[p.playerIndex] = p.character;
    const world = worldFromConfig(this.arena, this.config, this.maxPlayers, characters);
    world.cosmetics = true;
    const present = new Set<number>();
    for (const p of this.participants.values()) if (p.connected) present.add(p.playerIndex);
    for (let i = 0; i < this.maxPlayers; i++) world.setPlayerConnected(i, present.has(i));

    this.world = world;
    this.phase = 'playing';
    this.pendingEvents = [];
    this.lastForwardedSeq = world.cosmeticSequence;
    this.lastPublishedTick = 0;
    this.tickMs = tickMsFor(this.config.gameSpeed);
    for (const p of this.participants.values()) {
      p.ready = false;
      this.resetInput(p);
    }

    const snapshot = world.snapshot({ includeMap: true });
    const message: ServerMessage = {
      type: 'start',
      config: this.config,
      tickMs: this.tickMs,
      mapHash: this.mapHash(this.config.roomId),
      tick: world.tick,
      snapshot,
    };
    const text = encode(message);
    for (const p of this.participants.values()) {
      if (!p.connected) continue;
      this.noteMapSent(p);
      p.send(text);
    }
    this.startTimer();
    return true;
  }

  lobbyMessage(): ServerMessage {
    const players: LobbyPlayer[] = [...this.participants.values()]
      .sort((a, b) => a.playerIndex - b.playerIndex)
      .map((p) => ({
        index: p.playerIndex,
        name: p.name,
        character: p.character,
        ready: p.ready,
        host: p.host,
        connected: p.connected,
      }));
    return { type: 'lobby', phase: this.phase, config: this.config, players };
  }

  welcomeFor(participant: Participant): ServerMessage {
    let snapshot: WorldSnapshot | null = null;
    if (this.world && this.phase === 'playing') {
      snapshot = this.world.snapshot({ includeMap: true });
      this.noteMapSent(participant);
    }
    return {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      playerIndex: participant.playerIndex,
      room: this.id,
      token: participant.token,
      maxPlayers: this.maxPlayers,
      tickMs: this.tickMs,
      phase: this.phase,
      config: this.config,
      mapHash: this.mapHash(this.config.roomId),
      tick: this.tick,
      snapshot,
    };
  }

  /** `GameMap.layoutHash()` of an arena; building a map is not free, so remembered. */
  mapHash(roomId: string): number {
    const cached = this.hashes.get(roomId);
    if (cached !== undefined) return cached;
    const arena = this.rooms.find((r) => r.id === roomId) ?? this.rooms[0]!;
    const hash = new GameMap(arena).layoutHash();
    this.hashes.set(roomId, hash);
    return hash;
  }

  broadcast(message: ServerMessage | string): void {
    const text = typeof message === 'string' ? message : encode(message);
    for (const participant of this.participants.values()) {
      if (participant.connected) participant.send(text);
    }
  }

  // ---- input ----------------------------------------------------------------

  /**
   * Queue a client's commands. Only ticks newer than anything already queued
   * are kept, so a delayed duplicate cannot rewind. When the queue overflows
   * the oldest go: they describe intent the client has long since moved past.
   */
  applyInput(id: string, commands: StampedCommand[]): void {
    const participant = this.participants.get(id);
    if (!participant || !participant.connected) return;
    const map = this.world?.map;
    let accepted = 0;
    for (const stamped of commands) {
      if (accepted >= MAX_COMMANDS_PER_FRAME) break;
      if (!stamped || !Number.isSafeInteger(stamped.tick) || stamped.tick < 0) continue;
      // Everything off the wire is untrusted: a bad field must not reach the
      // simulation, where a NaN would corrupt the seat for the whole room.
      const command = sanitizeCommand(stamped.command, map?.width ?? 4096, map?.height ?? 4096);
      if (!command) continue;
      const newest = participant.queue[participant.queue.length - 1]?.tick ?? participant.lastTick;
      if (stamped.tick <= newest) continue;
      accepted += 1;
      participant.queue.push({ tick: stamped.tick, command });
      while (participant.queue.length > MAX_QUEUE) participant.queue.shift();
    }
  }

  // ---- the clock ------------------------------------------------------------

  private startTimer(): void {
    this.stopTimer();
    this.lastTime = Date.now();
    this.accumulator = 0;
    // A timer at half the tick with an accumulator keeps the tick rate honest
    // even though setInterval is not precise.
    this.timer = setInterval(() => this.pump(), Math.max(1, Math.floor(this.tickMs / 2)));
  }

  /** Restart a clock that was held while the room stood empty mid-match. */
  private resumeClock(): void {
    if (this.phase === 'playing' && !this.timer && this.world) this.startTimer();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop the clock and drop every reservation. For teardown. */
  stop(): void {
    this.stopTimer();
    for (const timer of this.reclaimTimers.values()) clearTimeout(timer);
    this.reclaimTimers.clear();
  }

  private pump(): void {
    const now = Date.now();
    // Clamp so a stalled host does not try to replay a huge backlog at once.
    this.accumulator += Math.min(now - this.lastTime, 250);
    this.lastTime = now;
    let ticks = 0;
    while (this.accumulator >= this.tickMs && this.phase === 'playing') {
      this.step();
      this.accumulator -= this.tickMs;
      ticks += 1;
    }
    if (ticks > 0) this.publishIfDue();
  }

  /** Step the world without the clock; for tests. */
  advance(ticks: number): void {
    for (let i = 0; i < ticks && this.phase === 'playing'; i++) {
      this.step();
      this.publishIfDue();
    }
  }

  private step(): void {
    const world = this.world;
    if (!world) return;
    const commands: InputCommand[] = [];
    for (let i = 0; i < this.maxPlayers; i++) commands[i] = emptyCommand();
    for (const participant of this.participants.values()) {
      if (!participant.connected) continue;
      const next = participant.queue.shift();
      if (next) {
        participant.last = next.command;
        participant.lastTick = next.tick;
        participant.idleTicks = 0;
      } else {
        participant.idleTicks += 1;
      }
      // Holding the last command papers over jitter; holding it through a
      // stall would walk a player whose tab went to sleep into the horde.
      commands[participant.playerIndex] =
        participant.idleTicks > IDLE_HOLD_TICKS ? emptyCommand() : participant.last;
    }
    world.step(commands);
    this.collectEvents(world);

    if (world.gameOver && world.tick - world.gameOverTick >= OVER_DELAY_TICKS) this.finish();
  }

  /**
   * Gather what happened this tick that a client cannot work out from state:
   * sounds other players caused, and the banners and score popups the
   * server's world generated. Each is stamped with the tick it belongs to.
   */
  private collectEvents(world: World): void {
    const tick = world.tick;
    for (const sound of world.sounds) {
      this.pushEvent({ type: 'sound', tick, name: sound.name, x: sound.x, y: sound.y, rate: sound.rate, ownerId: sound.ownerId });
    }
    world.sounds.length = 0;
    if (world.cosmeticSequence > this.lastForwardedSeq) {
      for (const popup of world.popups) {
        if (popup.seq <= this.lastForwardedSeq) continue;
        this.pushEvent({ type: 'popup', tick, seq: popup.seq, x: popup.x, y: popup.y, text: popup.text, kind: popup.kind });
      }
      for (const message of world.messages) {
        if (message.seq <= this.lastForwardedSeq) continue;
        this.pushEvent({ type: 'message', tick, seq: message.seq, text: message.text, kind: message.kind, life: message.life });
      }
      this.lastForwardedSeq = world.cosmeticSequence;
    }
  }

  private pushEvent(event: NetEvent): void {
    if (this.pendingEvents.length >= MAX_EVENTS) return;
    this.pendingEvents.push(event);
  }

  private publishIfDue(): void {
    if (!this.world) return;
    if (this.world.tick - this.lastPublishedTick < this.snapshotInterval) return;
    this.publish();
  }

  /**
   * Send everyone the state. Tile arrays go only to clients whose copy of the
   * map is behind; the two snapshot variants are built once, not per client.
   */
  private publish(): void {
    const world = this.world;
    if (!world) return;
    this.lastPublishedTick = world.tick;
    const map = world.map;
    let full: WorldSnapshot | undefined;
    let lean: WorldSnapshot | undefined;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const participant of this.participants.values()) {
      if (!participant.connected) continue;
      const needsMap =
        participant.sentMapRevision !== map.revision ||
        participant.sentIntegrityRevision !== map.integrityRevision;
      let snapshot: WorldSnapshot;
      if (needsMap) {
        full ??= world.snapshot({ includeMap: true });
        snapshot = full;
        this.noteMapSent(participant);
      } else {
        lean ??= world.snapshot({ includeMap: false });
        snapshot = lean;
      }
      const message: ServerMessage = {
        type: 'snapshot',
        tick: world.tick,
        ackTick: participant.lastTick,
        snapshot,
        events,
      };
      participant.send(encode(message));
    }
  }

  private noteMapSent(participant: Participant): void {
    if (!this.world) return;
    participant.sentMapRevision = this.world.map.revision;
    participant.sentIntegrityRevision = this.world.map.integrityRevision;
  }

  /** The run ended: freeze the world, tell everyone, and reopen the lobby. */
  private finish(): void {
    this.stopTimer();
    this.phase = 'over';
    this.log?.(`[${this.id}] match over at tick ${this.tick}`);
    for (const p of this.participants.values()) p.ready = false;
    this.broadcast(this.lobbyMessage());
  }
}
