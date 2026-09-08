/**
 * The menu soundtrack, composed in code.
 *
 * The SWF ships no music at all: its "Music" option only gated the zombie
 * ambience loop, and the longest sample it holds runs six seconds. So the
 * menus get a track of their own, built from oscillators and noise so it
 * loops forever, weighs nothing and plays from a file on disk.
 *
 * The piece: a slow march in D minor at 88 beats a minute over a sixteen-bar
 * loop. A sub drone the whole way; a pulsing bass on eighths that walks
 * D, D, F, C; a war-drum kick on the downbeats with a tom pickup every other
 * bar; a hushed noise snare and hat that join after the first four bars; an
 * eerie four-note motif that answers on the second and fourth phrases through
 * a dotted-eighth echo; and a low, slow pad that swells under the back half,
 * moving from D minor to B-flat major. Everything is scheduled a little ahead
 * of the clock, the standard way to keep Web Audio timing exact.
 */

const BPM = 88;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const LOOP_BARS = 16;
const LOOKAHEAD_S = 0.25;
const TICK_MS = 80;

/** Note frequencies, equal temperament from A4 = 440. */
function hz(note: string): number {
  const names: Record<string, number> = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
  const match = /^([A-G]#?)(-?\d)$/.exec(note);
  if (!match) throw new Error(`bad note ${note}`);
  const semis = names[match[1]!]! + (Number(match[2]) - 4) * 12;
  return 440 * Math.pow(2, semis / 12);
}

/** The bass root per bar of a four-bar phrase, repeated through the loop. */
const BASS_ROOTS = ['D1', 'D1', 'F1', 'C1'];
/** Eighth-note accents within a bar: 1 and the and-of-3 lean in, the rest sit back. */
const BASS_ACCENT = [1, 0.55, 0.7, 0.55, 0.85, 0.55, 1, 0.6];
/** The motif, as [note, beat offset within the phrase, length in beats]. */
const MOTIF: Array<[string, number, number]> = [
  ['D4', 0, 1.5],
  ['F4', 2, 1],
  ['G4', 3, 1],
  ['D#4', 4, 2.5],
  ['D4', 8, 1.5],
  ['A3', 10, 1],
  ['A#3', 11, 1],
  ['A3', 12, 3],
];

export class MenuMusic {
  private context: AudioContext | null = null;
  private out: GainNode | null = null;
  private level: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private echo: DelayNode | null = null;
  private timer = 0;
  private nextBar = 0;
  private startTime = 0;
  private scene: 'off' | 'full' | 'ducked' = 'off';
  private drone: { stop: () => void } | null = null;
  private volume = 0.6;

  /**
   * Hook onto the game's own audio graph, so mute and the master volume apply
   * here too. May be called before the context exists; it is retried.
   */
  constructor(private readonly bus: () => { context: AudioContext; destination: AudioNode } | null) {}

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    this.applyLevel(0.2);
  }

  /** Which menu is up: nothing (fade out), the pause sheet (ducked) or any other (full). */
  setScene(scene: 'off' | 'full' | 'ducked'): void {
    this.scene = scene;
    if (scene !== 'off') this.ensureRunning();
    this.applyLevel(scene === 'off' ? 1.2 : 1.8);
  }

  private applyLevel(seconds: number): void {
    if (!this.context || !this.level) return;
    const target = this.scene === 'off' ? 0 : this.scene === 'ducked' ? this.volume * 0.35 : this.volume;
    const now = this.context.currentTime;
    this.level.gain.cancelScheduledValues(now);
    this.level.gain.setValueAtTime(this.level.gain.value, now);
    this.level.gain.linearRampToValueAtTime(target, now + seconds);
  }

  private ensureRunning(): void {
    if (this.timer) return;
    // Poll until the context exists and is unlocked; a menu is up from the
    // first frame, long before the first click that lets audio start.
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
      // Faded out: stop scheduling and let the drone go quiet too.
      this.drone?.stop();
      this.drone = null;
      window.clearInterval(this.timer);
      this.timer = 0;
      this.startTime = 0;
      return;
    }
    if (!this.drone) this.startDrone();
    if (this.startTime === 0) {
      this.startTime = context.currentTime + 0.05;
      this.nextBar = 0;
    }
    while (this.startTime + this.nextBar * BAR < context.currentTime + LOOKAHEAD_S) {
      this.scheduleBar(this.startTime + this.nextBar * BAR, this.nextBar % LOOP_BARS);
      this.nextBar += 1;
    }
  }

  private build(context: AudioContext, destination: AudioNode): void {
    this.context = context;
    // Glue: a compressor keeps the kick from stepping on everything else, a
    // shelf tames the top so it sits behind the menus.
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.25;
    const shelf = context.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 4000;
    shelf.gain.value = -6;
    this.level = context.createGain();
    this.level.gain.value = 0;
    this.out = context.createGain();
    this.out.gain.value = 0.55;
    this.out.connect(compressor).connect(shelf).connect(this.level).connect(destination);

    // The motif's echo: dotted eighth, three repeats or so.
    this.echo = context.createDelay(2);
    this.echo.delayTime.value = BEAT * 0.75;
    const feedback = context.createGain();
    feedback.gain.value = 0.38;
    const echoTone = context.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 1800;
    this.echo.connect(echoTone).connect(feedback).connect(this.echo);
    const echoLevel = context.createGain();
    echoLevel.gain.value = 0.5;
    echoTone.connect(echoLevel).connect(this.out);

    // Two seconds of white noise for drums and hats.
    const length = Math.floor(context.sampleRate * 2);
    this.noise = context.createBuffer(1, length, context.sampleRate);
    const data = this.noise.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    this.applyLevel(1.5);
  }

  /** The sub drone: two detuned saws and a sine an octave down, breathing through a filter. */
  private startDrone(): void {
    const context = this.context!;
    const out = this.out!;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 160;
    filter.Q.value = 1.2;
    const gain = context.createGain();
    gain.gain.value = 0.0001;
    gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 3);
    filter.connect(gain).connect(out);

    const voices: OscillatorNode[] = [];
    for (const [type, note, detune] of [['sawtooth', 'D2', -7], ['sawtooth', 'D2', 7], ['sine', 'D1', 0]] as const) {
      const osc = context.createOscillator();
      osc.type = type;
      osc.frequency.value = hz(note);
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start();
      voices.push(osc);
    }
    // A slow breath on the filter, so the drone never sits still.
    const lfo = context.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = context.createGain();
    lfoGain.gain.value = 70;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    this.drone = {
      stop: () => {
        const at = context.currentTime;
        gain.gain.cancelScheduledValues(at);
        gain.gain.setValueAtTime(gain.gain.value, at);
        gain.gain.linearRampToValueAtTime(0, at + 0.6);
        for (const osc of voices) osc.stop(at + 0.7);
        lfo.stop(at + 0.7);
      },
    };
  }

  private scheduleBar(at: number, bar: number): void {
    const phrase = Math.floor(bar / 4);
    const root = hz(BASS_ROOTS[bar % 4]!);

    // Bass: eighth-note pulse on the root, a plucked filter on each hit.
    for (let i = 0; i < 8; i++) {
      const t = at + i * (BEAT / 2);
      const accent = BASS_ACCENT[i]!;
      // The fourth bar of a phrase leans into the fifth on its last two eighths.
      const note = bar % 4 === 3 && i >= 6 ? root * 1.5 : root;
      this.bassNote(t, note, 0.26, 0.22 * accent, 380 + 500 * accent);
    }

    // Drums. Kick on 1 and 3; a tom pickup on the and-of-4 every other bar;
    // snare and hat only after the first phrase, and the hat drops out again
    // in the final phrase so the loop breathes before it turns over.
    this.kick(at, 1);
    this.kick(at + 2 * BEAT, 0.85);
    if (bar % 2 === 1) {
      this.tom(at + 3.5 * BEAT, 0.7);
      this.tom(at + 3.75 * BEAT, 0.5);
    }
    if (phrase >= 1) {
      this.snare(at + BEAT, 0.3);
      this.snare(at + 3 * BEAT, 0.34);
    }
    if (phrase === 1 || phrase === 2) {
      for (let i = 0; i < 16; i++) {
        if (i % 4 === 2) continue;
        this.hat(at + i * (BEAT / 4), i % 4 === 0 ? 0.08 : 0.045);
      }
    }

    // Motif on the second and fourth phrases, an octave up on the fourth.
    if (phrase === 1 || phrase === 3) {
      const within = bar % 4;
      for (const [note, beat, length] of MOTIF) {
        const bbar = Math.floor(beat / 4);
        if (bbar !== within) continue;
        const t = at + (beat - bbar * 4) * BEAT;
        this.lead(t, hz(note) * (phrase === 3 ? 2 : 1), length * BEAT, phrase === 3 ? 0.11 : 0.13);
      }
    }

    // Pad under the back half: D minor, then B-flat major for the last phrase.
    if (bar === 8) this.pad(at, ['D3', 'F3', 'A3'], 4 * BAR);
    if (bar === 12) this.pad(at, ['A#2', 'D3', 'F3'], 4 * BAR);
  }

  private bassNote(at: number, frequency: number, length: number, level: number, cutoff: number): void {
    const context = this.context!;
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = frequency;
    const square = context.createOscillator();
    square.type = 'square';
    square.frequency.value = frequency / 2;
    const squareGain = context.createGain();
    squareGain.gain.value = 0.35;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(cutoff, at);
    filter.frequency.exponentialRampToValueAtTime(90, at + length);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    osc.connect(filter);
    square.connect(squareGain).connect(filter);
    filter.connect(gain).connect(this.out!);
    osc.start(at);
    square.start(at);
    osc.stop(at + length + 0.02);
    square.stop(at + length + 0.02);
  }

  private kick(at: number, level: number): void {
    const context = this.context!;
    const osc = context.createOscillator();
    osc.frequency.setValueAtTime(130, at);
    osc.frequency.exponentialRampToValueAtTime(42, at + 0.12);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.9 * level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.42);
    osc.connect(gain).connect(this.out!);
    osc.start(at);
    osc.stop(at + 0.45);
    // A touch of click on the front so it cuts through the drone.
    this.burst(at, 0.03, 2200, 0.12 * level, 'bandpass');
  }

  private tom(at: number, level: number): void {
    const context = this.context!;
    const osc = context.createOscillator();
    osc.frequency.setValueAtTime(190, at);
    osc.frequency.exponentialRampToValueAtTime(75, at + 0.2);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.5 * level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.35);
    osc.connect(gain).connect(this.out!);
    osc.start(at);
    osc.stop(at + 0.4);
  }

  private snare(at: number, level: number): void {
    this.burst(at, 0.14, 1800, level, 'bandpass');
    const context = this.context!;
    const osc = context.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, at);
    osc.frequency.exponentialRampToValueAtTime(140, at + 0.08);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.35 * level, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.1);
    osc.connect(gain).connect(this.out!);
    osc.start(at);
    osc.stop(at + 0.12);
  }

  private hat(at: number, level: number): void {
    this.burst(at, 0.035, 7000, level, 'highpass');
  }

  /** A shaped slice of noise through a filter: the raw material of every drum. */
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
    source.start(at, (at * 7.31) % 1.5);
    source.stop(at + length + 0.02);
  }

  private lead(at: number, frequency: number, length: number, level: number): void {
    const context = this.context!;
    const osc = context.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = frequency;
    // A slow, slight vibrato that widens as the note holds.
    const vibrato = context.createOscillator();
    vibrato.frequency.value = 5.2;
    const vibratoGain = context.createGain();
    vibratoGain.gain.setValueAtTime(0, at);
    vibratoGain.gain.linearRampToValueAtTime(frequency * 0.012, at + length * 0.8);
    vibrato.connect(vibratoGain).connect(osc.frequency);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.04);
    gain.gain.setValueAtTime(level, at + length * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.001, at + length);
    osc.connect(filter).connect(gain);
    gain.connect(this.out!);
    gain.connect(this.echo!);
    osc.start(at);
    vibrato.start(at);
    osc.stop(at + length + 0.02);
    vibrato.stop(at + length + 0.02);
  }

  private pad(at: number, notes: string[], length: number): void {
    const context = this.context!;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(320, at);
    filter.frequency.linearRampToValueAtTime(760, at + length * 0.6);
    filter.frequency.linearRampToValueAtTime(300, at + length);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.06, at + 2.2);
    gain.gain.setValueAtTime(0.06, at + length - 1.6);
    gain.gain.linearRampToValueAtTime(0, at + length);
    filter.connect(gain).connect(this.out!);
    for (const note of notes) {
      for (const detune of [-9, 9]) {
        const osc = context.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz(note);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(at);
        osc.stop(at + length + 0.05);
      }
    }
  }
}
