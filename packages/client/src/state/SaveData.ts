/**
 * Local persistence: high scores, settings and progress.
 *
 * Everything lives in one versioned localStorage record. Reads are defensive
 * because the store can be unavailable (private windows, blocked site data) or
 * hold something written by an older build; in either case the game must open
 * with sensible defaults rather than fail.
 */

const STORAGE_KEY = 'boxhead.save.v1';

export interface RoomRecord {
  /** Best score achieved in this arena. */
  score: number;
  /** Highest level reached. */
  level: number;
  kills: number;
  /** Runs completed here. */
  plays: number;
}

export interface SaveState {
  version: 1;
  characterId: string;
  lastRoomId: string | null;
  /** One of the original's four presets; see DIFFICULTIES in the shared package. */
  difficulty: string;
  /** Slow / Normal / Fast; see GAME_SPEEDS. */
  gameSpeed: string;
  /** The original's Devils On/Off. */
  devils: boolean;
  volume: number;
  muted: boolean;
  /** Best result per arena, keyed by room id. */
  rooms: Record<string, RoomRecord>;
  /** Highest arena index unlocked; the rest are earned by clearing levels. */
  unlockedRooms: number;
  /** Last server address typed on the multiplayer screen. */
  netServer: string;
  /** Name shown to other players. */
  playerName: string;
}

function defaults(): SaveState {
  return {
    version: 1,
    characterId: 'swat',
    lastRoomId: null,
    difficulty: 'beginner',
    gameSpeed: 'normal',
    devils: true,
    volume: 0.7,
    muted: false,
    rooms: {},
    unlockedRooms: 1,
    netServer: '',
    playerName: '',
  };
}

/** Levels that must be reached in any arena to unlock the next one. */
export const UNLOCK_LEVEL = 4;

export class SaveData {
  private state: SaveState;

  constructor() {
    this.state = SaveData.load();
  }

  private static load(): SaveState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw) as Partial<SaveState>;
      if (parsed.version !== 1) return defaults();
      return { ...defaults(), ...parsed, rooms: parsed.rooms ?? {} };
    } catch {
      // Unavailable or corrupt storage must never stop the game starting.
      return defaults();
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Saving is a convenience; losing it should not interrupt play.
    }
  }

  get characterId(): string {
    return this.state.characterId;
  }

  get lastRoomId(): string | null {
    return this.state.lastRoomId;
  }

  get difficulty(): string {
    return this.state.difficulty;
  }

  setDifficulty(id: string): void {
    this.state.difficulty = id;
    this.persist();
  }

  get gameSpeed(): string {
    return this.state.gameSpeed;
  }

  setGameSpeed(id: string): void {
    this.state.gameSpeed = id;
    this.persist();
  }

  get devils(): boolean {
    return this.state.devils;
  }

  setDevils(value: boolean): void {
    this.state.devils = value;
    this.persist();
  }

  get volume(): number {
    return this.state.volume;
  }

  get muted(): boolean {
    return this.state.muted;
  }

  get unlockedRooms(): number {
    return this.state.unlockedRooms;
  }

  setCharacter(id: string): void {
    this.state.characterId = id;
    this.persist();
  }

  setLastRoom(id: string): void {
    this.state.lastRoomId = id;
    this.persist();
  }

  get netServer(): string {
    return this.state.netServer;
  }

  get playerName(): string {
    return this.state.playerName;
  }

  setNet(server: string, playerName: string): void {
    this.state.netServer = server.trim();
    this.state.playerName = playerName.trim().slice(0, 24);
    this.persist();
  }

  setVolume(value: number): void {
    this.state.volume = Math.max(0, Math.min(1, value));
    this.persist();
  }

  setMuted(value: boolean): void {
    this.state.muted = value;
    this.persist();
  }

  recordFor(roomId: string): RoomRecord {
    return this.state.rooms[roomId] ?? { score: 0, level: 0, kills: 0, plays: 0 };
  }

  isRoomUnlocked(index: number): boolean {
    return index < this.state.unlockedRooms;
  }

  /** Total of every arena's best score. */
  get totalBest(): number {
    return Object.values(this.state.rooms).reduce((sum, record) => sum + record.score, 0);
  }

  get bestOverall(): { score: number; roomId: string | null } {
    let best = 0;
    let roomId: string | null = null;
    for (const [id, record] of Object.entries(this.state.rooms)) {
      if (record.score > best) {
        best = record.score;
        roomId = id;
      }
    }
    return { score: best, roomId };
  }

  /**
   * Store the result of a run.
   * Returns whether it beat the previous best for that arena.
   */
  /**
   * Settings that make a run easier than the original's default take it out
   * of the high-score table: no devils, or the slow game speed. The menus
   * flag those options and the debrief says so.
   */
  get countsForHighScores(): boolean {
    return this.state.devils && this.state.gameSpeed !== 'slow';
  }

  /** Why the current settings do not count, for the menus. */
  get practiceReason(): string | null {
    const reasons: string[] = [];
    if (!this.state.devils) reasons.push('devils off');
    if (this.state.gameSpeed === 'slow') reasons.push('slow speed');
    return reasons.length > 0 ? reasons.join(', ') : null;
  }

  recordRun(
    roomId: string,
    roomIndex: number,
    result: { score: number; level: number; kills: number },
  ): { isBest: boolean; unlockedNext: boolean } {
    // A practice run is never banked: no score, no unlock.
    if (!this.countsForHighScores) return { isBest: false, unlockedNext: false };
    const previous = this.recordFor(roomId);
    const isBest = result.score > previous.score;
    this.state.rooms[roomId] = {
      score: Math.max(previous.score, result.score),
      level: Math.max(previous.level, result.level),
      kills: Math.max(previous.kills, result.kills),
      plays: previous.plays + 1,
    };

    // Reaching a decent level in an arena opens the next one along.
    let unlockedNext = false;
    if (result.level >= UNLOCK_LEVEL && roomIndex + 1 >= this.state.unlockedRooms) {
      this.state.unlockedRooms = Math.max(this.state.unlockedRooms, roomIndex + 2);
      unlockedNext = true;
    }
    this.persist();
    return { isBest, unlockedNext };
  }

  /** Clear every stored score and unlock, for the options screen. */
  reset(): void {
    const { characterId, volume, muted, difficulty, gameSpeed, devils } = this.state;
    this.state = { ...defaults(), characterId, volume, muted, difficulty, gameSpeed, devils };
    this.persist();
  }
}
