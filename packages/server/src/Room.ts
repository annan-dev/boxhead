/**
 * One authoritative game room.
 *
 * The room owns a World and steps it on a fixed 50Hz clock, exactly as the
 * browser does -- the same simulation module, unmodified. Clients send intent;
 * the room decides what actually happened and broadcasts snapshots.
 *
 * Client-side prediction and delta compression are not implemented yet. The
 * seams they need are: `applyInput` (server consumes numbered commands) and
 * `snapshot` (state the client reconciles against). Both are exercised here, so
 * adding prediction later is filling them in rather than restructuring.
 */
import { World, emptyCommand, ROOMS, TICK_MS, type InputCommand } from '@boxhead/shared';
import type { ExtractedRoom, WorldSnapshot } from '@boxhead/shared';

export interface Participant {
  id: string;
  name: string;
  character: string;
  /** Index into the world's player list. */
  playerIndex: number;
  /** Latest command received, applied on the next tick. */
  pending: InputCommand;
  /** Client tick of that command, echoed back so the client can reconcile. */
  pendingTick: number;
  send: (message: string) => void;
}

export interface RoomOptions {
  id: string;
  room?: ExtractedRoom;
  seed?: number;
  maxPlayers?: number;
  /** Ticks between broadcasts; 3 gives about 17 updates a second. */
  snapshotInterval?: number;
}

export class Room {
  readonly id: string;
  readonly world: World;
  readonly maxPlayers: number;
  private readonly participants = new Map<string, Participant>();
  private readonly snapshotInterval: number;
  private timer: NodeJS.Timeout | null = null;
  /** Wall-clock accumulator, so a slow host still runs the right tick count. */
  private accumulator = 0;
  private lastTime = 0;

  constructor(options: RoomOptions) {
    this.id = options.id;
    this.maxPlayers = options.maxPlayers ?? 4;
    this.snapshotInterval = options.snapshotInterval ?? 3;
    const room = options.room ?? ROOMS[0]!;
    this.world = new World({
      room,
      seed: options.seed ?? (Date.now() & 0xffff),
      playerCount: this.maxPlayers,
    });
  }

  get playerCount(): number {
    return this.participants.size;
  }

  get isEmpty(): boolean {
    return this.participants.size === 0;
  }

  /** Claim a player slot. Returns null when the room is full. */
  join(id: string, name: string, character: string, send: (message: string) => void): Participant | null {
    if (this.participants.size >= this.maxPlayers) return null;

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
      name,
      character,
      playerIndex,
      pending: emptyCommand(),
      pendingTick: 0,
      send,
    };
    this.participants.set(id, participant);

    const player = this.world.players[playerIndex];
    if (player) player.characterId = character;
    return participant;
  }

  leave(id: string): Participant | undefined {
    const participant = this.participants.get(id);
    this.participants.delete(id);
    return participant;
  }

  /** Record a client's intent; it is applied on the next authoritative tick. */
  applyInput(id: string, tick: number, command: InputCommand): void {
    const participant = this.participants.get(id);
    if (!participant) return;
    // Drop out-of-order packets rather than rewinding.
    if (tick < participant.pendingTick) return;
    participant.pending = command;
    participant.pendingTick = tick;
  }

  snapshot(): WorldSnapshot {
    return this.world.snapshot();
  }

  broadcast(message: string): void {
    for (const participant of this.participants.values()) participant.send(message);
  }

  start(): void {
    if (this.timer) return;
    this.lastTime = Date.now();
    // A 10ms timer with an accumulator keeps the tick rate honest even though
    // setInterval is not precise.
    this.timer = setInterval(() => this.pump(), Math.max(1, Math.floor(TICK_MS / 2)));
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private pump(): void {
    const now = Date.now();
    // Clamp so a stalled host does not try to replay a huge backlog at once.
    this.accumulator += Math.min(now - this.lastTime, 250);
    this.lastTime = now;

    let stepped = false;
    while (this.accumulator >= TICK_MS) {
      this.step();
      this.accumulator -= TICK_MS;
      stepped = true;
    }
    if (!stepped) return;

    if (this.world.tick % this.snapshotInterval === 0) this.publish();
  }

  private step(): void {
    const commands: InputCommand[] = [];
    for (let i = 0; i < this.maxPlayers; i++) commands[i] = emptyCommand();
    for (const participant of this.participants.values()) {
      commands[participant.playerIndex] = participant.pending;
    }
    this.world.step(commands);
    // Sounds and cosmetic queues are the client's business; drain them so the
    // server does not accumulate state nobody reads.
    this.world.sounds.length = 0;
  }

  private publish(): void {
    const snapshot = this.world.snapshot();
    for (const participant of this.participants.values()) {
      participant.send(
        JSON.stringify({
          type: 'snapshot',
          tick: this.world.tick,
          ackTick: participant.pendingTick,
          snapshot,
        }),
      );
    }
  }
}
