/**
 * Fixed-step game loop.
 *
 * The simulation runs at exactly 50Hz to match the original; the display runs
 * at whatever the monitor does. At 60Hz that means an alternating one-step /
 * two-step cadence, which is why rendering interpolates between the previous
 * and current positions -- without it the motion visibly stutters.
 */
export interface LoopCallbacks {
  /** Advance the simulation exactly one step. */
  step: () => void;
  /** Draw, with `alpha` in [0,1) between the previous and current step. */
  draw: (alpha: number) => void;
}

export class Loop {
  private accumulator = 0;
  private previous = 0;
  private running = false;
  private frameHandle = 0;

  /** Simulation steps taken in the most recent frame, for the profiler. */
  lastSteps = 0;
  /** Milliseconds spent in step() and draw() last frame. */
  stepMs = 0;
  drawMs = 0;

  constructor(
    private readonly callbacks: LoopCallbacks,
    /** Milliseconds per simulation step. */
    private readonly stepMsTarget: number,
    /** Steps per frame before the loop declares bankruptcy and drops time. */
    private readonly maxSteps = 5,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.previous = performance.now();
    this.accumulator = 0;
    const frame = (now: number): void => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(frame);
      this.tick(now);
    };
    this.frameHandle = requestAnimationFrame(frame);

    // Returning to a backgrounded tab must not replay minutes of queued time.
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = (): void => {
    if (!document.hidden) {
      this.previous = performance.now();
      this.accumulator = 0;
    }
  };

  private tick(now: number): void {
    // Clamp so a single long stall cannot produce a burst of catch-up steps.
    const elapsed = Math.min(now - this.previous, 250);
    this.previous = now;
    this.accumulator += elapsed;

    let steps = 0;
    const stepStart = performance.now();
    while (this.accumulator >= this.stepMsTarget && steps < this.maxSteps) {
      this.callbacks.step();
      this.accumulator -= this.stepMsTarget;
      steps += 1;
    }
    // Still behind after the cap: discard the debt rather than spiralling.
    if (steps === this.maxSteps) this.accumulator = 0;
    this.stepMs = performance.now() - stepStart;
    this.lastSteps = steps;

    const drawStart = performance.now();
    this.callbacks.draw(this.accumulator / this.stepMsTarget);
    this.drawMs = performance.now() - drawStart;
  }
}
