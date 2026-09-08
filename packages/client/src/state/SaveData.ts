/**
 * Local persistence: high scores, settings and progress.
 *
 * Everything lives in one versioned localStorage record. Reads are defensive
 * because the store can be unavailable (private windows, blocked site data) or
 * hold something written by an older build; in either case the game must open
 * with sensible defaults rather than fail.
 */

import { levelDef } from '@boxhead/shared';

const STORAGE_KEY = 'boxhead.save.v1';
/** A run parked mid-wave, kept apart from the save so its size never bloats it. */
const RUN_KEY = 'boxhead.run.v1';

export interface SavedRun {
  roomId: string;
  characterId: string;
  difficulty: string;
  gameSpeed: string;
  devils: boolean;
  countsForHighScores: boolean;
  practiceReason: string | null;
  /** A custom start level the run opened on, or 0. */
  startLevel?: number;
  /** The world, as `World.snapshot()` wrote it. */
  snapshot: unknown;
  /** For the title's label. */
  level: number;
  score: number;
  savedAt: number;
}

export interface RoomRecord {
  /** Best score achieved in this arena. */
  score: number;
  /** Highest level reached. */
  level: number;
  kills: number;
  /** Runs completed here. */
  plays: number;
  /** Difficulty the best score was set on, so a Nightmare start is not mistaken for skill. */
  difficulty?: string | undefined;
  /** Highest multiplier reached in any run here. */
  peakMultiplier?: number;
  /** Longest run here, in whole seconds of play. */
  seconds?: number;
  /** Best score and level per difficulty preset, so presets do not compete. */
  byDifficulty?: Record<string, PresetRecord>;
}

/** A room's record at one preset: the bests, and a tally that outlives the history. */
export interface PresetRecord {
  score: number;
  level: number;
  /** Runs finished here at this preset. */
  runs?: number;
  /** The last eight runs' lengths in seconds, for "usually". */
  times?: number[];
}

/** One finished run, for the history list. */
export interface RunEntry {
  roomId: string;
  difficulty: string;
  score: number;
  level: number;
  kills: number;
  seconds: number;
  at: number;
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
  /** Menu music level, 0-1, on top of the master volume. */
  music: number;
  muted: boolean;
  /** Best result per arena, keyed by room id. */
  rooms: Record<string, RoomRecord>;
  /** Highest arena index unlocked; the rest are earned by clearing levels. */
  unlockedRooms: number;
  /** Last server address typed on the multiplayer screen. */
  netServer: string;
  /** Name shown to other players. */
  playerName: string;
  /** Screen shake, 0-1 of the designed amount. */
  shake?: number | undefined;
  /** Full-screen flashes on blasts; off for players they bother. */
  flashes?: boolean | undefined;
  /** HUD size, 0.8-1.4. */
  hudScale?: number | undefined;
  /** Gamepad rumble. */
  rumble?: boolean | undefined;
  /** Key bindings by action; absent actions use the defaults. */
  keys?: Record<string, string[]> | undefined;
  /** Gamepad buttons by action; absent actions use the defaults. */
  pad?: Record<string, number[]> | undefined;
  /** One-time tips already shown. */
  tipsSeen?: string[] | undefined;
  /** Whether the one-time tips show at all. */
  tips?: boolean | undefined;
  /** The last few runs, newest first. */
  history?: RunEntry[] | undefined;
  /** A custom starting level for practice; 0 means the difficulty preset decides. */
  startLevel?: number | undefined;
  /** The Options tab last opened. */
  optionsTab?: string | undefined;
  /** The camera leans toward the aim. */
  cameraLead?: boolean | number | undefined;
  /** Markers outlined and the heartbeat framed, for players who need more than colour. */
  highContrast?: boolean | undefined;
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
    music: 0.6,
    muted: false,
    rooms: {},
    unlockedRooms: 1,
    netServer: '',
    playerName: '',
    shake: 1,
    flashes: true,
    hudScale: 1,
    rumble: true,
  };
}

/**
 * Levels that must be cleared in an arena to unlock the next one. Beginner
 * starts at level 1 and needs level 4; a harder preset starts later and needs
 * the same three clears past its own start, so no preset unlocks by dying.
 */
export const UNLOCK_LEVEL = 4;
export const UNLOCK_CLEARS = UNLOCK_LEVEL - 1;

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

  get music(): number {
    return this.state.music ?? 0.6;
  }

  setMusic(value: number): void {
    this.state.music = Math.max(0, Math.min(1, value));
    this.persist();
  }

  get muted(): boolean {
    return this.state.muted;
  }

  get shake(): number {
    return this.state.shake ?? 1;
  }

  setShake(value: number): void {
    this.state.shake = Math.max(0, Math.min(1, value));
    this.persist();
  }

  get flashes(): boolean {
    return this.state.flashes ?? true;
  }

  setFlashes(value: boolean): void {
    this.state.flashes = value;
    this.persist();
  }

  get hudScale(): number {
    return this.state.hudScale ?? 1;
  }

  setHudScale(value: number): void {
    this.state.hudScale = Math.max(0.8, Math.min(1.4, value));
    this.persist();
  }

  get rumble(): boolean {
    return this.state.rumble ?? true;
  }

  /** How far the camera leans toward the aim, 0 to 1; an older save's boolean reads as all or nothing. */
  get cameraLead(): number {
    const value = this.state.cameraLead;
    if (typeof value === 'number') return Math.max(0, Math.min(1, value));
    return value === false ? 0 : 1;
  }

  setCameraLead(value: number): void {
    this.state.cameraLead = Math.max(0, Math.min(1, value));
    this.persist();
  }

  get highContrast(): boolean {
    return this.state.highContrast ?? false;
  }

  setHighContrast(value: boolean): void {
    this.state.highContrast = value;
    this.persist();
  }

  get keys(): Record<string, string[]> {
    return this.state.keys ?? {};
  }

  get tips(): boolean {
    return this.state.tips ?? true;
  }

  setTips(value: boolean): void {
    this.state.tips = value;
    this.persist();
  }

  hasSeenTip(id: string): boolean {
    return (this.state.tipsSeen ?? []).includes(id);
  }

  markTip(id: string): void {
    if (this.hasSeenTip(id)) return;
    this.state.tipsSeen = [...(this.state.tipsSeen ?? []), id];
    this.persist();
  }

  /** Forget every tip so they show again, for the options screen. */
  resetTips(): void {
    delete this.state.tipsSeen;
    this.persist();
  }

  /** The run parked by the last session, if any. */
  get savedRun(): SavedRun | null {
    try {
      const raw = localStorage.getItem(RUN_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SavedRun>;
      if (!parsed.roomId || !parsed.snapshot || typeof parsed.level !== 'number') return null;
      return parsed as SavedRun;
    } catch {
      return null;
    }
  }

  parkRun(run: SavedRun): void {
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify(run));
    } catch {
      // Storage can be full or blocked; the run simply is not parked.
    }
  }

  clearSavedRun(): void {
    try {
      localStorage.removeItem(RUN_KEY);
    } catch {
      // Nothing to do.
    }
  }

  /**
   * Bind an action to a key: replacing what it had, or adding an alternate
   * beside it. A key serves one action only, so it is taken from wherever
   * else it was.
   */
  setKey(action: string, code: string, defaults: Record<string, string[]>, add = false): void {
    const keys = { ...this.keys };
    for (const other of Object.keys(defaults)) {
      const current = keys[other] ?? defaults[other] ?? [];
      keys[other] = current.filter((c) => c !== code);
    }
    const kept = add ? (keys[action] ?? []) : [];
    keys[action] = [...kept.filter((c) => c !== code), code].slice(-2);
    this.state.keys = keys;
    this.persist();
  }

  resetKeys(): void {
    delete this.state.keys;
    delete this.state.pad;
    this.persist();
  }

  get pad(): Record<string, number[]> {
    return this.state.pad ?? {};
  }

  /** Bind a pad action to one button; a button serves one action only. */
  setPadButton(action: string, button: number, defaults: Record<string, number[]>): void {
    const pad = { ...this.pad };
    for (const other of Object.keys(defaults)) {
      const current = pad[other] ?? defaults[other] ?? [];
      pad[other] = current.filter((b) => b !== button);
    }
    pad[action] = [button];
    this.state.pad = pad;
    this.persist();
  }

  setRumble(value: boolean): void {
    this.state.rumble = value;
    this.persist();
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

  /** The best on a room at one difficulty; older saves only know the overall best. */
  bestAt(roomId: string, difficulty: string): { score: number; level: number } {
    const record = this.recordFor(roomId);
    const at = record.byDifficulty?.[difficulty];
    if (at) return at;
    if (record.difficulty === difficulty || (!record.difficulty && difficulty === 'beginner')) {
      return { score: record.score, level: record.level };
    }
    return { score: 0, level: 0 };
  }

  get history(): RunEntry[] {
    return this.state.history ?? [];
  }

  /**
   * What the player's own runs say about a room at a preset: how many, the
   * best level, and the median time. Nothing when they have not played it.
   */
  recordLine(roomId: string, difficulty: string): { runs: number; bestLevel: number; medianSeconds: number } | null {
    const record = this.recordFor(roomId).byDifficulty?.[difficulty];
    if (!record) return null;
    const times = [...(record.times ?? [])].sort((a, b) => a - b);
    return {
      runs: record.runs ?? 0,
      bestLevel: record.level,
      medianSeconds: times.length > 0 ? times[Math.floor(times.length / 2)]! : 0,
    };
  }

  /** "level 15, between Intermediate and Expert", "off", or where a preset opens. */
  static startLevelLabel(level: number, presets: Array<{ name: string; startLevel: number }>): string {
    if (!level) return 'off';
    const sorted = [...presets].sort((a, b) => a.startLevel - b.startLevel);
    const exact = sorted.find((d) => d.startLevel === level);
    if (exact) return `level ${level}, where ${exact.name} opens`;
    const below = [...sorted].reverse().find((d) => d.startLevel < level);
    const above = sorted.find((d) => d.startLevel > level);
    if (below && above) return `level ${level}, between ${below.name} and ${above.name}`;
    if (above) return `level ${level}, before ${above.name}`;
    return `level ${level}, past ${below?.name ?? 'Nightmare'}`;
  }

  /**
   * A death inside thirty seconds on a run that cleared fewer than three
   * waves: the wave was the lesson, so practising it should lead.
   */
  static isQuickDeath(
    result: { practice: string | null; seconds: number; levelsCleared: number; level: number },
    /** What the player has done here at this preset before; a veteran is not sent to practise. */
    record: { bestLevel: number } | null = null,
    startLevel = 1,
  ): boolean {
    if (result.practice || result.seconds >= 30 || result.level < 2) return false;
    if (record && record.bestLevel >= startLevel + UNLOCK_CLEARS) return false;
    return result.levelsCleared < UNLOCK_CLEARS;
  }

  /** Where a preset opens, for a room the player has not tried at it. */
  static presetLine(difficulty: { name: string; startLevel: number; startMultiplier: number }, devils = true): string {
    const wave = levelDef(difficulty.startLevel);
    const count = devils && wave.devilTotal > 0
      ? `${wave.zombieTotal} zombies, ${wave.devilTotal} ${wave.devilTotal === 1 ? 'devil' : 'devils'}`
      : `${wave.zombieTotal} zombies`;
    return `${difficulty.name} opens at level ${difficulty.startLevel} with x${difficulty.startMultiplier} · ${count}`;
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
    return this.state.devils && this.state.gameSpeed !== 'slow' && this.startLevel === 0;
  }

  /** A practice start: any level from 2 to 60, or 0 for the preset's own. */
  get startLevel(): number {
    const level = Math.floor(this.state.startLevel ?? 0);
    return Number.isFinite(level) && level >= 2 && level <= 60 ? level : 0;
  }

  setStartLevel(level: number): void {
    this.state.startLevel = Math.max(0, Math.min(60, Math.floor(level)));
    this.persist();
  }

  get optionsTab(): string {
    return this.state.optionsTab ?? 'game';
  }

  setOptionsTab(tab: string): void {
    this.state.optionsTab = tab;
    this.persist();
  }

  /** Why the current settings do not count, for the menus. */
  get practiceReason(): string | null {
    const reasons: string[] = [];
    if (!this.state.devils) reasons.push('devils off');
    if (this.state.gameSpeed === 'slow') reasons.push('slow speed');
    if (this.startLevel > 0) reasons.push(`custom start at level ${this.startLevel}`);
    return reasons.length > 0 ? reasons.join(', ') : null;
  }

  recordRun(
    roomId: string,
    roomIndex: number,
    result: {
      score: number;
      level: number;
      kills: number;
      /** The level the run opened on, from its difficulty preset. */
      startLevel?: number;
      difficulty?: string | undefined;
      peakMultiplier?: number;
      seconds?: number;
    },
    /** Eligibility as it stood when the run began; options may change mid-run. */
    counts = this.countsForHighScores,
    /** How many arenas exist, so the last one has nothing to unlock. */
    roomCount = Number.POSITIVE_INFINITY,
  ): { isBest: boolean; unlockedNext: boolean } {
    // A practice run is never banked: no score, no unlock.
    if (!counts) return { isBest: false, unlockedNext: false };
    const previous = this.recordFor(roomId);
    const difficulty = result.difficulty ?? this.state.difficulty;
    const previousAt = this.bestAt(roomId, difficulty);
    // A best is beaten within its own preset; a Nightmare start does not
    // erase a Beginner record, nor the other way round.
    const isBest = result.score > previousAt.score;
    const byDifficulty = { ...(previous.byDifficulty ?? {}) };
    const previousRecord = previous.byDifficulty?.[difficulty];
    byDifficulty[difficulty] = {
      score: Math.max(previousAt.score, result.score),
      level: Math.max(previousAt.level, result.level),
      runs: (previousRecord?.runs ?? 0) + 1,
      times: [...(previousRecord?.times ?? []), result.seconds ?? 0].slice(-8),
    };
    this.state.history = [
      {
        roomId,
        difficulty,
        score: result.score,
        level: result.level,
        kills: result.kills,
        seconds: result.seconds ?? 0,
        at: Date.now(),
      },
      ...this.history,
    ].slice(0, 10);
    this.state.rooms[roomId] = {
      byDifficulty,
      score: Math.max(previous.score, result.score),
      level: Math.max(previous.level, result.level),
      kills: Math.max(previous.kills, result.kills),
      plays: previous.plays + 1,
      difficulty: result.score > previous.score ? difficulty : previous.difficulty,
      peakMultiplier: Math.max(previous.peakMultiplier ?? 0, result.peakMultiplier ?? 0),
      seconds: Math.max(previous.seconds ?? 0, result.seconds ?? 0),
    };

    // Clearing a few waves in an arena opens the next one along, measured
    // from wherever the difficulty started the run.
    let unlockedNext = false;
    const needed = (result.startLevel ?? 1) + UNLOCK_CLEARS;
    if (result.level >= needed && roomIndex + 1 >= this.state.unlockedRooms && roomIndex + 1 < roomCount) {
      this.state.unlockedRooms = Math.max(this.state.unlockedRooms, roomIndex + 2);
      unlockedNext = true;
    }
    this.persist();
    return { isBest, unlockedNext };
  }

  /**
   * The progress as a code the player can carry to another copy of the game:
   * the Pages site and the downloaded file keep separate storage, and a
   * browser's site data can be cleared. Scores, unlocks and history travel;
   * settings stay where they are.
   */
  exportCode(): string {
    const { rooms, unlockedRooms, history } = this.state;
    const json = JSON.stringify({ v: 1, rooms, unlockedRooms, history });
    return `BH1.${btoa(unescape(encodeURIComponent(json)))}`;
  }

  /**
   * Take a code in. Bests merge upward, unlocks take the higher, history is
   * combined; nothing already earned is lost. Returns false for a bad code.
   */
  importCode(code: string): boolean {
    const trimmed = code.trim();
    if (!trimmed.startsWith('BH1.')) return false;
    let parsed: Partial<Pick<SaveState, 'rooms' | 'unlockedRooms' | 'history' | 'tipsSeen'>> & { v?: number };
    try {
      parsed = JSON.parse(decodeURIComponent(escape(atob(trimmed.slice(4)))));
    } catch {
      return false;
    }
    if (parsed.v !== 1 || !parsed.rooms || typeof parsed.rooms !== 'object') return false;
    // Nothing from outside reaches a best unchecked: every number must be a
    // finite count, or the record is left out.
    const count = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    const cleanRecord = (raw: unknown): RoomRecord | null => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const score = count(r['score']);
      const level = count(r['level']);
      const kills = count(r['kills']);
      const plays = count(r['plays']);
      if (score === null || level === null || kills === null || plays === null) return null;
      const byDifficulty: Record<string, PresetRecord> = {};
      if (r['byDifficulty'] && typeof r['byDifficulty'] === 'object') {
        for (const [difficulty, best] of Object.entries(r['byDifficulty'] as Record<string, unknown>)) {
          if (!best || typeof best !== 'object') continue;
          const b = best as Record<string, unknown>;
          const bs = count(b['score']);
          const bl = count(b['level']);
          if (bs === null || bl === null) continue;
          const times = Array.isArray(b['times']) ? b['times'].map(count).filter((t): t is number => t !== null).slice(-8) : [];
          byDifficulty[difficulty] = { score: bs, level: bl, runs: count(b['runs']) ?? times.length, times };
        }
      }
      return {
        score,
        level,
        kills,
        plays,
        difficulty: typeof r['difficulty'] === 'string' ? r['difficulty'] : undefined,
        peakMultiplier: count(r['peakMultiplier']) ?? 0,
        seconds: count(r['seconds']) ?? 0,
        byDifficulty,
      };
    };
    const rooms = { ...this.state.rooms };
    for (const [id, rawRecord] of Object.entries(parsed.rooms as Record<string, unknown>)) {
      const record = cleanRecord(rawRecord);
      if (!record) continue;
      const mine = rooms[id];
      if (!mine) {
        rooms[id] = record;
        continue;
      }
      const byDifficulty = { ...(mine.byDifficulty ?? {}) };
      for (const [difficulty, best] of Object.entries(record.byDifficulty ?? {})) {
        const have = byDifficulty[difficulty];
        byDifficulty[difficulty] = {
          score: Math.max(have?.score ?? 0, best.score),
          level: Math.max(have?.level ?? 0, best.level),
          runs: (have?.runs ?? 0) + (best.runs ?? 0),
          times: [...(have?.times ?? []), ...(best.times ?? [])].slice(-8),
        };
      }
      rooms[id] = {
        score: Math.max(mine.score, record.score),
        level: Math.max(mine.level, record.level),
        kills: Math.max(mine.kills, record.kills),
        plays: mine.plays + record.plays,
        difficulty: record.score > mine.score ? record.difficulty : mine.difficulty,
        peakMultiplier: Math.max(mine.peakMultiplier ?? 0, record.peakMultiplier ?? 0),
        seconds: Math.max(mine.seconds ?? 0, record.seconds ?? 0),
        byDifficulty,
      };
    }
    this.state.rooms = rooms;
    this.state.unlockedRooms = Math.max(this.state.unlockedRooms, Number(parsed.unlockedRooms) || 1);
    const history = [...(Array.isArray(parsed.history) ? parsed.history : []), ...this.history]
      .filter(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          typeof entry.roomId === 'string' &&
          count(entry.at) !== null &&
          count(entry.score) !== null &&
          count(entry.level) !== null,
      )
      .map((entry) => ({
        roomId: entry.roomId,
        difficulty: typeof entry.difficulty === 'string' ? entry.difficulty : 'beginner',
        score: count(entry.score)!,
        level: count(entry.level)!,
        kills: count(entry.kills) ?? 0,
        seconds: count(entry.seconds) ?? 0,
        at: count(entry.at)!,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 10);
    this.state.history = history;
    this.persist();
    return true;
  }

  /** The progress code as a link to this page, for carrying it in one click. */
  exportLink(): string {
    // From a file on disk the origin is "null" in some browsers; the address
    // bar's own text is always right.
    const base = window.location.href.split('#')[0]!;
    return `${base}#progress=${encodeURIComponent(this.exportCode())}`;
  }

  /** Clear every stored score and unlock, for the options screen. */
  reset(): void {
    const { characterId, volume, music, muted, difficulty, gameSpeed, devils, shake, flashes, hudScale, rumble, keys } = this.state;
    this.state = { ...defaults(), characterId, volume, music, muted, difficulty, gameSpeed, devils, shake, flashes, hudScale, rumble, keys };
    this.persist();
  }
}
