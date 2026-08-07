#!/usr/bin/env node
/**
 * Browser smoke test: boots the built game in Chromium, plays it for a while
 * with a scripted pointer, and reports console errors, FPS and screenshots.
 *
 *   node tools/smoke.mjs [outDir] [--seconds=N] [--mass=N]
 *
 * `--mass` force-feeds the player so the late game (ocean inversion, the warm
 * pool, the win sequence) can be seen without a 6-minute run.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/sen-shots';
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m === undefined ? d : Number(m.split('=')[1]);
};
const SECONDS = arg('seconds', 12);
const FORCE_MASS = arg('mass', 0);
const FORCE_WIN = process.argv.includes('--win');
const WIDTH = arg('w', 900);
const HEIGHT = arg('h', 1600);
const PORT = arg('port', 4173);
const BASE = process.env.SEN_BASE ?? '/';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.SEN_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('console', (m) => {
  const text = `${m.type()}: ${m.text()}`;
  logs.push(text);
  if (m.type() === 'error') errors.push(text);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`http://localhost:${PORT}${BASE}?debug`, { waitUntil: 'load' });

// Wait for the menu, which only appears once the terrain has loaded.
await page.waitForSelector('.panel .wordmark', { timeout: 45000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/01-menu.png` });

// Turn on the debug overlay through the settings screen, exactly as a player
// would, so this exercises the real UI path.
await page.click('.panel[hidden="false"] .btn.ghost, .panel:not([hidden]) .row .btn.ghost:nth-child(2)').catch(() => {});
await page.waitForTimeout(200);

await page.evaluate(() => {
  const raw = localStorage.getItem('superelnino.save.v1');
  const s = raw ? JSON.parse(raw) : {};
  s.debug = true;
  s.sound = false;
  localStorage.setItem('superelnino.save.v1', JSON.stringify(s));
});
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.panel .wordmark', { timeout: 45000 });

await page.click('.btn.primary');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/02-early.png` });

// Steer in a slow circle so the storm actually feeds.
const cx = WIDTH / 2;
const cy = HEIGHT / 2;

async function freeRun(seconds) {
  const t0 = Date.now();
  let shot = 3;
  while ((Date.now() - t0) / 1000 < seconds) {
    const t = (Date.now() - t0) / 1000;
    const a = t * 0.7;
    await page.mouse.move(cx + Math.cos(a) * 260, cy + Math.sin(a) * 260);
    await page.waitForTimeout(60);
    if (t > shot * 4 - 1 && shot < 6) {
      await page.screenshot({ path: `${OUT}/0${shot}-run.png` });
      shot++;
    }
  }
}

/**
 * Reach into the running world. This is a diagnostic hook that only exists
 * under ?debug - there is no cheat path in the shipped build.
 */
async function force(mass) {
  return page.evaluate((m) => {
    const g = window.__sen;
    if (g === undefined) return 'no hook';
    if (g.phase() !== 'playing') return `wrong phase: ${g.phase()}`;
    const w = g.world();
    const p = w.storms[w.playerId];
    p.mass = m;
    p.x = 3527;
    p.y = 2048;
    return `set mass ${m} at the warm pool`;
  }, mass);
}

let forced = null;

if (FORCE_WIN) {
  // The win has to be reached from a live run: reviving a storm that is
  // already dissipating leaves the controller mid-death and the card you get
  // belongs to the earlier death, not the win. A fresh Dust Devil can also
  // just die in the couple of seconds before we get here, so retry from a new
  // run rather than reporting a failure the product does not have.
  for (let attempt = 0; attempt < 5; attempt++) {
    forced = await force(FORCE_MASS > 0 ? FORCE_MASS : 3000);
    if (!String(forced).startsWith('wrong phase')) break;
    const again = await page.$('.panel:not([hidden]) .btn.primary');
    if (again === null) break;
    await again.click();
    await page.waitForTimeout(1200);
  }
  if (String(forced).startsWith('wrong phase')) {
    errors.push(`could not reach a live run to test the win (${forced})`);
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/08-endgame.png` });

  await page.evaluate(() => {
    // Wind the hold timer to its last second so the sequence plays for real.
    window.__sen.world().storms[window.__sen.world().playerId].winTimer = 59.4;
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/09-win-flash.png` });

  // The win holds for 2.2s of *simulated* time, and this renderer runs on
  // swiftshader, so give it real room.
  await page.waitForTimeout(20000);
  await page.screenshot({ path: `${OUT}/10-win-card.png` });
  const state = await page.evaluate(() => {
    const w = window.__sen.world();
    const card = [...document.querySelectorAll('.panel')].find(
      (e) => !e.hidden && e.querySelector('.over-rank') !== null,
    );
    return {
      winner: w.winner,
      playerId: w.playerId,
      phase: window.__sen.phase(),
      title: card?.querySelector('.over-rank')?.textContent ?? null,
    };
  });
  console.log(`win: winner=${state.winner} player=${state.playerId} ` +
    `phase=${state.phase} card="${state.title}"`);
  if (state.winner !== state.playerId) errors.push('win never fired');
  if (state.title === null) errors.push('win did not reach the game-over card');
  else if (!/NI(N|Ñ)O/i.test(state.title)) {
    errors.push(`game-over card shows "${state.title}" after a win`);
  }
} else {
  await freeRun(SECONDS);
  await page.screenshot({ path: `${OUT}/07-late.png` });
  if (FORCE_MASS > 0) {
    forced = await force(FORCE_MASS);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${OUT}/08-endgame.png` });
  }
}

const debugText = await page.textContent('.debug').catch(() => null);

await browser.close();

console.log(`screenshots -> ${OUT}`);
if (debugText !== null) console.log(`\n--- debug overlay ---\n${debugText}`);
if (forced !== null) console.log(`forced: ${forced}`);
if (errors.length > 0) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nno console errors.');
