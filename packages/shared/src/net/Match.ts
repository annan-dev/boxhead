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
  startLevel: 0,
};

/** A practice start may open anywhere from here to here. */
export const PRACTICE_START_MIN = 2;
export const PRACTICE_START_MAX = 60;

/** The practice level a config asks for, or 0 when the preset decides. */
export function practiceStart(config: { startLevel?: number }): number {
  const level = Math.floor(config.startLevel ?? 0);
  return Number.isFinite(level) && level >= PRACTICE_START_MIN && level <= PRACTICE_START_MAX ? level : 0;
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
  const custom = practiceStart(config);
  return new World({
    room,
    seed: config.seed,
    mode: config.mode,
    playerCount: maxPlayers,
    characters,
    startLevel: custom || difficulty.startLevel,
    startMultiplier: custom ? multiplierForStart(custom) : difficulty.startMultiplier,
    devils: config.devils,
    speedFactor: speed.factor,
  });
}

/** The world a match plays, with its opening wave announced. */
export function matchWorld(
  room: ExtractedRoom,
  config: MatchConfig,
  maxPlayers: number,
  characters: string[] = [],
): World {
  const world = worldFromConfig(room, config, maxPlayers, characters);
  world.announceOpening();
  return world;
}
