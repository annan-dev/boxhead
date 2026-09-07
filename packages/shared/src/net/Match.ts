/**
 * Turning a `MatchConfig` into a world, the same way on both ends.
 *
 * A client that predicts ahead of the server must build its world from the
 * same options the server used, or its restore of the server's snapshot will
 * be right for a tick and wrong the moment it steps. Keeping the recipe here
 * means there is exactly one.
 */
import { World } from '../sim/World.js';
import type { ExtractedRoom } from '../art/ArtTypes.js';
import { DIFFICULTIES, GAME_SPEEDS, TICK_MS } from '../data/tuning.js';
import type { MatchConfig } from './Protocol.js';

export const DEFAULT_MATCH_CONFIG: Omit<MatchConfig, 'roomId' | 'seed'> = {
  mode: 'coop',
  difficulty: 'beginner',
  gameSpeed: 'normal',
  devils: true,
};

/** Wall milliseconds per tick at a configured game speed. */
export function tickMsFor(gameSpeed: string): number {
  const speed = GAME_SPEEDS.find((s) => s.id === gameSpeed) ?? GAME_SPEEDS[1]!;
  return TICK_MS / speed.factor;
}

/**
 * Build a match world with every seat present. The caller flips seats with
 * `World.setPlayerConnected` as people arrive and leave.
 */
export function worldFromConfig(
  room: ExtractedRoom,
  config: MatchConfig,
  maxPlayers: number,
  characters: string[] = [],
): World {
  const difficulty = DIFFICULTIES.find((d) => d.id === config.difficulty) ?? DIFFICULTIES[0]!;
  const speed = GAME_SPEEDS.find((s) => s.id === config.gameSpeed) ?? GAME_SPEEDS[1]!;
  return new World({
    room,
    seed: config.seed,
    mode: config.mode,
    playerCount: maxPlayers,
    characters,
    startLevel: difficulty.startLevel,
    startMultiplier: difficulty.startMultiplier,
    devils: config.devils,
    speedFactor: speed.factor,
  });
}
