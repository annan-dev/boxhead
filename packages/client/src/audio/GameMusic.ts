/**
 * The in-game bed: a score that follows the fight.
 *
 * The original has no music in play, only the zombie ambience, and a full
 * tune would fight the gunfire. This is a bed instead: a low drone that opens
 * up as the pressure rises, a pulse on the beat that quickens and hardens with
 * it, hats and a snare that only arrive when the wave is on top of the
 * player, and a dissonant pad held under a real crisis. The host feeds it a
 * single number each tick, the tension, from how many creatures are near,
 * how high the multiplier has climbed and how hurt the player is.
 *
 * Built from oscillators and noise like the menu track, so it loops forever,
 * weighs nothing and plays from a file on disk. Scheduling runs a little
 * ahead of the clock, the standard way to keep Web Audio timing exact.
 */

const LOOKAHEAD_S = 0.3;
const TICK_MS = 80;

function hz(semisFromA4: number): number {
  return 440 * Math.pow(2, semisFromA4 / 12);
}

/** D2, F2, C2, D2: the roots of a four-bar phrase in D minor. */
const ROOTS = [-31, -28, -33, -31];

export class GameMusic {
  private context: AudioContext | null = null;
  private out: GainNode | null = null;
  private level: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private drone: OscillatorNode[] = [];
  private timer = 0;
  private nextBeat = 0;
  private beatTime = 0;
  private scene: 'off' | 'play' | 'ducked' = 'off';
  private volume = 0.6;
  /** 0 calm to 1 overwhelmed; smoothed by `setTension`. */
  private tension = 0;
  private padUntil = 0;

  constructor(private readonly bus: () => { context: AudioContext; destination: AudioNode } | null) {}

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    this.applyLevel(0.2);
  }

  setScene(scene: 'off' | 'play' | 'ducked'): void {
    if (this.scene === scene) return;
    this.scene = scene;
    if (scene !== 'off') this.ensureRunning();
    this.applyLevel(scene === 'off' ? 0.9 : 1.2);
  }

  /**
   * Feed the fight's pressure. Rises quickly and falls slowly, so a lull
   * after a burst still carries the weight of it.
   */
  setTension(value: number): void {
    const target = Math.max(0, Math.min(1, value));
    const rate = target > this.tension ? 0.08 : 0.012;
    this.tension += (target - this.tension) * rate;
  }

  private applyLevel(seconds: number): void {
    if (!this.context || !this.level) return;
    const base = this.volume * 0.5;
    const target = this.scene === 'off' ? 0 : this.scene === 'ducked' ? base * 0.3 : base;
    const now = this.context.currentTime;
    this.level.gain.cancelScheduledValues(now);
    this.level.gain.setValueAtTime(this.level.gain.value, now);
    this.level.gain.linearRampToValueAtTime(target, now + seconds);
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    if (!this.context) {
      const bus = this.bus();
      if (!bus || bus.context.state !== 'running') return;
      this.build(bus.context, bus.destination);
    }
    const context = this.context!;
    if (context.state !== 'running') return;
    if (this.scene === 'off' && this.level!.gain.value < 0.001) {
      this.stopDrone();
      window.clearInterval(this.timer);
      this.timer = 0;
      this.beatTime = 0;
      return;
    }
    if (this.drone.length === 0) this.startDrone();

    // The drone opens with the tension: brighter and louder as it climbs.
    const now = context.currentTime;
    const t = this.tension;
    this.droneFilter!.frequency.setTargetAtTime(110 + t * t * 900, now, 0.4);
    this.droneGain!.gain.setTargetAtTime(0.1 + t * 0.12, now, 0.5);

    if (this.beatTime === 0) {
      this.beatTime = now + 0.05;
      this.nextBeat = 0;
    }
    // The beat quickens with the tension: 72 to 132 a minute.
    while (this.beatTime < now + LOOKAHEAD_S) {
      this.scheduleBeat(this.beatTime, this.nextBeat);
      const bpm = 72 + this.tension * 60;
      this.beatTime += 60 / bpm;
      this.nextBeat += 1;
    }
  }

  private build(context: AudioContext, destination: AudioNode): void {
    this.context = context;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.3;
    const shelf = context.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 3500;
    shelf.gain.value = -8;
    this.level = context.createGain();
    this.level.gain.value = 0;
    this.out = context.createGain();
    this.out.gain.value = 0.6;
    this.out.connect(compressor).connect(shelf).connect(this.level).connect(destination);

    const length = Math.floor(context.sampleRate * 2);
    this.noise = context.createBuffer(1, length, context.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 0x1f2e3d4c;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    this.applyLevel(1.2);
  }

  private startDrone(): void {
    const context = this.context!;
    this.droneFilter = context.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 120;
    this.droneFilter.Q.value = 1.4;
    this.droneGain = context.createGain();
    this.droneGain.gain.value = 0.0001;
    this.droneGain.gain.exponentialRampToValueAtTime(0.1, context.currentTime + 2.5);
    this.droneFilter.connect(this.droneGain).connect(this.out!);
    for (const [type, semis, detune] of [['sawtooth', -31, -6], ['sawtooth', -31, 6], ['sine', -43, 0], ['triangle', -24, 3]] as const) {
      const osc = context.createOscillator();
      osc.type = type;
      osc.frequency.value = hz(semis);
      osc.detune.value = detune;
      osc.connect(this.droneFilter);
      osc.start();
      this.drone.push(osc);
    }
  }

  private stopDrone(): void {
    if (!this.context || this.drone.length === 0) return;
    const at = this.context.currentTime;
    this.droneGain!.gain.cancelScheduledValues(at);
    this.droneGain!.gain.setValueAtTime(this.droneGain!.gain.value, at);
    this.droneGain!.gain.linearRampToValueAtTime(0, at + 0.5);
    for (const osc of this.drone) osc.stop(at + 0.6);
    this.drone = [];
  }

  private scheduleBeat(at: number, beat: number): void {
    const t = this.tension;
    const bar = Math.floor(beat / 4);
    const inBar = beat % 4;
    const root = hz(ROOTS[bar % 4]!);

    // The pulse: a soft sub on every beat when calm, a hard kick when not.
    const weight = inBar === 0 ? 1 : inBar === 2 ? 0.8 : 0.55;
    this.kick(at, (0.35 + t * 0.6) * weight, 90 + t * 60, 0.25 + t * 0.2);

    // A plucked bass on the root once the fight has a pulse of its own.
    if (t > 0.25 && (inBar === 0 || inBar === 2 || (t > 0.6 && inBar === 3))) {
      this.bass(at, inBar === 3 ? root * 1.5 : root, 0.22, 0.12 + t * 0.12, 300 + t * 900);
    }
    // Hats arrive on the off-beats under real pressure; snare on two and four past it.
    if (t > 0.45) {
      this.burst(at + 0.5 * (60 / (72 + t * 60)), 0.03, 6500, 0.03 + (t - 0.45) * 0.1, 'highpass');
    }
    if (t > 0.7 && (inBar === 1 || inBar === 3)) {
      this.burst(at, 0.12, 1700, 0.12 + (t - 0.7) * 0.5, 'bandpass');
    }
    // Under a crisis, a held minor-second pad every four bars.
    if (t > 0.8 && inBar === 0 && bar % 4 === 0 && at > this.padUntil) {
      this.pad(at, 8);
      this.padUntil = at + 8;
    }
  }

  private kick(at: number, level: number, from: number, length: number): void {
    const context = this.context!;
    const osc = context.createOscillator();
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(38, at + 0.1);
    const gain = context.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    osc.connect(gain).connect(this.out!);
    osc.start(at);
    osc.stop(at + length + 0.03);
    if (this.tension > 0.35) this.burst(at, 0.025, 2000, 0.05 * this.tension, 'bandpass');
  }

  private bass(at: number, frequency: number, length: number, level: number, cutoff: number): void {
    const context = this.context!;
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = frequency;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 5;
    filter.frequency.setValueAtTime(cutoff, at);
    filter.frequency.exponentialRampToValueAtTime(80, at + length);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    osc.connect(filter).connect(gain).connect(this.out!);
    osc.start(at);
    osc.stop(at + length + 0.02);
  }

  private burst(at: number, length: number, frequency: number, level: number, type: BiquadFilterType): void {
    const context = this.context!;
    if (!this.noise) return;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.9;
    const gain = context.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    source.connect(filter).connect(gain).connect(this.out!);
    source.start(at, (at * 5.17) % 1.5);
    source.stop(at + length + 0.02);
  }

  /** A and B-flat a semitone apart, swelling and gone: the sound of too many. */
  private pad(at: number, length: number): void {
    const context = this.context!;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, at);
    filter.frequency.linearRampToValueAtTime(1200, at + length * 0.5);
    filter.frequency.linearRampToValueAtTime(300, at + length);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.05, at + 2);
    gain.gain.setValueAtTime(0.05, at + length - 1.5);
    gain.gain.linearRampToValueAtTime(0, at + length);
    filter.connect(gain).connect(this.out!);
    for (const semis of [-12, -11, 0]) {
      const osc = context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz(semis);
      osc.connect(filter);
      osc.start(at);
      osc.stop(at + length + 0.05);
    }
  }
}
