#!/usr/bin/env node
/**
 * CI guard for the architecture rule that protects multiplayer later (§3).
 *
 * Nothing in /src/sim may import PixiJS, howler, window or document. The sim
 * must run in bare Node. Breaking this is what forces a rewrite in six months.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SIM = join(ROOT, 'packages/sim/src/sim');
const BOTS = join(ROOT, 'packages/sim/src/bots');

const BANNED_IMPORTS = [
  /from\s+['"]pixi\.js['"]/,
  /from\s+['"]pixi\.js\/.*['"]/,
  /from\s+['"]howler['"]/,
  /from\s+['"].*\/render\//,
  /from\s+['"].*\/audio\//,
  /from\s+['"].*\/ui\//,
  /import\s*\(\s*['"](pixi\.js|howler)['"]\s*\)/,
];

// Bare identifiers that only exist in a browser.
const BANNED_GLOBALS = [
  /\bwindow\b/,
  /\bdocument\b/,
  /\blocalStorage\b/,
  /\bnavigator\b/,
  /\brequestAnimationFrame\b/,
  /\bHTMLCanvasElement\b/,
  /\bImage\b\s*\(/,
];

// Randomness must go through the seeded PRNG in WorldState.
const BANNED_RANDOM = /Math\s*\.\s*random\s*\(/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The sim, the protocol and the server all run under Node's strip-only
 * TypeScript mode, which cannot handle syntax that emits code. A parameter
 * property or an enum compiles fine and then fails at server boot, which is
 * the worst possible place to find out.
 */
const STRIP_UNSAFE = [
  { re: /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*:/s,
    what: 'a constructor parameter property' },
  { re: /^\s*(export\s+)?(const\s+)?enum\s+\w+/m, what: 'an enum' },
  { re: /^\s*@\w+/m, what: 'a decorator' },
  { re: /\bnamespace\s+\w+\s*\{/, what: 'a namespace' },
];

const STRIP_ROOTS = [
  join(ROOT, 'packages/sim/src'),
  join(ROOT, 'packages/protocol/src'),
  join(ROOT, 'apps/server/src'),
];

const files = [...walk(SIM), ...walk(BOTS)];
if (files.length === 0) {
  console.error('check:purity found no files under packages/sim/src/sim - wrong path?');
  process.exit(1);
}

let failures = 0;

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const code = stripCommentsAndStrings(raw);

  for (const re of BANNED_IMPORTS) {
    if (re.test(raw.replace(/\/\*[\s\S]*?\*\//g, ''))) {
      console.error(`${rel}: banned import matching ${re}`);
      failures++;
    }
  }
  for (const re of BANNED_GLOBALS) {
    const m = code.match(re);
    if (m) {
      console.error(`${rel}: banned browser global "${m[0].trim()}"`);
      failures++;
    }
  }
  if (BANNED_RANDOM.test(code)) {
    console.error(`${rel}: Math.random() - all randomness must go through the seeded PRNG`);
    failures++;
  }
}

for (const root of STRIP_ROOTS) {
  for (const file of walk(root)) {
    const rel = relative(ROOT, file);
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    for (const { re, what } of STRIP_UNSAFE) {
      if (re.test(code)) {
        console.error(`${rel}: ${what} - Node's strip-only mode cannot run this`);
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\ncheck:purity FAILED with ${failures} violation(s) across ${files.length} files.`);
  process.exit(1);
}

const stripped = STRIP_ROOTS.reduce((n, r) => n + walk(r).length, 0);
console.log(
  `check:purity OK - ${files.length} files in packages/sim are headless, ` +
  `${stripped} files across sim/protocol/server are strip-safe.`,
);
