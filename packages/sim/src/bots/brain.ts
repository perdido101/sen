/**
 * Rival storms.
 *
 * THE CONTRACT: bots emit Input objects and nothing else. A bot may read state
 * to decide, but it acts only through {steerAngle, boosting} - identical to a
 * human. When the server arrives, bots and players are indistinguishable to the
 * sim.
 *
 * Four-state brain: FEED / HUNT / FLEE / SIEGE.
 * Personality tiers: Reckless, Farmer, Hunter, Coward - each weighting the
 * transitions differently.
 */

import {
  BOOST_MIN_MASS,
  RANK_EL_NINO,
  WARM_POOL_X,
  WARM_POOL_Y,
  WORLD_H,
  clamp,
  coreRadius,
  fieldRadius,
  rankOf,
  stormSpeed,
  suctionRadius,
  warmPoolT,
  wrapDeltaX,
} from '../sim/constants.ts';
import { rand } from '../sim/rng.ts';
import { sampleTerrain, sstAt } from '../sim/terrain.ts';
import type { Input, Storm, WorldState } from '../sim/types.ts';

export const FEED = 0;
export const HUNT = 1;
export const FLEE = 2;
export const SIEGE = 3;

export const RECKLESS = 0;
export const FARMER = 1;
export const HUNTER = 2;
export const COWARD = 3;

export const PERSONALITY_NAMES = ['Reckless', 'Farmer', 'Hunter', 'Coward'];

interface Weights {
  /** Multiplier on the mass ratio at which this bot decides to hunt. */
  huntRatio: number;
  /** Distance at which a bigger storm triggers FLEE. */
  fleeRange: number;
  /** How much it likes sitting on cities. */
  siege: number;
  /** How readily it burns mass on boost. */
  boost: number;
  /** How long it commits to a decision. */
  commit: number;
}

const W: Weights[] = [
  { huntRatio: 0.95, fleeRange: 900, siege: 0.8, boost: 0.75, commit: 0.5 }, // Reckless
  { huntRatio: 1.7, fleeRange: 1500, siege: 1.5, boost: 0.2, commit: 1.1 }, // Farmer
  { huntRatio: 1.15, fleeRange: 1050, siege: 0.9, boost: 0.55, commit: 0.7 }, // Hunter
  { huntRatio: 2.6, fleeRange: 2100, siege: 1.2, boost: 0.35, commit: 0.9 }, // Coward
];

function angTo(from: Storm, x: number, y: number): number {
  return Math.atan2(y - from.y, wrapDeltaX(from.x, x));
}

/** Nearest live rival, and the nearest one that outclasses us. */
function scan(w: WorldState, s: Storm): { prey: Storm | null; threat: Storm | null; preyD: number; threatD: number } {
  let prey: Storm | null = null;
  let threat: Storm | null = null;
  let preyD = Infinity;
  let threatD = Infinity;
  const weights = W[s.botPersonality];

  for (let i = 0; i < w.storms.length; i++) {
    const o = w.storms[i];
    if (o === s || !o.alive) continue;
    const dx = wrapDeltaX(s.x, o.x);
    const dy = o.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d > 3200) continue;

    if (o.mass * weights.huntRatio < s.mass) {
      if (d < preyD) {
        preyD = d;
        prey = o;
      }
    } else if (o.mass > s.mass * 0.9) {
      if (d < threatD) {
        threatD = d;
        threat = o;
      }
    }
  }
  return { prey, threat, preyD, threatD };
}

function nearestCity(w: WorldState, s: Storm): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < w.cities.length; i++) {
    const c = w.cities[i];
    if (c.reserve <= c.reserveMax * 0.15) continue;
    const dx = wrapDeltaX(s.x, c.x);
    const dy = c.y - s.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Nearest loose debris, so bots eat scatter from a kill like a player would. */
function nearestDebris(w: WorldState, s: Storm): number {
  let best = -1;
  let bestD = 1400 * 1400;
  for (let i = 0; i < w.debris.length; i++) {
    const d = w.debris[i];
    if (!d.active) continue;
    const dx = wrapDeltaX(s.x, d.x);
    const dy = d.y - s.y;
    const dd = dx * dx + dy * dy;
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  }
  return best;
}

/**
 * Where a bot wants to be given its rank: land while small, open ocean once
 * the map has flipped. Same lesson the player learns, expressed as a heading.
 */
function biomePull(w: WorldState, s: Storm, rank: number): { x: number; y: number } | null {
  const here = sampleTerrain(w.terrain, s.x, s.y);

  if (rank <= 2 && here.water) {
    // Water bleeds mass at low rank: get off it. Probe for the closest land.
    for (let r = 260; r <= 1800; r += 260) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = s.x + Math.cos(a) * r;
        const py = clamp(s.y + Math.sin(a) * r, 20, WORLD_H - 20);
        const t = sampleTerrain(w.terrain, px, py);
        if (!t.water && !t.ice) return { x: px, y: py };
      }
    }
  }

  if (here.ice) {
    // The poles are a soft wall at every rank.
    return { x: s.x, y: s.y < WORLD_H * 0.5 ? s.y + 900 : s.y - 900 };
  }

  if (rank >= 4) {
    // The ocean feeds us now. Head for the warmest water we can see, and for
    // La Nina that means contesting the pool itself.
    if (s.isLaNina || rank >= RANK_EL_NINO) {
      return { x: WARM_POOL_X, y: WARM_POOL_Y };
    }
    let bestT = sstAt(w, s.x, s.y);
    let best: { x: number; y: number } | null = null;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = s.x + Math.cos(a) * 1500;
      const py = clamp(s.y + Math.sin(a) * 1500, 20, WORLD_H - 20);
      const t = sampleTerrain(w.terrain, px, py);
      if (!t.water) continue;
      const temp = sstAt(w, px, py);
      if (temp > bestT + 6) {
        bestT = temp;
        best = { x: px, y: py };
      }
    }
    if (best !== null) return best;
  }

  return null;
}

/**
 * Produce one Input for one bot, written into `out`. This is the entire bot
 * API surface - a bot cannot reach the sim any other way.
 */
export function botInput(w: WorldState, s: Storm, dt: number, out: Input): void {
  const weights = W[s.botPersonality];
  const rank = rankOf(s.mass);
  const { prey, threat, preyD, threatD } = scan(w, s);

  s.botTimer -= dt;
  if (s.botTimer <= 0) {
    s.botTimer = weights.commit * (0.6 + rand(w) * 0.8);

    // Transitions, most urgent first.
    if (threat !== null && threatD < weights.fleeRange) {
      s.botState = FLEE;
      s.botTarget = threat.id;
    } else if (prey !== null && preyD < 1900) {
      s.botState = HUNT;
      s.botTarget = prey.id;
    } else {
      const city = nearestCity(w, s);
      const cityGood = city >= 0 && rank >= 2;
      if (cityGood && rand(w) < 0.45 * weights.siege) {
        s.botState = SIEGE;
        s.botTarget = city;
      } else {
        s.botState = FEED;
        s.botTarget = -1;
        // Everything expensive happens here, on the decision tick, and the
        // result is cached: the terrain probe is up to 56 samples and the
        // debris sweep is the whole pool, which at 64 bots would be a hundred
        // thousand checks a frame.
        const pull = biomePull(w, s, rank);
        if (pull !== null) {
          s.botAimX = pull.x;
          s.botAimY = pull.y;
          s.botAimValid = true;
        } else {
          const di = nearestDebris(w, s);
          if (di >= 0) {
            s.botAimX = w.debris[di].x;
            s.botAimY = w.debris[di].y;
            s.botAimValid = true;
          } else {
            s.botAimValid = false;
          }
        }
      }
    }
  }

  let steer = s.ang;
  let boost = false;

  switch (s.botState) {
    case FLEE: {
      const t = w.storms[s.botTarget];
      if (t !== undefined && t.alive) {
        // Run from the field edge, not the eye - the field is what kills.
        const away = angTo(s, t.x, t.y) + Math.PI;
        steer = away;
        const edge = fieldRadius(t.mass) + coreRadius(s.mass);
        boost = threatD < edge * 1.6 && s.mass >= BOOST_MIN_MASS && rand(w) < weights.boost;
      } else {
        s.botState = FEED;
      }
      break;
    }

    case HUNT: {
      const t = w.storms[s.botTarget];
      if (t !== undefined && t.alive) {
        // Lead the target so the field arrives where the eye will be.
        const lead = stormSpeed(t.mass) * clamp(preyD / 900, 0.2, 1.4);
        const tx = t.x + Math.cos(t.ang) * lead;
        const ty = t.y + Math.sin(t.ang) * lead;
        steer = angTo(s, tx, ty);
        boost = preyD < 1200 && s.mass >= BOOST_MIN_MASS && rand(w) < weights.boost;
      } else {
        s.botState = FEED;
      }
      break;
    }

    case SIEGE: {
      const c = w.cities[s.botTarget];
      if (c !== undefined && c.reserve > 0) {
        const dx = wrapDeltaX(s.x, c.x);
        const dy = c.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d > c.r * 0.55) {
          steer = Math.atan2(dy, dx);
        } else {
          // Inside: orbit the centre so we keep chewing without leaving.
          steer = Math.atan2(dy, dx) + Math.PI * 0.5 * s.spinDir * -1;
        }
      } else {
        s.botState = FEED;
      }
      break;
    }

    default: {
      // FEED. Head for whatever the last decision tick picked: the terrain's
      // pull if it had an opinion, otherwise the richest loose debris on the
      // map, which after a kill is the best meal going.
      if (s.botAimValid) {
        steer = angTo(s, s.botAimX, s.botAimY);
      } else {
        // Wander with a slow drift rather than a jitter, so big bots read as
        // deliberate rather than twitchy.
        steer = s.ang + Math.sin(w.time * 0.35 + s.id * 2.1) * 0.5;
      }
      break;
    }
  }

  // Nobody, at any rank, wants to be on the ice.
  const here = sampleTerrain(w.terrain, s.x, s.y);
  if (here.ice || s.y < 120 || s.y > WORLD_H - 120) {
    steer = s.y < WORLD_H * 0.5 ? Math.PI * 0.5 : -Math.PI * 0.5;
  }

  // Never steer into a bigger storm's debris field. This single rule is what
  // makes bots read as competent.
  if (threat !== null) {
    const danger = fieldRadius(threat.mass) + suctionRadius(s.mass) * 0.4;
    if (threatD < danger * 1.35) {
      const away = angTo(s, threat.x, threat.y) + Math.PI;
      // Blend rather than snap, so they arc out instead of reversing.
      const bias = clamp(1 - threatD / (danger * 1.35), 0, 1);
      steer = blendAngle(steer, away, bias * 0.85);
    }
  }

  // El Nino rank bots defend the pool they are sitting in.
  if (rank >= RANK_EL_NINO && warmPoolT(s.x, s.y) > 1 && s.winTimer === 0) {
    steer = blendAngle(steer, angTo(s, WARM_POOL_X, WARM_POOL_Y), 0.6);
  }

  out.steerAngle = steer;
  out.boosting = boost;
}

function blendAngle(a: number, b: number, t: number): number {
  const dx = Math.cos(a) * (1 - t) + Math.cos(b) * t;
  const dy = Math.sin(a) * (1 - t) + Math.sin(b) * t;
  return Math.atan2(dy, dx);
}
