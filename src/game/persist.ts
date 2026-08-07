/**
 * localStorage persistence. Keys are all slug-safe - never a tilde in a
 * storage key, a filename, a package name or a route.
 */

import { BADGE_IDS, type BadgeId } from './badges.ts';

const KEY = 'superelnino.save.v1';

export interface Save {
  badges: BadgeId[];
  runs: number;
  bestMass: number;
  bestRank: number;
  wins: number;
  installPromptDismissed: boolean;
  sound: boolean;
  calm: boolean;
  debug: boolean;
  harsh: boolean;
}

const DEFAULT: Save = {
  badges: [],
  runs: 0,
  bestMass: 0,
  bestRank: 1,
  wins: 0,
  installPromptDismissed: false,
  sound: true,
  calm: false,
  debug: false,
  harsh: false,
};

let cache: Save | null = null;

export function load(): Save {
  if (cache !== null) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Save>;
      const valid = new Set<string>(BADGE_IDS);
      cache = {
        ...DEFAULT,
        ...parsed,
        badges: (parsed.badges ?? []).filter((b) => valid.has(b)),
      };
      return cache;
    }
  } catch {
    // Corrupt save: start clean rather than dead.
  }
  cache = { ...DEFAULT };
  return cache;
}

export function save(patch: Partial<Save>): Save {
  const s = { ...load(), ...patch };
  cache = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode / quota: the run still plays, it just does not persist.
  }
  return s;
}

export function unlock(ids: BadgeId[]): BadgeId[] {
  if (ids.length === 0) return [];
  const s = load();
  const have = new Set(s.badges);
  const fresh = ids.filter((i) => !have.has(i));
  if (fresh.length === 0) return [];
  save({ badges: [...s.badges, ...fresh] });
  return fresh;
}

/** Awards the meta badges that depend on totals rather than a single run. */
export function awardMeta(): BadgeId[] {
  const s = load();
  const out: BadgeId[] = [];
  if (s.runs >= 10) out.push('runs10');
  if (s.runs >= 50) out.push('runs50');
  if (s.runs >= 200) out.push('runs200');

  // Full Sky: every other badge earned.
  const have = new Set(s.badges);
  const others = BADGE_IDS.filter((b) => b !== 'allBadges');
  if (others.every((b) => have.has(b) || out.includes(b))) out.push('allBadges');

  return unlock(out);
}
