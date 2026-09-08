/**
 * Web Audio playback for the extracted samples.
 *
 * The simulation only ever requests sounds by name and position; it never
 * touches an AudioContext, because it also has to run headless. This module
 * turns those requests into positioned, rate-limited playback.
 *
 * Browsers refuse to start an AudioContext before a user gesture, so the
 * context is created suspended and resumed on the first interaction.
 */

/** Concurrency limits per sound, so a chain explosion cannot become a wall of noise. */
import { assetUrl } from '../assets/AssetSource.js';

const VOICE_LIMITS: Record<string, number> = {
  'Weapon.UZI.Fire': 3,
  'Weapon.Pistol.Fire': 3,
  'Creature.Zombie.Hit': 4,
  'Creature.HitFloor': 4,
  'Effect.Explosion': 4,
};
const DEFAULT_VOICE_LIMIT = 6;

/** Minimum gap between two instances of the same sound, in milliseconds. */
const RETRIGGER_MS = 28;

export interface Listener {
  x: number;
  y: number;
  /** Half the visible width; sets how quickly sound pans to the edges. */
  halfWidth: number;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly active = new Map<string, number>();
  private readonly lastStart = new Map<string, number>();
  private ambienceTimer = 0;
  private ready = false;

  /** 0-1; persisted by the caller if desired. */
  volume = 0.7;
  muted = false;

  constructor(private readonly basePath = 'sounds') {}

  /**
   * Create the context and load every sample. Safe to call before any user
   * gesture: the context starts suspended and `resume()` finishes the job.
   */
  async init(names: readonly string[]): Promise<void> {
    if (this.context) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const context = new Ctor();
    this.context = context;
    this.master = context.createGain();
    // Settings may already have been applied before the context existed.
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(context.destination);

    const load = async (name: string): Promise<void> => {
      try {
        const response = await fetch(assetUrl(`${this.basePath}/${encodeURIComponent(name)}.mp3`));
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        this.buffers.set(name, await context.decodeAudioData(bytes));
      } catch {
        // A missing or undecodable sample should never take the game down.
      }
    };
    await Promise.all(names.map(load));
    this.ready = true;
  }

  /** Call from a real user gesture. Resolves true once the context is running. */
  async resume(): Promise<boolean> {
    if (!this.context) return false;
    try {
      await this.context.resume();
    } catch {
      return false;
    }
    return this.context.state === 'running';
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }

  get loaded(): boolean {
    return this.ready;
  }

  /** Play one positioned sound. Silently no-ops if the sample is unavailable. */
  play(name: string, x: number, y: number, rate: number, listener: Listener): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || this.muted || context.state !== 'running') return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;

    const now = performance.now();
    const last = this.lastStart.get(name) ?? -Infinity;
    if (now - last < RETRIGGER_MS) return;

    const limit = VOICE_LIMITS[name] ?? DEFAULT_VOICE_LIMIT;
    const playing = this.active.get(name) ?? 0;
    if (playing >= limit) return;

    // Distance attenuation, then a hard cutoff well outside the view.
    const dx = x - listener.x;
    const dy = y - listener.y;
    const distance = Math.hypot(dx, dy);
    if (distance > listener.halfWidth * 3) return;
    const gainValue = 1 / (1 + (distance / 260) ** 2);
    if (gainValue < 0.02) return;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;

    const gain = context.createGain();
    gain.gain.value = gainValue;

    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-0.85, Math.min(0.85, dx / Math.max(1, listener.halfWidth)));

    source.connect(gain).connect(panner).connect(master);
    source.start();

    this.active.set(name, playing + 1);
    this.lastStart.set(name, now);
    source.onended = () => {
      this.active.set(name, Math.max(0, (this.active.get(name) ?? 1) - 1));
    };
  }

  /**
   * Occasional zombie groans, scaled by how many are on the field.
   * Purely cosmetic, so it lives here rather than in the simulation.
   */
  updateAmbience(enemyCount: number, listener: Listener, rng: () => number): void {
    if (enemyCount <= 0 || !this.ready) return;
    this.ambienceTimer -= 1;
    if (this.ambienceTimer > 0) return;
    // More zombies, more frequent groans, with a floor so it never machine-guns.
    this.ambienceTimer = Math.max(40, 260 - enemyCount * 6) + Math.floor(rng() * 90);
    const which = 1 + Math.floor(rng() * 4);
    const angle = rng() * Math.PI * 2;
    const distance = 90 + rng() * 220;
    this.play(
      `Creature.Zombie.Ambience.${which}`,
      listener.x + Math.cos(angle) * distance,
      listener.y + Math.sin(angle) * distance,
      0.92 + rng() * 0.16,
      listener,
    );
  }
}

/** Every sample the simulation can ask for, plus the ambience set. */
export const SOUND_NAMES = [
  'CLICK',
  'Creature.HitFloor',
  'Creature.Player.Scream.1',
  'Creature.Player.Scream.2',
  'Creature.Zombie.Ambience.1',
  'Creature.Zombie.Ambience.2',
  'Creature.Zombie.Ambience.3',
  'Creature.Zombie.Ambience.4',
  'Creature.Zombie.Attack',
  'Creature.Zombie.Hit',
  'Effect.Explosion',
  'Object.Barrel.Place',
  'Object.Mine.Detonate',
  'Object.Pickup',
  'Shot.Grenade.Bounce',
  'Shot.HitWall.1',
  'Shot.HitWall.2',
  'Shot.HitWall.3',
  'Shot.Rocket.Fire',
  'Weapon.Mine.Place',
  'Weapon.Pistol.Fire',
  'Weapon.Railgun.Fire',
  'Weapon.Rocket.Fire',
  'Weapon.ShotGun.Fire',
  'Weapon.UZI.Fire',
  'World.End',
] as const;
