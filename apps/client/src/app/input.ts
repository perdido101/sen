/**
 * Steering. Three schemes, all producing the same two numbers.
 *
 *   Keyboard   WASD or the arrow keys - either, or both, no setting needed.
 *              The keys set an absolute heading, so diagonals work and a big
 *              storm still cannot corner: it turns toward that heading at
 *              maxTurnRate like everything else.
 *   Pointer    Mouse position sets the heading, the .io convention. Can be
 *              switched off for people who want keys only.
 *   Stick      A transparent floating stick, touch devices only.
 *
 * Whichever you touched last wins, so nothing has to be chosen up front and a
 * keyboard player is never fighting a stale cursor position.
 *
 * This produces exactly one thing: the two numbers in an Input. A socket would
 * deliver the same shape.
 */

import type { Camera } from '../render/camera.ts';
import type { TouchControls } from '../ui/touch.ts';
import { wrapDeltaX } from '@sen/sim/sim/constants.ts';

type Source = 'none' | 'pointer' | 'keys' | 'stick';

const KEY_VECTORS: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

export class InputSource {
  private px = 0;
  private py = 0;
  private hasPointer = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private keyBoost = false;
  private mouseDown = false;
  private held = new Set<string>();
  private last: Source = 'none';

  /** Set false to steer with the keys only. */
  pointerSteer = true;

  /** Fires on the first user gesture, for unlocking audio. */
  onGesture: (() => void) | null = null;
  onPause: (() => void) | null = null;

  constructor(
    target: HTMLElement,
    private touch: TouchControls | null = null,
  ) {
    target.addEventListener('pointerdown', this.down, { passive: false });
    target.addEventListener('pointermove', this.move, { passive: false });
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.up);
    window.addEventListener('keydown', this.key);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('blur', () => {
      this.pointers.clear();
      this.mouseDown = false;
      this.keyBoost = false;
      this.held.clear();
    });
  }

  private down = (e: PointerEvent): void => {
    e.preventDefault();
    this.onGesture?.();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.px = e.clientX;
    this.py = e.clientY;
    this.hasPointer = true;
    if (e.pointerType === 'mouse') {
      this.mouseDown = true;
      this.last = 'pointer';
    }
  };

  private move = (e: PointerEvent): void => {
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (e.pointerType === 'mouse') {
      this.px = e.clientX;
      this.py = e.clientY;
      this.hasPointer = true;
      this.last = 'pointer';
    }
  };

  private up = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (e.pointerType === 'mouse') this.mouseDown = false;
  };

  private key = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.keyBoost = true;
      e.preventDefault();
    }
    if (KEY_VECTORS[e.code] !== undefined) {
      this.held.add(e.code);
      this.last = 'keys';
      // Arrow keys scroll the page otherwise.
      e.preventDefault();
    }
    if (e.code === 'Escape') this.onPause?.();
    this.onGesture?.();
  };

  private keyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.keyBoost = false;
    }
    this.held.delete(e.code);
  };

  /** Summed direction of every held movement key, or null if none. */
  private keyAngle(): number | null {
    let x = 0;
    let y = 0;
    for (const code of this.held) {
      const v = KEY_VECTORS[code];
      if (v !== undefined) {
        x += v[0];
        y += v[1];
      }
    }
    // Opposite keys cancel: hold the current heading rather than snapping east.
    if (x === 0 && y === 0) return null;
    return Math.atan2(y, x);
  }

  /**
   * @param fallback heading to keep when nothing is currently steering
   */
  steerAngle(cam: Camera, sx: number, sy: number, fallback: number): number {
    const keys = this.keyAngle();
    if (keys !== null) return keys;

    if (this.touch !== null && this.touch.active) {
      if (this.touch.magnitude > 0 && this.touch.angle !== null) return this.touch.angle;
      // The stick is the only steering on a touch device: a stray tap
      // elsewhere must not yank the storm toward it.
      return fallback;
    }

    // A key press claims steering until the mouse moves again, so releasing
    // WASD leaves the storm on its heading instead of snapping to the cursor.
    if (!this.pointerSteer || !this.hasPointer || this.last !== 'pointer') return fallback;

    const wx = cam.wx(this.px);
    const wy = cam.wy(this.py);
    const dx = wrapDeltaX(sx, wx);
    const dy = wy - sy;
    // Ignore a pointer sitting on top of the eye - it would spin the storm.
    if (dx * dx + dy * dy < 12 * 12) return fallback;
    return Math.atan2(dy, dx);
  }

  get boosting(): boolean {
    if (this.touch !== null && this.touch.active) {
      return this.keyBoost || this.touch.boosting;
    }
    // Desktop: hold the mouse button or space. A second finger still works on
    // a touchscreen laptop that is not showing the stick.
    return this.keyBoost || this.mouseDown || this.pointers.size >= 2;
  }
}
