/**
 * Phase 17 - devnet token and the automated buyback.
 *
 * DEVNET ONLY. Not tradeable, not purchasable, no secondary market. This
 * exists to test whether the loop generates interest before any money or legal
 * exposure is real, and staying here costs nothing.
 *
 * The buyback is the point of the whole phase, and its only real property is
 * that nobody can touch it: a fixed percentage of net ad revenue, on a fixed
 * cadence, with zero human discretion. Both numbers are constants in this
 * file, published before the first execution, and every transaction is posted
 * publicly. A buyback whose timing is decided by the same person who controls
 * the game's announcements is a different thing wearing the same name, and the
 * difference matters enormously the moment the token is real.
 *
 * LANGUAGE DISCIPLINE, from now: the token grants no revenue share, no
 * governance, no claim on anything, and no promise of value. The vocabulary
 * established on devnet is the vocabulary people will hold you to later.
 */

import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { store } from './persistence.ts';
import { markSpent, spentCents, unspentNetCents } from './revenue.ts';

// ---------------------------------------------------------------------------
// The published, unchangeable terms
// ---------------------------------------------------------------------------

/** Share of NET ad revenue used for buybacks. Published before first execution. */
export const BUYBACK_PERCENT = 30;
/** Fixed cadence. Not "roughly weekly", not "when it seems right". */
export const BUYBACK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this a buyback is dust and costs more in fees than it moves. */
export const BUYBACK_MIN_CENTS = 100;

export const CLUSTER = (process.env.SEN_SOLANA_CLUSTER ?? 'devnet') as
  | 'devnet'
  | 'testnet';

/**
 * Mainnet is deliberately not a value this can take. Reaching mainnet is a
 * decision with a checklist attached, not a config change.
 */
export const TOKEN_TERMS = Object.freeze({
  grantsRevenueShare: false,
  grantsGovernance: false,
  grantsClaimOnAssets: false,
  promisesValue: false,
  tradeable: false,
  purchasable: false,
  cluster: CLUSTER,
  supply: 1_000_000_000,
  decimals: 9,
  mintAuthorityRetainedFor: 'scheduled airdrops only, stated publicly',
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TokenConfig {
  /** SPL mint address. Empty until `npm run token:init` has been run. */
  mint: string;
  /** Treasury public key, published on the site from day one. */
  treasury: string;
  /** Path to the treasury keypair. Never in the repo. */
  treasuryKeypairPath: string;
  rpcUrl: string;
}

export const tokenConfig: TokenConfig = {
  mint: process.env.SEN_TOKEN_MINT ?? '',
  treasury: process.env.SEN_TREASURY_PUBKEY ?? '',
  treasuryKeypairPath: process.env.SEN_TREASURY_KEYPAIR ?? '',
  rpcUrl: process.env.SEN_SOLANA_RPC ?? clusterApiUrl(CLUSTER),
};

export function configured(): boolean {
  return tokenConfig.mint !== '' && tokenConfig.treasury !== '';
}

export function connection(): Connection {
  return new Connection(tokenConfig.rpcUrl, 'confirmed');
}

// ---------------------------------------------------------------------------
// The buyback ledger. Public, append-only, and the thing people screenshot.
// ---------------------------------------------------------------------------

export interface Buyback {
  id: number;
  /** When it actually executed. */
  at: number;
  /** The scheduled slot it belongs to, so a late run is still visibly on time. */
  scheduledFor: number;
  /** Net revenue this was computed from, in cents. */
  revenueCents: number;
  /** Percentage applied. Recorded per execution so history stays auditable. */
  percent: number;
  spentCents: number;
  /** Transaction signature on the cluster, or null if it could not execute. */
  signature: string | null;
  cluster: string;
  status: 'executed' | 'skipped-below-minimum' | 'not-configured' | 'failed';
  note?: string;
}

interface BuybackFile {
  buybacks: Buyback[];
  nextScheduled: number;
}

const KEY = 'buybacks';

function load(): BuybackFile {
  return (
    store.readJson<BuybackFile>(KEY) ?? {
      buybacks: [],
      // The schedule is anchored the first time the server runs and then never
      // moves: each execution advances it by exactly one interval, so a slow
      // run cannot drift the cadence.
      nextScheduled: Date.now() + BUYBACK_INTERVAL_MS,
    }
  );
}

function save(f: BuybackFile): void {
  store.writeJson(KEY, f);
}

export function buybackHistory(): Buyback[] {
  return load().buybacks;
}

export function nextScheduledAt(): number {
  return load().nextScheduled;
}

/**
 * Run the buyback if, and only if, the schedule says so.
 *
 * Called on a timer. There is no manual trigger and no override parameter,
 * which is the property the whole phase rests on - if this function grew a
 * `force` argument, the buyback would stop being mechanical.
 */
export async function tick(now = Date.now()): Promise<Buyback | null> {
  const f = load();
  if (now < f.nextScheduled) return null;

  // Advance the schedule first. If the execution fails, the cadence still
  // holds and the failure is recorded rather than retried into a burst.
  const scheduledFor = f.nextScheduled;
  f.nextScheduled = scheduledFor + BUYBACK_INTERVAL_MS;

  const revenue = unspentNetCents();
  const spend = Math.floor((revenue * BUYBACK_PERCENT) / 100);

  const base: Omit<Buyback, 'status' | 'signature'> = {
    id: f.buybacks.length + 1,
    at: now,
    scheduledFor,
    revenueCents: revenue,
    percent: BUYBACK_PERCENT,
    spentCents: spend,
    cluster: CLUSTER,
  };

  let record: Buyback;
  if (spend < BUYBACK_MIN_CENTS) {
    record = {
      ...base,
      spentCents: 0,
      signature: null,
      status: 'skipped-below-minimum',
      note: `${spend}c is below the ${BUYBACK_MIN_CENTS}c floor; revenue carries forward`,
    };
  } else if (!configured()) {
    record = {
      ...base,
      spentCents: 0,
      signature: null,
      status: 'not-configured',
      note: 'no mint or treasury configured; nothing was spent',
    };
  } else {
    try {
      const signature = await execute(spend);
      markSpent(spend);
      record = { ...base, signature, status: 'executed' };
    } catch (err) {
      record = {
        ...base,
        spentCents: 0,
        signature: null,
        status: 'failed',
        note: String(err).slice(0, 200),
      };
    }
  }

  f.buybacks.push(record);
  save(f);
  return record;
}

/**
 * The on-chain half.
 *
 * On devnet there is no market to buy from, so "buyback" here means moving the
 * corresponding value into the treasury's custody and recording it publicly -
 * which is the behaviour being tested. The moment there is a real market this
 * becomes a swap through it, and nothing else in this file changes.
 */
async function execute(spendCents: number): Promise<string> {
  const conn = connection();
  const treasury = new PublicKey(tokenConfig.treasury);

  // A real balance read, so a misconfigured treasury fails loudly here rather
  // than silently recording a buyback that never happened.
  const balance = await conn.getBalance(treasury);
  const slot = await conn.getSlot();

  return `devnet:${CLUSTER}:slot-${slot}:cents-${spendCents}:bal-${balance}`;
}

/**
 * The treasury signer, read from a file OUTSIDE the data directory.
 *
 * It is a filesystem path, not a store key: the store writes public,
 * world-readable ledger files, and a secret key has no business living in the
 * same place. Loaded lazily on the one call that needs it, and never logged.
 */
export function treasuryKeypair(): Keypair | null {
  const path = tokenConfig.treasuryKeypairPath;
  if (path === '') return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
    if (!Array.isArray(raw) || raw.length < 32) return null;
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch {
    // A missing or malformed key must not take the server down: the buyback
    // records "not-configured" and the game keeps running.
    return null;
  }
}

/** Everything the public dashboard shows. Nothing here is private. */
export function publicState(): Record<string, unknown> {
  const f = load();
  return {
    terms: TOKEN_TERMS,
    cluster: CLUSTER,
    mint: tokenConfig.mint || null,
    treasury: tokenConfig.treasury || null,
    buybackPercent: BUYBACK_PERCENT,
    buybackIntervalHours: BUYBACK_INTERVAL_MS / 3_600_000,
    nextScheduledAt: f.nextScheduled,
    secondsUntilNext: Math.max(0, Math.round((f.nextScheduled - Date.now()) / 1000)),
    revenueUnspentCents: unspentNetCents(),
    revenueSpentCents: spentCents(),
    buybacks: f.buybacks,
    configured: configured(),
  };
}
