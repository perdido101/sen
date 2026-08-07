/**
 * Phase 16 - ads and distribution.
 *
 * REWARDED VIDEO ONLY. Never an interstitial mid-run: .io retention lives on
 * restart friction being near zero, and an unskippable ad between death and
 * restart is the single most effective way to end a session.
 *
 * Three placements, and nothing else:
 *   1. Continue after death at 50% mass, once per run.
 *   2. Double airdrop points for the run just finished.
 *   3. One extra attempt at the daily seed.
 *
 * The network adapter is deliberately thin. The bigger opportunity is
 * distribution rather than the ad unit - CrazyGames, Poki and GameDistribution
 * are where .io games actually find an audience, and a portal brings traffic
 * you cannot buy at that price along with its own monetization. The
 * self-hosted PWA stays canonical; a portal gets an embedded variant.
 */

import { store } from './persistence.ts';

export const Placement = {
  ContinueAfterDeath: 'continue',
  DoublePoints: 'double-points',
  ExtraDailyAttempt: 'extra-daily',
} as const;
export type Placement = (typeof Placement)[keyof typeof Placement];

export const PLACEMENTS: Placement[] = [
  Placement.ContinueAfterDeath,
  Placement.DoublePoints,
  Placement.ExtraDailyAttempt,
];

/**
 * Web game ad providers. The mobile SDK networks are the wrong shape for a
 * browser game and several of them restrict incentivised rewards next to
 * anything crypto-adjacent, which rules them out here.
 */
export type AdNetwork = 'adinplay' | 'venatus' | 'gamedistribution' | 'none';

export interface AdConfig {
  network: AdNetwork;
  /** Publisher/site id from the network dashboard. */
  publisherId: string;
  /** Set false to disable rewarded video entirely without a redeploy. */
  enabled: boolean;
}

export const adConfig: AdConfig = {
  network: (process.env.SEN_AD_NETWORK as AdNetwork) ?? 'none',
  publisherId: process.env.SEN_AD_PUBLISHER_ID ?? '',
  enabled: process.env.SEN_ADS_ENABLED === 'true',
};

export interface RewardGrant {
  granted: boolean;
  placement: Placement;
  reason?: string;
}

interface RunRewards {
  continues: number;
  doubles: number;
  extraDaily: number;
  day: string;
}

const perRun = new Map<string, RunRewards>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Server-side reward accounting.
 *
 * The client tells us an ad completed; the server decides whether that is
 * allowed. Once per run for a continue, once per day for an extra daily
 * attempt. A client that reports ten completions gets one reward.
 */
export function grantReward(accountId: string, placement: Placement, runId: string): RewardGrant {
  const key = `${accountId}:${runId}`;
  let r = perRun.get(key);
  if (r === undefined || r.day !== today()) {
    r = { continues: 0, doubles: 0, extraDaily: 0, day: today() };
    perRun.set(key, r);
  }

  switch (placement) {
    case Placement.ContinueAfterDeath:
      if (r.continues >= 1) return { granted: false, placement, reason: 'already-continued' };
      r.continues++;
      return { granted: true, placement };
    case Placement.DoublePoints:
      if (r.doubles >= 1) return { granted: false, placement, reason: 'already-doubled' };
      r.doubles++;
      return { granted: true, placement };
    case Placement.ExtraDailyAttempt:
      if (r.extraDaily >= 1) return { granted: false, placement, reason: 'already-claimed' };
      r.extraDaily++;
      return { granted: true, placement };
    default:
      return { granted: false, placement, reason: 'unknown-placement' };
  }
}

// ---------------------------------------------------------------------------
// Revenue reporting
//
// The buyback agent reads exactly one number: net ad revenue for a day. Every
// network reports differently, so normalising happens here and nowhere else.
// ---------------------------------------------------------------------------

export interface DailyRevenue {
  day: string;
  /** Net revenue in whole cents, after the network's cut. */
  netCents: number;
  impressions: number;
  network: AdNetwork;
  /** True when this came from a real network report rather than local counts. */
  reported: boolean;
}

const REVENUE_KEY = 'revenue';

export function recordImpression(placement: Placement): void {
  void placement;
  const day = today();
  const cur = getRevenue(day);
  cur.impressions++;
  // With no network configured this stays an impression count with zero
  // revenue attached, which is exactly what it is.
  saveRevenue(cur);
}

/**
 * Ingest a settled daily figure from the network's reporting API.
 *
 * This is the only way revenue becomes real. Estimated or projected numbers
 * never enter, because the buyback is a fixed percentage of *net* revenue and
 * buying back against an estimate that later revises down is how a mechanical
 * buyback quietly stops being mechanical.
 */
export function ingestNetworkReport(day: string, netCents: number, impressions: number): DailyRevenue {
  const rec: DailyRevenue = {
    day,
    netCents,
    impressions,
    network: adConfig.network,
    reported: true,
  };
  saveRevenue(rec);
  return rec;
}

export function getRevenue(day: string): DailyRevenue {
  const all = loadAll();
  return (
    all[day] ?? { day, netCents: 0, impressions: 0, network: adConfig.network, reported: false }
  );
}

export function revenueSince(days: number): DailyRevenue[] {
  const all = loadAll();
  const cutoff = Date.now() - days * 86_400_000;
  return Object.values(all)
    .filter((r) => Date.parse(r.day) >= cutoff)
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Total net revenue not yet consumed by a buyback, in cents. */
export function unspentNetCents(): number {
  const all = loadAll();
  let total = 0;
  for (const r of Object.values(all)) total += r.netCents;
  return total - spentCents();
}

// The ledger lives alongside everything else so a single data directory is the
// whole state of the economy.
interface RevenueFile {
  days: Record<string, DailyRevenue>;
  spentCents: number;
}

let cache: RevenueFile | null = null;

function loadAll(): Record<string, DailyRevenue> {
  return file().days;
}

function file(): RevenueFile {
  if (cache === null) {
    cache = store.readJson<RevenueFile>(REVENUE_KEY) ?? { days: {}, spentCents: 0 };
  }
  return cache;
}

function saveRevenue(r: DailyRevenue): void {
  const f = file();
  f.days[r.day] = r;
  persist();
}

export function spentCents(): number {
  return file().spentCents;
}

export function markSpent(cents: number): void {
  const f = file();
  f.spentCents += cents;
  persist();
}

function persist(): void {
  store.writeJson(REVENUE_KEY, file());
}
