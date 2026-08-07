/**
 * i18n from day one. Zero hardcoded strings anywhere - retrofitting this is
 * miserable, doing it now costs an hour.
 */

import en from './en.ts';
import el from './el.ts';

export type Lang = 'en' | 'el';
export type Key = keyof typeof en;

const TABLES: Record<Lang, Record<string, string>> = { en, el };

let current: Lang = 'en';
const listeners = new Set<() => void>();

export function detectLang(): Lang {
  const stored = localStorage.getItem('sen.lang');
  if (stored === 'en' || stored === 'el') return stored;
  return navigator.language.toLowerCase().startsWith('el') ? 'el' : 'en';
}

export function setLang(l: Lang): void {
  current = l;
  localStorage.setItem('sen.lang', l);
  document.documentElement.lang = l;
  for (const fn of listeners) fn();
}

export function getLang(): Lang {
  return current;
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Missing keys fall back to English, then to the key itself. */
export function t(key: Key | string, vars?: Record<string, string | number>): string {
  let s = TABLES[current][key] ?? TABLES.en[key] ?? key;
  if (vars !== undefined) {
    for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}
