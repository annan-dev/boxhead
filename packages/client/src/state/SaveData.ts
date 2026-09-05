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
  volume: number;
  muted: boolean;
  /** Best result per arena, keyed by room id. */
  rooms: Record<string, RoomRecord>;
  /** Highest arena index unlocked; the rest are earned by clearing levels. */
  unlockedRooms: number;
}

function defaults(): SaveState {
  return {
    version: 1,
    characterId: 'swat',
    lastRoomId: null,
    volume: 0.7,
    muted: false,
    rooms: {},
    unlockedRooms: 1,
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
  recordRun(
    roomId: string,
    roomIndex: number,
    result: { score: number; level: number; kills: number },
  ): { isBest: boolean; unlockedNext: boolean } {
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
    const { characterId, volume, muted } = this.state;
    this.state = { ...defaults(), characterId, volume, muted };
    this.persist();
  }
}
