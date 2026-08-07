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
const SIM = join(ROOT, 'src/sim');
const BOTS = join(ROOT, 'src/bots');

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

const files = [...walk(SIM), ...walk(BOTS)];
if (files.length === 0) {
  console.error('check:purity found no files under src/sim - wrong path?');
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

if (failures > 0) {
  console.error(`\ncheck:purity FAILED with ${failures} violation(s) across ${files.length} files.`);
  process.exit(1);
}

console.log(`check:purity OK - ${files.length} files in src/sim and src/bots are headless.`);
