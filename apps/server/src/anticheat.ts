/**
 * Phase 14 - anti-cheat.
 *
 * The input packet already does the heavy lifting: it has room for a heading
 * and a boost bit and nothing else, so a modified client cannot express extra
 * mass, a teleport, or any other state. There is no field for it. Everything
 * here is the second layer, and none of it is a special case for a particular
 * exploit - it is all shape checks on a stream that should look human.
 *
 * Response ladder: flag -> shadow-throttle rewards -> exclude from
 * leaderboards -> ban. Thresholds are deliberately not published.
 */

import { BASE_SPEED, CITY_FEED_MPS, WARM_WATER_MPS } from '@sen/sim';
import type { Client } from './instance.ts';

/** Client input rate. The client sends at 30Hz; this allows real jitter. */
const MAX_PACKETS_PER_SEC = 45;
/** Boost is a held button, not a strobe. */
const MAX_BOOST_TOGGLES_PER_SEC = 12;

export const Flagged = {
  PacketFlood: 'packet-flood',
  BoostStrobe: 'boost-strobe',
  QuantizedSteering: 'quantized-steering',
  ImpossibleMass: 'impossible-mass',
  SuperhumanReaction: 'superhuman-reaction',
  SessionLength: 'session-length',
} as const;

export interface Verdict {
  ok: boolean;
  flags: string[];
}

/**
 * Per-second window checks. Returns false when the packet should be dropped
 * outright rather than merely noted.
 */
export function rateCheck(c: Client, now: number): boolean {
  if (now - c.windowStart >= 1000) {
    c.windowStart = now;
    c.packets = 0;
    c.boostToggles = 0;
  }
  c.packets++;
  if (c.packets > MAX_PACKETS_PER_SEC) {
    flag(c, Flagged.PacketFlood);
    return false;
  }
  if (c.boostToggles > MAX_BOOST_TOGGLES_PER_SEC) {
    flag(c, Flagged.BoostStrobe);
    // Not dropped: a toggle storm is suspicious, not impossible, and dropping
    // it would punish a stuck key harder than it punishes a script.
  }
  return true;
}

export function flag(c: Client, reason: string): void {
  if (!c.flagged.includes(reason)) c.flagged.push(reason);
}

/**
 * A steering stream that never leaves a small set of exact angles is a script.
 * Humans produce a smear; a bot produces a histogram with spikes.
 */
export function steeringLooksSynthetic(inputLog: number[]): boolean {
  const angles: number[] = [];
  for (let i = 1; i < inputLog.length; i += 3) angles.push(inputLog[i]);
  if (angles.length < 300) return false;
  const seen = new Map<number, number>();
  for (const a of angles) {
    const k = Math.round(a * 1000);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  // Fewer than 12 distinct headings across 300+ samples is not a hand on a
  // mouse or a thumb on a stick.
  return seen.size < 12;
}

/**
 * The theoretical ceiling on mass gained over a window, from the richest
 * source in the game running uninterrupted. Anything above this did not come
 * from playing.
 */
export function maxPlausibleMassGain(seconds: number): number {
  // Draining a tier-one city and sitting in the warm pool are additive, and
  // the pickup stream on top of that is bounded by how much can physically be
  // inside the suction radius. 3x the city rate is a generous ceiling.
  const perSecond = CITY_FEED_MPS + WARM_WATER_MPS[6] + CITY_FEED_MPS * 2;
  return perSecond * seconds + 50;
}

/** Distance a storm could cover, for teleport detection. */
export function maxPlausibleDistance(seconds: number): number {
  // Fastest possible: base speed, warm water, boosting, the whole time.
  return BASE_SPEED * 1.28 * 1.75 * seconds + 200;
}

export interface ReplayCheck {
  ok: boolean;
  reason?: string;
  finalMass?: number;
  claimedMass?: number;
}

/**
 * Phase 14's ground truth: re-sim the run from seed + input log and compare.
 *
 * Determinism from Brief 1 makes this nearly free, and it is what every
 * leaderboard and every airdrop point ultimately rests on. A client that
 * lies about its result produces a replay that does not reproduce it.
 */
export function validateReplay(
  resim: () => number,
  claimedMass: number,
  tolerance = 1e-6,
): ReplayCheck {
  const finalMass = resim();
  if (Math.abs(finalMass - claimedMass) > tolerance) {
    return { ok: false, reason: 'replay-mismatch', finalMass, claimedMass };
  }
  return { ok: true, finalMass, claimedMass };
}

/** Where a client sits on the response ladder. */
export function ladder(flags: string[]): 'clean' | 'throttle' | 'exclude' | 'ban' {
  if (flags.length === 0) return 'clean';
  if (flags.includes(Flagged.ImpossibleMass)) return 'ban';
  if (flags.includes(Flagged.QuantizedSteering) || flags.includes(Flagged.PacketFlood)) {
    return 'exclude';
  }
  return 'throttle';
}
