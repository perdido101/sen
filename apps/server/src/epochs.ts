/**
 * Phase 18 - airdrop epochs and daily-seed tournaments.
 *
 * Points are earned by playing, weekly, and there are three brakes on sybil
 * farming, all of which have to hold at once:
 *
 *   1. A hard cap per account per epoch.
 *   2. Points require a validated replay (Phase 14). No replay, no points.
 *   3. Phase 15's collusion scores, at a threshold read off real observed
 *      data rather than guessed at.
 *
 * Claiming requires linking a wallet. Playing never does.
 *
 * Daily-seed tournaments are free entry: everyone plays the same world, prizes
 * come from the treasury, and the leaderboard is built from validated replays
 * only. Free entry means no stake from players, which keeps this a promotion
 * rather than a wager - keep it that way.
 */

import { store, type RunRecord } from './persistence.ts';
import { analyse } from './collusion.ts';
import { rankOf } from '@sen/sim';

/** Hard cap per account per epoch. The main sybil brake. */
export const EPOCH_POINT_CAP = 1000;
export const EPOCH_MS = 7 * 24 * 60 * 60 * 1000;

/** Collusion score above which an account is excluded. Set from real data. */
export const COLLUSION_THRESHOLD = Number(process.env.SEN_COLLUSION_THRESHOLD ?? 7.5);
/** Enforcement is off until a real distribution has been reviewed. */
export const COLLUSION_ENFORCEMENT = process.env.SEN_COLLUSION_ENFORCE === 'true';

export interface EpochPoints {
  accountId: string;
  rankPoints: number;
  badgePoints: number;
  tournamentPoints: number;
  /** Before the cap, so the cap's effect is visible rather than hidden. */
  rawTotal: number;
  total: number;
  capped: boolean;
  runsCounted: number;
  runsRejected: number;
  rejectedReasons: string[];
  collusionScore: number;
  excluded: boolean;
}

export interface EpochResult {
  epoch: string;
  start: number;
  end: number;
  points: EpochPoints[];
  totalDistributed: number;
  collusionEnforced: boolean;
  observeOnlyScores: { p50: number; p90: number; p99: number; max: number };
}

export function epochName(at = Date.now()): string {
  const week = Math.floor(at / EPOCH_MS);
  return `epoch-${week}`;
}

export function epochBounds(name: string): { start: number; end: number } {
  const week = Number(name.replace('epoch-', ''));
  return { start: week * EPOCH_MS, end: (week + 1) * EPOCH_MS };
}

/**
 * Points for one run.
 *
 * Deliberately shallow: highest rank reached, badges newly unlocked,
 * tournament placement. Nothing here rewards session length, because "points
 * per hour" is the mechanic that turns a game into a job and a farm.
 */
export function pointsForRun(r: RunRecord, newBadges: number, placement: number): number {
  const rank = rankOf(r.peakMass);
  const rankPoints = [0, 2, 5, 12, 25, 50, 90, 150][rank] ?? 0;
  const badgePoints = newBadges * 8;
  const tournamentPoints =
    placement === 1 ? 120 : placement === 2 ? 80 : placement === 3 ? 50 : placement > 0 && placement <= 10 ? 20 : 0;
  return rankPoints + badgePoints + tournamentPoints;
}

/**
 * Settle an epoch.
 *
 * @param validate re-sims a run and returns whether it reproduces. Injected so
 *                 the settlement logic can be tested without a world, and so
 *                 the expensive re-sim can be batched or moved off-box.
 */
export function settleEpoch(
  name: string,
  validate: (r: RunRecord) => boolean,
  badgesForRun: (r: RunRecord) => number = () => 0,
  placements: Map<string, number> = new Map(),
): EpochResult {
  const { start, end } = epochBounds(name);
  const runs = store.runs(start).filter((r) => r.at < end);

  const report = analyse(start, end, name);
  const scoreFor = new Map<string, number>();
  for (const d of report.dyads) {
    scoreFor.set(d.a, Math.max(scoreFor.get(d.a) ?? 0, d.score));
    scoreFor.set(d.b, Math.max(scoreFor.get(d.b) ?? 0, d.score));
  }

  const byAccount = new Map<string, EpochPoints>();
  const idOf = (r: RunRecord): string => r.accountId ?? `anon:${r.name}`;

  for (const r of runs) {
    const id = idOf(r);
    let p = byAccount.get(id);
    if (p === undefined) {
      p = {
        accountId: id,
        rankPoints: 0,
        badgePoints: 0,
        tournamentPoints: 0,
        rawTotal: 0,
        total: 0,
        capped: false,
        runsCounted: 0,
        runsRejected: 0,
        rejectedReasons: [],
        collusionScore: scoreFor.get(id) ?? 0,
        excluded: false,
      };
      byAccount.set(id, p);
    }

    // No replay, no points. This is the ground truth behind every leaderboard
    // and every airdrop entry, and it is nearly free because Brief 1's sim is
    // deterministic.
    if (!validate(r)) {
      p.runsRejected++;
      if (!p.rejectedReasons.includes('replay-invalid')) p.rejectedReasons.push('replay-invalid');
      continue;
    }
    if (r.flags.length > 0) {
      p.runsRejected++;
      for (const f of r.flags) if (!p.rejectedReasons.includes(f)) p.rejectedReasons.push(f);
      continue;
    }

    const rank = rankOf(r.peakMass);
    p.rankPoints += [0, 2, 5, 12, 25, 50, 90, 150][rank] ?? 0;
    p.badgePoints += badgesForRun(r) * 8;
    const place = placements.get(r.id) ?? 0;
    p.tournamentPoints +=
      place === 1 ? 120 : place === 2 ? 80 : place === 3 ? 50 : place > 0 && place <= 10 ? 20 : 0;
    p.runsCounted++;
  }

  let totalDistributed = 0;
  for (const p of byAccount.values()) {
    p.rawTotal = p.rankPoints + p.badgePoints + p.tournamentPoints;
    p.total = Math.min(EPOCH_POINT_CAP, p.rawTotal);
    p.capped = p.rawTotal > EPOCH_POINT_CAP;

    if (COLLUSION_ENFORCEMENT && p.collusionScore >= COLLUSION_THRESHOLD) {
      p.excluded = true;
      p.total = 0;
    }
    totalDistributed += p.total;
    if (p.total > 0) store.addScore(name, p.accountId, p.total);
  }

  return {
    epoch: name,
    start,
    end,
    points: [...byAccount.values()].sort((a, b) => b.total - a.total),
    totalDistributed,
    collusionEnforced: COLLUSION_ENFORCEMENT,
    observeOnlyScores: report.percentiles,
  };
}

// ---------------------------------------------------------------------------
// Daily seed tournaments
// ---------------------------------------------------------------------------

export function dailySeed(at = Date.now()): number {
  const d = new Date(at);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export interface TournamentEntry {
  runId: string;
  accountId: string;
  name: string;
  peakMass: number;
  validated: boolean;
  placement: number;
}

/**
 * Today's board, built from validated replays only.
 *
 * An unvalidated run is not "pending" and not shown with an asterisk - it is
 * simply not on the board. A leaderboard that shows unverified entries is a
 * leaderboard people learn to distrust.
 */
export function tournamentBoard(
  seed: number,
  validate: (r: RunRecord) => boolean,
  limit = 100,
): TournamentEntry[] {
  const dayStart = Date.now() - 86_400_000;
  const runs = store.runs(dayStart).filter((r) => r.seed === seed);

  const best = new Map<string, RunRecord>();
  for (const r of runs) {
    const id = r.accountId ?? `anon:${r.name}`;
    const cur = best.get(id);
    if (cur === undefined || r.peakMass > cur.peakMass) best.set(id, r);
  }

  const entries: TournamentEntry[] = [];
  for (const [id, r] of best) {
    if (r.flags.length > 0) continue;
    if (!validate(r)) continue;
    entries.push({
      runId: r.id,
      accountId: id,
      name: r.name,
      peakMass: r.peakMass,
      validated: true,
      placement: 0,
    });
  }

  entries.sort((a, b) => b.peakMass - a.peakMass);
  entries.forEach((e, i) => (e.placement = i + 1));
  return entries.slice(0, limit);
}
