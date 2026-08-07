/**
 * Fixed-timestep loop with interpolation.
 *
 * dt into the sim is always 1/60. We accumulate real time, run whole steps,
 * and hand the renderer an alpha so it can interpolate between the last two
 * states. Never feed variable dt into the sim.
 */

import { FIXED_DT } from '../sim/constants.ts';

/** Never simulate more than this many steps in one frame - death spiral guard. */
const MAX_STEPS = 5;

export class FixedLoop {
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  /** Interpolation factor for the renderer, 0..1. */
  alpha = 0;

  /** Smoothed frame time in ms, for the debug overlay. */
  frameMs = 16.7;
  simMs = 0;
  drawMs = 0;
  steps = 0;

  constructor(
    private readonly onStep: () => void,
    private readonly onDraw: (alpha: number, dtReal: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);

      let dtReal = (now - this.last) / 1000;
      this.last = now;
      // A backgrounded tab can hand us a huge delta; clamp rather than
      // fast-forwarding the whole world.
      if (dtReal > 0.25) dtReal = 0.25;
      this.frameMs += ((now - (this.lastFrameAt || now)) - this.frameMs) * 0.1;
      this.lastFrameAt = now;

      this.acc += dtReal;

      const t0 = performance.now();
      let n = 0;
      while (this.acc >= FIXED_DT && n < MAX_STEPS) {
        this.onStep();
        this.acc -= FIXED_DT;
        n++;
      }
      if (n >= MAX_STEPS) this.acc = 0;
      this.steps = n;
      const t1 = performance.now();

      this.alpha = this.acc / FIXED_DT;
      this.onDraw(this.alpha, dtReal);
      const t2 = performance.now();

      this.simMs += (t1 - t0 - this.simMs) * 0.1;
      this.drawMs += (t2 - t1 - this.drawMs) * 0.1;
    };
    this.raf = requestAnimationFrame(tick);
  }

  private lastFrameAt = 0;

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  get fps(): number {
    return this.frameMs > 0 ? 1000 / this.frameMs : 0;
  }
}
