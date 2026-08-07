/**
 * Seeded PRNG. Every random number in the sim comes from here.
 *
 * No bare Math.random() anywhere in /src/sim - seed + input log must reproduce
 * a run exactly, which gives replays and desync detection for free.
 */

import type { WorldState } from './types.ts';

/** mulberry32. Advances and returns the new state. */
export function nextState(s: number): number {
  return (s + 0x6d2b79f5) | 0;
}

/** Turns a state word into a float in [0,1). */
export function stateToFloat(s: number): number {
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Advance the world RNG and return a float in [0,1). */
export function rand(w: WorldState): number {
  w.rng = nextState(w.rng);
  return stateToFloat(w.rng);
}

export function randRange(w: WorldState, lo: number, hi: number): number {
  return lo + rand(w) * (hi - lo);
}

export function randInt(w: WorldState, lo: number, hi: number): number {
  return lo + Math.floor(rand(w) * (hi - lo + 1));
}

export function pick<T>(w: WorldState, arr: readonly T[]): T {
  return arr[Math.floor(rand(w) * arr.length) % arr.length];
}

/**
 * Standalone stream, used for chunk generation: hash(worldSeed, cellX, cellY)
 * so every client generates identical props without touching world RNG order.
 */
export class Stream {
  private s: number;
  constructor(seed: number) {
    this.s = seed | 0;
  }
  next(): number {
    this.s = nextState(this.s);
    return stateToFloat(this.s);
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Deterministic integer hash for chunk / city seeding. */
export function hash3(a: number, b: number, c: number): number {
  let h = (a | 0) ^ Math.imul(b | 0, 0x27d4eb2d) ^ Math.imul(c | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) | 0;
}

/** Cheap deterministic value noise in [0,1), used for prop density fields. */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = stateToFloat(hash3(xi, yi, seed));
  const n10 = stateToFloat(hash3(xi + 1, yi, seed));
  const n01 = stateToFloat(hash3(xi, yi + 1, seed));
  const n11 = stateToFloat(hash3(xi + 1, yi + 1, seed));
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}
