/**
 * Single player: the world lives here and nowhere else.
 */
import {
  DIFFICULTIES,
  GAME_SPEEDS,
  World,
  tickMsFor,
  type ExtractedRoom,
  type GameMode,
  type InputCommand,
  type WorldSnapshot,
} from '@boxhead/shared';
import type { Input } from '../input/Input.js';
import type { Camera } from '../render/Camera.js';
import type { Presenter, Session, SessionStatus } from './Session.js';

export interface LocalOptions {
  room: ExtractedRoom;
  characterId: string;
  difficulty: string;
  gameSpeed: string;
  devils: boolean;
  /** A parked run to pick up where it left off. */
  snapshot?: WorldSnapshot;
  /** A second player on this screen, with their character. */
  secondCharacterId?: string;
  /** Co-op waves or head-to-head deathmatch; only with a second seat. */
  mode?: GameMode;
  /** A practice start on this level instead of the preset's; the multiplier follows the presets' curve. */
  startLevel?: number;
}

/**
 * The multiplier a custom start banks: the presets' own points (level 1 at
 * x1, 10 at x10, 20 at x30, 35 at x50) joined by straight lines and carried
 * on at the last slope, so a start between two presets sits between them.
 */
export function multiplierForStart(level: number): number {
  const points = DIFFICULTIES.map((d) => [d.startLevel, d.startMultiplier] as const).sort((a, b) => a[0] - b[0]);
  if (level <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [l0, m0] = points[i - 1]!;
    const [l1, m1] = points[i]!;
    if (level <= l1) return Math.round(m0 + ((level - l0) / (l1 - l0)) * (m1 - m0));
  }
  const [l0, m0] = points[points.length - 2]!;
  const [l1, m1] = points[points.length - 1]!;
  return Math.round(m1 + ((level - l1) / (l1 - l0)) * (m1 - m0));
}

/** How far apart two players sharing one screen may get, in world pixels. */
export const SHARED_SCREEN_TETHER = 520;

export class LocalSession implements Session {
  readonly world: World;
  readonly room: ExtractedRoom;
  readonly localPlayerIndex = 0;
  readonly stepMs: number;
  /** Only a co-op run leaves a score behind; a deathmatch leaves a winner. */
  readonly recordsScores: boolean;
  readonly mode: GameMode;
  /** The preset the run opened on, for the record it leaves behind. */
  readonly difficulty: string;
  readonly startLevel: number;
  /** The custom level the run opened on, or 0 when the preset decided. */
  readonly customStart: number;
  /** Seats driven from this machine. */
  readonly localSeats: number;

  constructor(options: LocalOptions) {
    this.room = options.room;
    const difficulty = DIFFICULTIES.find((d) => d.id === options.difficulty) ?? DIFFICULTIES[0]!;
    this.difficulty = difficulty.id;
    const custom = options.startLevel && options.startLevel >= 2 ? Math.floor(options.startLevel) : 0;
    this.startLevel = custom || difficulty.startLevel;
    this.customStart = custom;
    const startMultiplier = custom ? multiplierForStart(custom) : difficulty.startMultiplier;
    const speed = GAME_SPEEDS.find((s) => s.id === options.gameSpeed) ?? GAME_SPEEDS[1]!;
    const shared = options.secondCharacterId !== undefined;
    this.localSeats = shared ? 2 : 1;
    this.mode = shared && options.mode === 'deathmatch' ? 'deathmatch' : 'coop';
    this.recordsScores = this.mode === 'coop';
    this.world = new World({
      room: options.room,
      seed: Date.now() & 0xffff,
      playerCount: this.localSeats,
      characters: shared ? [options.characterId, options.secondCharacterId!] : [options.characterId],
      startLevel: this.startLevel,
      startMultiplier,
      devils: options.devils,
      speedFactor: speed.factor,
      mode: this.mode,
      ...(shared ? { tether: SHARED_SCREEN_TETHER } : {}),
    });
    if (options.snapshot) this.world.restore(options.snapshot);
    // Game speed scales the wall time per step, as the original scaled its
    // logic rate; the simulation itself stays a fixed 50Hz.
    this.stepMs = tickMsFor(options.gameSpeed);
  }

  get status(): SessionStatus {
    return this.world.gameOver ? 'ended' : 'running';
  }

  step(input: Input, camera: Camera, present: Presenter): void {
    const { world } = this;
    // The pointer aims in world space, so it must be unprojected first; a
    // pad aims relative to the player.
    const me = world.players[this.localPlayerIndex];
    const aim = input.aimWorld(camera, me?.x ?? 0, me?.y ?? 0);
    const commands: InputCommand[] = [input.buildCommand(aim.x, aim.y)];
    if (this.localSeats === 2) {
      const other = world.players[1];
      const aimB = input.aimWorldB(other?.x ?? 0, other?.y ?? 0);
      commands.push(input.buildCommandB(aimB.x, aimB.y));
    }
    world.step(commands);
    for (const event of world.sounds) present.playSound(event);
    world.sounds.length = 0;
  }

  stats(): string[] {
    return [];
  }

  dispose(): void {}
}
