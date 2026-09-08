/**
 * A seat on a server.
 *
 * The world here is a prediction: the server's last snapshot, advanced by the
 * commands this client has sent since. Every snapshot that arrives replaces
 * it and the unacknowledged commands are replayed on top (see Reconcile in
 * the shared package). Other players' inputs are unknown between snapshots,
 * so they are guessed from what they were last seen doing.
 *
 * Only the local player's own sounds are played from the prediction; the
 * rest arrive as events from the server, which is the one that knows they
 * happened. Banners and score popups likewise come from the server, so the
 * predicted world runs with its cosmetics turned off.
 */
import {
  GameMap,
  InputHistory,
  TICK_MS,
  World,
  emptyCommand,
  inferRemoteCommand,
  reconcile,
  tickMsFor,
  worldFromConfig,
  type ExtractedRoom,
  type InputCommand,
  type LobbyPlayer,
  type MatchConfig,
  type NetEvent,
  type PlayerSnapshot,
  type RoomPhase,
  type ServerMessage,
  type StampedCommand,
  type WorldSnapshot,
} from '@boxhead/shared';
import type { Input } from '../input/Input.js';
import type { Camera } from '../render/Camera.js';
import { NetClient, type NetState } from '../net/NetClient.js';
import type { Presenter, Session, SessionStatus } from './Session.js';

export interface LobbyState {
  phase: RoomPhase;
  config: MatchConfig;
  players: LobbyPlayer[];
  localIndex: number;
  isHost: boolean;
  rooms: ExtractedRoom[];
}

export interface NetSessionEvents {
  /** Seats, readiness or the match settings changed. */
  onLobby: (state: LobbyState) => void;
  /** A match began; the world is fresh. */
  onStart: () => void;
  /** The connection state changed; `detail` is a short human reason. */
  onNet: (state: NetState, detail: string) => void;
  /** The server turned the join down or the link is gone for good. */
  onClosed: (reason: string) => void;
}

/** Corrections smaller than this are not worth smoothing. */
const SNAP_DISTANCE = 1;
/** Corrections larger than this are teleports; slide only the small ones. */
const SMOOTH_MAX_DISTANCE = 96;

export class NetSession implements Session {
  world: World;
  room: ExtractedRoom;
  localPlayerIndex = -1;
  stepMs = TICK_MS;
  readonly recordsScores = false;

  private readonly net: NetClient;
  private readonly history = new InputHistory();
  private config: MatchConfig | null = null;
  private maxPlayers = 4;
  private phase: RoomPhase = 'lobby';
  private lobbyPlayers: LobbyPlayer[] = [];
  private pending: Extract<ServerMessage, { type: 'snapshot' }> | null = null;
  private lastSnapshot: WorldSnapshot | null = null;
  /**
   * The tile arrays from the last full snapshot, at the server's revision.
   * The server sends tiles only when its own map changed, but this client's
   * prediction may have changed its copy first (a shot into a barricade, a
   * barrel placed), so a lean snapshot is completed from here rather than
   * refused for a revision mismatch.
   */
  private serverTiles: { revision: number; integrityRevision: number; tiles: number[]; integrity: number[] } | null = null;
  private lastPlayers: PlayerSnapshot[] = [];
  private readonly remote: InputCommand[] = [];
  private lastPopupSeq = 0;
  private lastMessageSeq = 0;
  private skipSteps = 0;
  private netState: NetState = 'idle';
  private netDetail = '';
  private replayed = 0;
  private corrections = 0;
  private lastCorrection = 0;
  private readonly before = new Map<number, [number, number]>();
  private disposed = false;
  private readonly presenterHolder: { present: Presenter | null } = { present: null };

  constructor(
    private readonly rooms: ExtractedRoom[],
    private readonly events: NetSessionEvents,
  ) {
    // Something must be on screen behind the lobby; an empty arena will do.
    this.room = rooms[0]!;
    this.world = new World({ room: this.room, seed: 0, playerCount: 1 });
    this.world.cosmetics = false;
    this.net = new NetClient({
      onMessage: (message) => this.receive(message),
      onStateChange: (state, detail) => {
        if (this.disposed) return;
        this.netState = state;
        this.netDetail = detail;
        this.events.onNet(state, detail);
        // A close this session asked for is not news to anyone.
        if (state === 'closed' && detail !== 'left') this.events.onClosed(detail);
      },
    });
  }

  connect(url: string, name: string, character: string): void {
    this.net.connect(url, { name, character });
  }

  get status(): SessionStatus {
    if (this.netState === 'closed') return 'disconnected';
    if (this.phase !== 'playing') return 'waiting';
    if (this.world.gameOver) return 'ended';
    return 'running';
  }

  get isHost(): boolean {
    return this.lobbyPlayers.find((p) => p.index === this.localPlayerIndex)?.host ?? false;
  }

  get rttMs(): number {
    return this.net.rttMs;
  }

  get connectionState(): NetState {
    return this.netState;
  }

  /** Name shown over a seat, for the renderer and HUD. */
  nameOf(playerIndex: number): string | null {
    return this.lobbyPlayers.find((p) => p.index === playerIndex)?.name ?? null;
  }

  // ---- lobby controls -----------------------------------------------------

  setReady(ready: boolean): void {
    this.net.send({ type: 'ready', ready });
  }

  configure(config: Partial<Omit<MatchConfig, 'seed'>>): void {
    this.net.send({ type: 'configure', config });
  }

  start(): void {
    this.net.send({ type: 'start' });
  }

  // ---- messages -----------------------------------------------------------

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.localPlayerIndex = message.playerIndex;
        this.maxPlayers = message.maxPlayers;
        this.phase = message.phase;
        this.stepMs = message.tickMs;
        this.adoptConfig(message.config, message.mapHash);
        if (message.snapshot) this.beginMatch(message.snapshot);
        break;
      case 'lobby':
        this.phase = message.phase;
        this.lobbyPlayers = message.players;
        this.config = message.config;
        this.events.onLobby(this.lobbyState());
        break;
      case 'start':
        this.phase = 'playing';
        this.stepMs = message.tickMs;
        this.adoptConfig(message.config, message.mapHash);
        this.beginMatch(message.snapshot);
        this.events.onStart();
        break;
      case 'snapshot':
        // Only the newest state matters, but two snapshots that land between
        // steps must not lose what only the older one carried: the tile
        // arrays the server sends once per map revision, and the events.
        if (!this.pending) {
          this.pending = message;
        } else if (message.tick > this.pending.tick) {
          const older = this.pending;
          const tiles = older.snapshot.map.tiles;
          const integrity = older.snapshot.map.integrity;
          if (
            !message.snapshot.map.tiles &&
            tiles &&
            integrity &&
            older.snapshot.map.revision === message.snapshot.map.revision &&
            older.snapshot.map.integrityRevision === message.snapshot.map.integrityRevision
          ) {
            message.snapshot.map.tiles = tiles;
            message.snapshot.map.integrity = integrity;
          }
          message.events = [...older.events, ...message.events];
          this.pending = message;
        } else {
          this.pending.events = [...this.pending.events, ...message.events];
        }
        break;
      case 'playerJoined':
      case 'playerLeft':
      case 'reject':
      case 'pong':
        break;
      default:
        break;
    }
  }

  private lobbyState(): LobbyState {
    return {
      phase: this.phase,
      config: this.config!,
      players: this.lobbyPlayers,
      localIndex: this.localPlayerIndex,
      isHost: this.isHost,
      rooms: this.rooms,
    };
  }

  private adoptConfig(config: MatchConfig, mapHash: number): void {
    this.config = config;
    const room = this.rooms.find((r) => r.id === config.roomId);
    if (!room) {
      this.fail(`the server is playing "${config.roomId}", which this client does not have`);
      return;
    }
    if (new GameMap(room).layoutHash() !== mapHash) {
      this.fail(`arena "${room.name}" differs between this client and the server (different art pack?)`);
      return;
    }
    this.room = room;
  }

  private fail(reason: string): void {
    this.net.close();
    this.events.onClosed(reason);
  }

  /** Build a fresh predicted world from a full snapshot. */
  private beginMatch(snapshot: WorldSnapshot): void {
    if (!this.config) return;
    this.world = worldFromConfig(this.room, this.config, this.maxPlayers);
    this.world.cosmetics = false;
    this.world.restore(snapshot);
    this.history.clear();
    this.pending = null;
    this.lastSnapshot = snapshot;
    this.lastPlayers = snapshot.players;
    this.remote.length = 0;
    this.lastPopupSeq = 0;
    this.lastMessageSeq = 0;
    this.skipSteps = 0;
    this.presenterHolder.present?.worldReplaced();
  }

  // ---- the tick -----------------------------------------------------------

  step(input: Input, camera: Camera, present: Presenter): void {
    this.presenterHolder.present = present;
    if (this.phase !== 'playing') return;

    if (this.pending) this.applySnapshot(this.pending, present);

    // Running ahead of the server: sit this one out. Latched key presses
    // survive because no command is built.
    if (this.skipSteps > 0) {
      this.skipSteps -= 1;
      return;
    }

    const me = this.world.players[this.localPlayerIndex];
    const aim = input.aimWorld(camera, me?.x ?? 0, me?.y ?? 0);
    const command = input.buildCommand(aim.x, aim.y);
    const stamped = { tick: this.world.tick + 1, command };
    this.history.push(stamped);
    this.predict(command, present);
    this.net.sendInput([stamped]);
  }

  private predict(command: InputCommand, present: Presenter): void {
    const { world } = this;
    const commands: InputCommand[] = [];
    for (let i = 0; i < world.players.length; i++) {
      commands[i] = i === this.localPlayerIndex ? command : (this.remote[i] ?? emptyCommand());
    }
    world.step(commands);
    this.presentLocalSounds(present);
  }

  /** The player's own actions sound immediately; everyone else's wait for the server. */
  private presentLocalSounds(present: Presenter): void {
    const localId = this.world.players[this.localPlayerIndex]?.id ?? -1;
    for (const event of this.world.sounds) {
      if (event.ownerId === localId) present.playSound(event);
    }
    this.world.sounds.length = 0;
  }

  private applySnapshot(message: Extract<ServerMessage, { type: 'snapshot' }>, present: Presenter): void {
    this.pending = null;
    const { world } = this;
    const map = message.snapshot.map;
    if (map.tiles && map.integrity) {
      this.serverTiles = {
        revision: map.revision,
        integrityRevision: map.integrityRevision,
        tiles: map.tiles,
        integrity: map.integrity,
      };
    } else if (
      this.serverTiles &&
      this.serverTiles.revision === map.revision &&
      this.serverTiles.integrityRevision === map.integrityRevision
    ) {
      map.tiles = this.serverTiles.tiles;
      map.integrity = this.serverTiles.integrity;
    }
    const dt = this.lastSnapshot ? message.tick - this.lastSnapshot.tick : 0;
    for (const player of message.snapshot.players) {
      if (player.index === this.localPlayerIndex) continue;
      this.remote[player.index] = inferRemoteCommand(this.lastPlayers[player.index], player, dt);
    }
    this.lastSnapshot = message.snapshot;
    this.lastPlayers = message.snapshot.players;

    // Remember where everything was drawn so a correction can slide instead of snap.
    this.before.clear();
    for (const player of world.players) this.before.set(player.id, [player.x, player.y]);
    for (const enemy of world.enemies) this.before.set(enemy.id, [enemy.x, enemy.y]);

    this.history.ack(message.ackTick);
    // The replay covers ticks already predicted, whose floor marks are
    // already down; laying them again would darken them every snapshot.
    world.decalsMuted = true;
    try {
      this.replayed = reconcile(
        world,
        message.snapshot,
        this.localPlayerIndex,
        this.history.unacked,
        (index) => this.remote[index] ?? emptyCommand(),
        // Replayed ticks already sounded when they were first predicted.
        { onReplayStep: (w) => (w.sounds.length = 0) },
      );
    } catch (error) {
      world.decalsMuted = false;
      this.fail(error instanceof Error ? error.message : 'bad snapshot');
      return;
    }

    world.decalsMuted = false;
    this.smoothCorrections();
    this.presentEvents(message.events, present);
    this.paceAgainst();
  }

  /**
   * Any entity that moved under the correction keeps its old drawn position
   * as `prev`, so the renderer's own interpolation slides it over one step.
   * Big jumps are teleports and are left alone.
   */
  private smoothCorrections(): void {
    const localId = this.world.players[this.localPlayerIndex]?.id ?? -1;
    let moved = 0;
    const slide = (entity: { id: number; x: number; y: number; prevX: number; prevY: number }): void => {
      const was = this.before.get(entity.id);
      if (!was) return;
      const distance = Math.hypot(entity.x - was[0], entity.y - was[1]);
      if (distance < SNAP_DISTANCE || distance > SMOOTH_MAX_DISTANCE) return;
      entity.prevX = was[0];
      entity.prevY = was[1];
      if (entity.id === localId) moved = Math.max(moved, distance);
    };
    for (const player of this.world.players) slide(player);
    for (const enemy of this.world.enemies) slide(enemy);
    if (moved > 0) {
      this.corrections += 1;
      this.lastCorrection = moved;
    }
  }

  private presentEvents(events: NetEvent[], present: Presenter): void {
    const localId = this.world.players[this.localPlayerIndex]?.id ?? -1;
    for (const event of events) {
      switch (event.type) {
        case 'sound':
          // Own sounds already played from the prediction.
          if (event.ownerId === localId) break;
          present.playSound({ name: event.name, x: event.x, y: event.y, rate: event.rate, ownerId: event.ownerId });
          break;
        case 'popup':
          if (event.seq <= this.lastPopupSeq) break;
          this.lastPopupSeq = event.seq;
          this.eventsSeen.popups += 1;
          this.world.popups.push({ seq: event.seq, x: event.x, y: event.y, text: event.text, life: 45, kind: event.kind });
          if (this.world.popups.length > 24) this.world.popups.shift();
          break;
        case 'message':
          this.eventsSeen.messages += 1;
          if (event.seq <= this.lastMessageSeq) break;
          this.lastMessageSeq = event.seq;
          this.world.messages.push({ seq: event.seq, text: event.text, kind: event.kind, life: event.life });
          if (this.world.messages.length > 6) this.world.messages.shift();
          break;
        default:
          break;
      }
    }
  }

  /**
   * Both ends tick at the same rate, so in the steady state the server's
   * queue is empty and the commands unacknowledged here are exactly the ones
   * in flight. A clock that runs a little fast would let that queue grow
   * without bound, and with it the delay on every action; when more than a
   * round trip's worth is outstanding, skip a step to let the server catch up.
   */
  private paceAgainst(): void {
    const inFlight = Math.ceil(this.net.rttMs / this.stepMs) + 1;
    if (this.history.length - inFlight > 4) this.skipSteps = 1;
  }

  /** Events the server sent this client, duplicates included, for the harness. */
  readonly eventsSeen = { popups: 0, messages: 0 };

  stats(): string[] {
    return [
      `net         ${this.netState}${this.netDetail ? ` (${this.netDetail})` : ''}`,
      `rtt         ${this.net.rttMs.toFixed(0)} ms`,
      `server tick ${this.net.serverTick}`,
      `unacked     ${this.history.length}`,
      `replayed    ${this.replayed}`,
      `corrections ${this.corrections} (last ${this.lastCorrection.toFixed(1)} px)`,
    ];
  }

  dispose(): void {
    this.disposed = true;
    this.net.close();
  }
}
