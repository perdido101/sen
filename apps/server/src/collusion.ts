/**
 * Phase 15 - collusion detection, OBSERVE-ONLY.
 *
 * This is built before there is anything to win, and it runs without acting on
 * anything, on purpose: the point is to learn what normal play looks like
 * while nobody has an incentive to fake it. Thresholds get set from that
 * distribution in Phase 18, not from guesses made now.
 *
 * The structural exploit in any .io economy is that mass transfers between
 * players, so a pair of accounts is a pump: A farms, deliberately dies to B,
 * B collects. Every signal below is a different angle on that same shape.
 */

import { store, type RunRecord } from './persistence.ts';

export interface DyadScore {
  a: string;
  b: string;
  /** Times they shared an instance. */
  coOccurrence: number;
  /** Expected co-occurrence if instance assignment were random. */
  expected: number;
  /** Net mass that flowed from a to b, in mass units. */
  netFlow: number;
  /** 0..1; 1 means every transfer went one way. */
  asymmetry: number;
  /** How concentrated a's deaths are on b. 1 means a only ever dies to b. */
  partnerConcentration: number;
  /** Deaths where a made no attempt to escape. */
  lowResistanceDeaths: number;
  /** Joins within 10s of each other. */
  syncedJoins: number;
  /** Combined, higher is more suspicious. Never published. */
  score: number;
}

export interface CollusionReport {
  epoch: string;
  dyads: DyadScore[];
  /** Distribution summary, which is the actual deliverable of this phase. */
  percentiles: { p50: number; p90: number; p99: number; max: number };
  observeOnly: boolean;
}

interface Pairing {
  co: number;
  flowAB: number;
  flowBA: number;
  deathsAtoB: number;
  lowResistance: number;
  syncedJoins: number;
}

function key(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build the graph for an epoch.
 *
 * Everything here reads run records; nothing touches the live simulation, and
 * nothing here can affect a match in progress. That separation is what makes
 * "observe only" a property of the design rather than a promise.
 */
export function analyse(epochStart: number, epochEnd: number, epochName: string): CollusionReport {
  const runs = store.runs(epochStart).filter((r) => r.at < epochEnd);

  // Who was in which instance, and when.
  const byInstance = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const list = byInstance.get(r.instance) ?? [];
    list.push(r);
    byInstance.set(r.instance, list);
  }

  const pairs = new Map<string, Pairing>();
  const deathsBy = new Map<string, Map<string, number>>();
  const identity = (r: RunRecord): string => r.accountId ?? `anon:${r.name}`;

  const bump = (a: string, b: string, fn: (p: Pairing) => void): void => {
    const k = key(a, b);
    let p = pairs.get(k);
    if (p === undefined) {
      p = { co: 0, flowAB: 0, flowBA: 0, deathsAtoB: 0, lowResistance: 0, syncedJoins: 0 };
      pairs.set(k, p);
    }
    fn(p);
  };

  for (const list of byInstance.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = identity(list[i]);
        const b = identity(list[j]);
        if (a === b) continue;
        bump(a, b, (p) => {
          p.co++;
          // Joining within ten seconds of each other, repeatedly, is a
          // coordination signal that is very hard to produce by accident.
          if (Math.abs(list[i].at - list[j].at) < 10_000) p.syncedJoins++;
        });
      }
    }
  }

  // Mass flow on death, and how concentrated each player's deaths are.
  const byStorm = new Map<string, RunRecord>();
  for (const r of runs) byStorm.set(`${r.instance}:${r.stormId}`, r);

  for (const r of runs) {
    if (r.killedBy === undefined || r.massTransferred === undefined) continue;
    const killer = byStorm.get(`${r.instance}:${r.killedBy}`);
    if (killer === undefined) continue;
    const victim = identity(r);
    const winner = identity(killer);
    if (victim === winner) continue;

    const kk = key(victim, winner);
    bump(victim, winner, (p) => {
      if (victim < winner) p.flowAB += r.massTransferred ?? 0;
      else p.flowBA += r.massTransferred ?? 0;
      p.deathsAtoB++;
      // An honest death is a mistake under pressure; a feed is a straight
      // line into the field with no boost spent trying to get out.
      if (looksLikeAFeed(r)) p.lowResistance++;
    });
    void kk;

    const m = deathsBy.get(victim) ?? new Map<string, number>();
    m.set(winner, (m.get(winner) ?? 0) + 1);
    deathsBy.set(victim, m);
  }

  // Expected co-occurrence if instance assignment were random.
  const instances = byInstance.size || 1;
  const players = new Set(runs.map(identity)).size || 1;
  const expected = runs.length / Math.max(1, instances) / Math.max(1, players);

  const dyads: DyadScore[] = [];
  for (const [k, p] of pairs) {
    const [a, b] = k.split('|');
    const total = p.flowAB + p.flowBA;
    const asymmetry = total > 0 ? Math.abs(p.flowAB - p.flowBA) / total : 0;

    // Partner entropy, expressed as concentration: an honest player dies to
    // many different killers, a feeder dies to one.
    const deaths = deathsBy.get(a);
    let concentration = 0;
    if (deaths !== undefined) {
      let sum = 0;
      for (const v of deaths.values()) sum += v;
      concentration = sum > 0 ? (deaths.get(b) ?? 0) / sum : 0;
    }

    const coRatio = p.co / Math.max(0.5, expected);
    const score =
      Math.min(4, coRatio) * 1.0 +
      asymmetry * 2.0 +
      concentration * 3.0 +
      Math.min(1, p.lowResistance / 5) * 3.0 +
      Math.min(1, p.syncedJoins / 5) * 2.0 +
      Math.min(2, total / 5000) * 1.5;

    dyads.push({
      a,
      b,
      coOccurrence: p.co,
      expected,
      netFlow: Math.abs(p.flowAB - p.flowBA),
      asymmetry,
      partnerConcentration: concentration,
      lowResistanceDeaths: p.lowResistance,
      syncedJoins: p.syncedJoins,
      score,
    });
  }

  dyads.sort((x, y) => y.score - x.score);
  const scores = dyads.map((d) => d.score).sort((x, y) => x - y);
  const pick = (q: number): number =>
    scores.length === 0 ? 0 : scores[Math.min(scores.length - 1, Math.floor(scores.length * q))];

  return {
    epoch: epochName,
    dyads,
    percentiles: {
      p50: pick(0.5),
      p90: pick(0.9),
      p99: pick(0.99),
      max: scores.length > 0 ? scores[scores.length - 1] : 0,
    },
    // Enforcement is switched on in Phase 18, at a threshold read off real
    // observed data. Until then this function only ever returns numbers.
    observeOnly: true,
  };
}

/**
 * A death with no fight in it: short life after crossing a mass threshold, and
 * no boost spent trying to escape.
 */
function looksLikeAFeed(r: RunRecord): boolean {
  let boostTicks = 0;
  for (let i = 2; i < r.inputLog.length; i += 3) {
    if (r.inputLog[i] === 1) boostTicks++;
  }
  const samples = r.inputLog.length / 3;
  const boostFraction = samples > 0 ? boostTicks / samples : 0;
  const grewThenDied = r.peakMass > 200 && r.durationMs < 120_000;
  return grewThenDied && boostFraction < 0.01;
}
