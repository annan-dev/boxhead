/**
 * Single player: the world lives here and nowhere else.
 */
import {
  DIFFICULTIES,
  GAME_SPEEDS,
  World,
  multiplierForStart,
  tickMsFor,
  type ExtractedRoom,
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
  /** A practice start on this level instead of the preset's; the multiplier follows the presets' curve. */
  startLevel?: number;
}

export { multiplierForStart } from '@boxhead/shared';

export class LocalSession implements Session {
  readonly world: World;
  readonly room: ExtractedRoom;
  readonly localPlayerIndex = 0;
  readonly stepMs: number;
  readonly recordsScores = true;
  /** The preset the run opened on, for the record it leaves behind. */
  readonly difficulty: string;
  readonly startLevel: number;
  /** The custom level the run opened on, or 0 when the preset decided. */
  readonly customStart: number;

  constructor(options: LocalOptions) {
    this.room = options.room;
    const difficulty = DIFFICULTIES.find((d) => d.id === options.difficulty) ?? DIFFICULTIES[0]!;
    this.difficulty = difficulty.id;
    const custom = options.startLevel && options.startLevel >= 2 ? Math.floor(options.startLevel) : 0;
    this.startLevel = custom || difficulty.startLevel;
    this.customStart = custom;
    const startMultiplier = custom ? multiplierForStart(custom) : difficulty.startMultiplier;
    const speed = GAME_SPEEDS.find((s) => s.id === options.gameSpeed) ?? GAME_SPEEDS[1]!;
    this.world = new World({
      room: options.room,
      seed: Date.now() & 0xffff,
      playerCount: 1,
      characters: [options.characterId],
      startLevel: this.startLevel,
      startMultiplier,
      devils: options.devils,
      speedFactor: speed.factor,
    });
    if (options.snapshot) this.world.restore(options.snapshot);
    // A fresh run above level 1, or one picked back up, is told what wave it is on.
    this.world.announceOpening();
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
    world.step(commands);
    for (const event of world.sounds) present.playSound(event);
    world.sounds.length = 0;
  }

  stats(): string[] {
    return [];
  }

  dispose(): void {}
}
