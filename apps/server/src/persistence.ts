/**
 * Phase 13 - identity and persistence.
 *
 * Anonymous play by default: a device id, no signup, straight into the game.
 * Friction here costs more players than anything else in the brief, so nothing
 * in this file is ever on the path between opening the page and playing.
 *
 * An optional account upgrade (email or OAuth) claims an existing device id's
 * history rather than starting fresh - that is the whole point of keying
 * everything on device id from the start.
 *
 * A wallet is never required to play, and is linked only at claim time.
 *
 * STORAGE: the brief specifies Postgres (Supabase) for durable records and
 * Redis for live leaderboards and rate limits. Both are behind the Store
 * interface below. The default implementation is a file-backed store so the
 * whole stack runs, and is testable, with no external service; point
 * SEN_DATABASE_URL / SEN_REDIS_URL at the real ones and swap the driver.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DATA_DIR = process.env.SEN_DATA_DIR ?? join(process.cwd(), '.data');

export interface Account {
  /** Stable across devices once upgraded; starts life as the device id. */
  id: string;
  deviceIds: string[];
  /** Null until the player chooses to upgrade. Never required to play. */
  email: string | null;
  /** Null until claim time. Never required to play. */
  wallet: string | null;
  createdAt: number;
  badges: string[];
  runs: number;
  bestMass: number;
  bestRank: number;
  wins: number;
}

export interface RunRecord {
  id: string;
  clientId: number;
  accountId?: string;
  name: string;
  instance: string;
  seed: number;
  stormId: number;
  peakMass: number;
  finalMass: number;
  durationMs: number;
  /** Flat [tick, angle, boost] triples. The ground truth for replay checks. */
  inputLog: number[];
  flags: string[];
  at: number;
  /** Set by the Phase 14 re-sim. Points require this to be true. */
  replayValidated?: boolean;
  /**
   * The input log hit its cap and covers only the start of the run. A re-sim
   * of it proves the opening was played honestly, not the whole run, and that
   * distinction is recorded rather than quietly ignored.
   */
  inputLogTruncated?: boolean;
  /** Who killed this run, for the Phase 15 mass-flow graph. */
  killedBy?: number;
  massTransferred?: number;
}

/**
 * The storage seam. Everything above it is business logic that does not care
 * whether it is talking to Postgres or a file.
 */
export interface Store {
  getAccount(id: string): Account | undefined;
  putAccount(a: Account): void;
  allAccounts(): Account[];
  appendRun(r: RunRecord): void;
  runs(sinceMs?: number): RunRecord[];
  /** Live leaderboard; Redis sorted set in production. */
  leaderboard(epoch: string, limit: number): { id: string; score: number }[];
  addScore(epoch: string, id: string, score: number): void;
  /** Small keyed documents: the revenue ledger, the buyback log, epoch state. */
  readJson<T>(key: string): T | undefined;
  writeJson(key: string, value: unknown): void;
}

// ---------------------------------------------------------------------------
// File-backed default. Durable enough to develop and test the whole economy
// against, and small enough to read when something looks wrong.
// ---------------------------------------------------------------------------

class FileStore implements Store {
  private accounts = new Map<string, Account>();
  private runCache: RunRecord[] | null = null;
  private scores = new Map<string, Map<string, number>>();

  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'accounts.json');
    if (existsSync(p)) {
      try {
        for (const a of JSON.parse(readFileSync(p, 'utf8')) as Account[]) {
          this.accounts.set(a.id, a);
        }
      } catch {
        // A corrupt account file must not stop people playing.
      }
    }
    const s = join(dir, 'scores.json');
    if (existsSync(s)) {
      try {
        const raw = JSON.parse(readFileSync(s, 'utf8')) as Record<string, Record<string, number>>;
        for (const [epoch, m] of Object.entries(raw)) {
          this.scores.set(epoch, new Map(Object.entries(m)));
        }
      } catch {
        // ditto
      }
    }
  }

  private flushAccounts(): void {
    writeFileSync(join(this.dir, 'accounts.json'), JSON.stringify([...this.accounts.values()]));
  }

  private flushScores(): void {
    const out: Record<string, Record<string, number>> = {};
    for (const [epoch, m] of this.scores) out[epoch] = Object.fromEntries(m);
    writeFileSync(join(this.dir, 'scores.json'), JSON.stringify(out));
  }

  getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  putAccount(a: Account): void {
    this.accounts.set(a.id, a);
    this.flushAccounts();
  }

  allAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  appendRun(r: RunRecord): void {
    const p = join(this.dir, 'runs.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(r) + '\n');
    if (this.runCache !== null) this.runCache.push(r);
  }

  runs(sinceMs = 0): RunRecord[] {
    if (this.runCache === null) {
      this.runCache = [];
      const p = join(this.dir, 'runs.jsonl');
      if (existsSync(p)) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (line.trim() === '') continue;
          try {
            this.runCache.push(JSON.parse(line) as RunRecord);
          } catch {
            // skip a torn line rather than losing the file
          }
        }
      }
    }
    return sinceMs > 0 ? this.runCache.filter((r) => r.at >= sinceMs) : this.runCache;
  }

  leaderboard(epoch: string, limit: number): { id: string; score: number }[] {
    const m = this.scores.get(epoch);
    if (m === undefined) return [];
    return [...m.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  addScore(epoch: string, id: string, score: number): void {
    let m = this.scores.get(epoch);
    if (m === undefined) {
      m = new Map();
      this.scores.set(epoch, m);
    }
    m.set(id, (m.get(id) ?? 0) + score);
    this.flushScores();
  }

  readJson<T>(key: string): T | undefined {
    const p = join(this.dir, `${key}.json`);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  writeJson(key: string, value: unknown): void {
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(value, null, 2));
  }
}

export const store: Store = new FileStore(DATA_DIR);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** A device id is enough to play. Nothing here blocks or prompts. */
export function accountForDevice(deviceId: string): Account {
  const id = deviceHash(deviceId);
  const existing = store.getAccount(id);
  if (existing !== undefined) return existing;
  const a: Account = {
    id,
    deviceIds: [deviceId],
    email: null,
    wallet: null,
    createdAt: Date.now(),
    badges: [],
    runs: 0,
    bestMass: 0,
    bestRank: 1,
    wins: 0,
  };
  store.putAccount(a);
  return a;
}

function deviceHash(deviceId: string): string {
  return createHash('sha256').update(`sen:${deviceId}`).digest('hex').slice(0, 32);
}

/**
 * Upgrade an anonymous device to an account without losing anything: the
 * device's history is merged, not replaced. Losing a session's badges at
 * signup is the fastest way to teach people not to sign up.
 */
export function upgradeAccount(deviceId: string, email: string): Account {
  const anon = accountForDevice(deviceId);
  const existing = store.allAccounts().find((a) => a.email === email);
  if (existing === undefined) {
    anon.email = email;
    store.putAccount(anon);
    return anon;
  }
  existing.deviceIds = [...new Set([...existing.deviceIds, ...anon.deviceIds])];
  existing.badges = [...new Set([...existing.badges, ...anon.badges])];
  existing.runs += anon.runs;
  existing.wins += anon.wins;
  existing.bestMass = Math.max(existing.bestMass, anon.bestMass);
  existing.bestRank = Math.max(existing.bestRank, anon.bestRank);
  store.putAccount(existing);
  return existing;
}

/** Linked only at claim time, and never a condition of playing. */
export function linkWallet(accountId: string, wallet: string): Account | undefined {
  const a = store.getAccount(accountId);
  if (a === undefined) return undefined;
  a.wallet = wallet;
  store.putAccount(a);
  return a;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunInput {
  clientId: number;
  accountId?: string;
  name: string;
  instance: string;
  seed: number;
  stormId: number;
  peakMass: number;
  finalMass: number;
  durationMs: number;
  inputLog: number[];
  /** The log covers only the start of the run; see RunRecord. */
  inputLogTruncated?: boolean;
  flags: string[];
  killedBy?: number;
  massTransferred?: number;
}

export function recordRun(r: RunInput): RunRecord {
  const rec: RunRecord = { ...r, id: randomUUID(), at: Date.now() };
  store.appendRun(rec);
  if (r.accountId !== undefined) {
    const a = store.getAccount(r.accountId);
    if (a !== undefined) {
      a.runs++;
      a.bestMass = Math.max(a.bestMass, r.peakMass);
      store.putAccount(a);
    }
  }
  return rec;
}
