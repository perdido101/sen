/**
 * Strings live here, not in the code.
 *
 * The game ships in English only. The t(key) indirection stays because it
 * costs nothing and keeps every user-facing string in one file - retrofitting
 * that later is miserable, and it is what makes adding a language a data
 * change rather than a code change.
 */

import en from './en.ts';

export type Key = keyof typeof en;

const TABLE: Record<string, string> = en;

/** Missing keys fall back to the key itself, so a typo is visible, not blank. */
export function t(key: Key | string, vars?: Record<string, string | number>): string {
  let s = TABLE[key] ?? key;
  if (vars !== undefined) {
    for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}
