/**
 * Single player: the world lives here and nowhere else.
 */
import {
  DIFFICULTIES,
  GAME_SPEEDS,
  World,
  tickMsFor,
  type ExtractedRoom,
  type InputCommand,
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
}

export class LocalSession implements Session {
  readonly world: World;
  readonly room: ExtractedRoom;
  readonly localPlayerIndex = 0;
  readonly stepMs: number;
  readonly recordsScores = true;
  /** The preset the run opened on, for the record it leaves behind. */
  readonly difficulty: string;
  readonly startLevel: number;

  constructor(options: LocalOptions) {
    this.room = options.room;
    const difficulty = DIFFICULTIES.find((d) => d.id === options.difficulty) ?? DIFFICULTIES[0]!;
    this.difficulty = difficulty.id;
    this.startLevel = difficulty.startLevel;
    const speed = GAME_SPEEDS.find((s) => s.id === options.gameSpeed) ?? GAME_SPEEDS[1]!;
    this.world = new World({
      room: options.room,
      seed: Date.now() & 0xffff,
      playerCount: 1,
      characters: [options.characterId],
      startLevel: difficulty.startLevel,
      startMultiplier: difficulty.startMultiplier,
      devils: options.devils,
      speedFactor: speed.factor,
    });
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
