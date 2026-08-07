/**
 * Steering.
 *
 * Hold/drag anywhere on mobile or mouse position on desktop sets a target
 * heading; the storm turns toward it at maxTurnRate. Boost is a second finger,
 * a held click, or space/shift.
 *
 * This produces exactly one thing: the two numbers in an Input. A socket would
 * deliver the same shape.
 */

import type { Camera } from '../render/camera.ts';
import { wrapDeltaX } from '../sim/constants.ts';

export class InputSource {
  /** Latest pointer position in CSS pixels, or null if the pointer never moved. */
  private px = 0;
  private py = 0;
  private has = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private keyBoost = false;
  private mouseDown = false;

  /** Fires on the first user gesture, for unlocking audio. */
  onGesture: (() => void) | null = null;
  onPause: (() => void) | null = null;

  constructor(target: HTMLElement) {
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
    });
  }

  private down = (e: PointerEvent): void => {
    e.preventDefault();
    this.onGesture?.();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.px = e.clientX;
    this.py = e.clientY;
    this.has = true;
    if (e.pointerType === 'mouse') this.mouseDown = true;
  };

  private move = (e: PointerEvent): void => {
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    // On desktop the bare mouse position steers; on touch only a live contact
    // does, so a lifted finger leaves the storm on its last heading.
    if (e.pointerType === 'mouse' || this.pointers.size > 0) {
      this.px = e.clientX;
      this.py = e.clientY;
      this.has = true;
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
    if (e.code === 'Escape') this.onPause?.();
    this.onGesture?.();
  };

  private keyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.keyBoost = false;
    }
  };

  /**
   * @param fallback heading to keep if the player has not aimed yet
   */
  steerAngle(cam: Camera, sx: number, sy: number, fallback: number): number {
    if (!this.has) return fallback;
    const wx = cam.wx(this.px);
    const wy = cam.wy(this.py);
    const dx = wrapDeltaX(sx, wx);
    const dy = wy - sy;
    // Ignore a pointer sitting on top of the eye - it would spin the storm.
    if (dx * dx + dy * dy < 12 * 12) return fallback;
    return Math.atan2(dy, dx);
  }

  get boosting(): boolean {
    // Desktop: hold the mouse button or space. Mobile: a second finger - a
    // single held finger is how you steer, so it must never boost.
    return this.keyBoost || this.mouseDown || this.pointers.size >= 2;
  }
}
