/**
 * Camera. 0.12 lerp follow, zoom out with mass, leads the direction of travel
 * by 80 units, 0.3s zoom punch on rank-up.
 *
 * Everything else in the renderer converts world -> screen through this, which
 * is also where horizontal wrap is handled: there is exactly one place that
 * knows the world repeats.
 */

import { WORLD_H, clamp, lerp, sizeFactor, wrapDeltaX } from '../sim/constants.ts';

const LEAD = 80;

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  /** Screen size in CSS pixels. */
  w = 0;
  h = 0;

  private targetZoom = 1;
  private punch = 0;
  private shakeTrauma = 0;
  private shakeX = 0;
  private shakeY = 0;
  private noiseT = 0;

  reducedMotion = false;

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }

  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  /** Impulse on collapse, shred, city entry. Never additive - always max. */
  addTrauma(t: number): void {
    if (this.reducedMotion) return;
    this.shakeTrauma = Math.max(this.shakeTrauma, Math.min(1, t));
  }

  zoomPunch(): void {
    this.punch = 1;
  }

  follow(x: number, y: number, ang: number, mass: number, dt: number): void {
    const f = sizeFactor(mass);
    // Zoom out with mass, 1.0 -> 0.62.
    this.targetZoom = lerp(1.0, 0.62, f);

    const tx = x + Math.cos(ang) * LEAD;
    const ty = y + Math.sin(ang) * LEAD;

    // Lerp toward the target, honouring the wrap so crossing the seam does not
    // sling the camera the long way around the planet.
    const k = 1 - Math.pow(1 - 0.12, dt * 60);
    this.x += wrapDeltaX(this.x, tx) * k;
    this.y += (ty - this.y) * k;

    // Never show past the ice caps.
    const halfH = this.h / (2 * this.zoom);
    this.y = clamp(this.y, Math.min(halfH, WORLD_H / 2), Math.max(WORLD_H - halfH, WORLD_H / 2));

    if (this.punch > 0) this.punch = Math.max(0, this.punch - dt / 0.3);
    const punchZoom = 1 + Math.sin(this.punch * Math.PI) * 0.09;
    this.zoom += (this.targetZoom * punchZoom - this.zoom) * (1 - Math.pow(1 - 0.14, dt * 60));

    // Trauma decays; offset is trauma squared so small hits stay subtle.
    if (this.shakeTrauma > 0) {
      this.shakeTrauma = Math.max(0, this.shakeTrauma - dt * 1.5);
      this.noiseT += dt * 34;
      const amp = this.shakeTrauma * this.shakeTrauma * 26;
      this.shakeX = Math.sin(this.noiseT * 1.7) * amp;
      this.shakeY = Math.cos(this.noiseT * 2.3) * amp;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /** World x -> screen x, choosing the representative copy nearest the camera. */
  sx(wx: number): number {
    return this.w * 0.5 + wrapDeltaX(this.x, wx) * this.zoom + this.shakeX;
  }

  sy(wy: number): number {
    return this.h * 0.5 + (wy - this.y) * this.zoom + this.shakeY;
  }

  /** Screen -> world, for pointer steering. */
  wx(sx: number): number {
    return this.x + (sx - this.w * 0.5) / this.zoom;
  }

  wy(sy: number): number {
    return this.y + (sy - this.h * 0.5) / this.zoom;
  }

  /** Half-extent of the visible world plus a margin, for culling. */
  halfW(margin = 200): number {
    return this.w / (2 * this.zoom) + margin;
  }

  halfH(margin = 200): number {
    return this.h / (2 * this.zoom) + margin;
  }

  visible(wx: number, wy: number, r: number): boolean {
    const dx = Math.abs(wrapDeltaX(this.x, wx));
    const dy = Math.abs(wy - this.y);
    return dx < this.halfW(r) && dy < this.halfH(r);
  }
}
