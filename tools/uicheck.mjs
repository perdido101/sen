#!/usr/bin/env node
/**
 * Walks the whole shell - menu, settings, badge gallery, game over -
 * screenshotting each screen in portrait and landscape, and asserts there are
 * no dead ends: cold start to death to restart with nowhere to get stuck.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/sen-ui';
const PORT = Number(process.env.SEN_PORT ?? 4173);
const BASE = process.env.SEN_BASE ?? '/';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.SEN_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'],
});

const problems = [];

async function run(label, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => problems.push(`${label}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label}: console ${m.text()}`);
  });
  page.on('requestfailed', (r) => {
    problems.push(`${label}: request failed ${r.url()} (${r.failure()?.errorText})`);
  });

  // Seed before any page script runs. Reloading mid-boot instead would abort
  // the 2.5MB terrain fetch and report a failure the product never had.
  await page.addInitScript(() => {
    // Pretend we have history so the gallery and install prompt have content.
    localStorage.setItem(
      'superelnino.save.v1',
      JSON.stringify({
        badges: ['touchdown', 'landfall', 'warmPool', 'firstBlood', 'coriolis', 'homecoming'],
        runs: 12, bestMass: 1400, bestRank: 5, wins: 0,
        installPromptDismissed: false, sound: false, calm: false, debug: false, harsh: false,
      }),
    );
  });
  await page.goto(`http://localhost:${PORT}${BASE}?debug`, { waitUntil: 'load' });
  await page.waitForSelector('.panel .wordmark', { timeout: 60000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${label}-menu.png` });

  // Settings
  const buttons = await page.$$('.panel:not([hidden]) .row .btn.ghost');
  if (buttons.length < 2) problems.push(`${label}: menu is missing its badge/settings buttons`);
  await buttons[1].click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${label}-settings.png` });

  // Back, then the badge gallery.
  await page.click('.panel:not([hidden]) .btn.ghost:last-of-type');
  await page.waitForTimeout(300);
  const menuBtns = await page.$$('.panel:not([hidden]) .row .btn.ghost');
  if (menuBtns.length < 2) {
    problems.push(`${label}: settings back button did not return to the menu`);
  } else {
    await menuBtns[0].click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${label}-badges.png` });
    await page.click('.panel:not([hidden]) .btn.ghost');
    await page.waitForTimeout(300);
    const back = await page.$('.panel:not([hidden]) .btn.primary');
    if (back === null) problems.push(`${label}: gallery back button did not return to the menu`);
  }

  // Play, die, and land on the game-over card without touching anything.
  await page.click('.panel:not([hidden]) .btn.primary');
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const w = window.__sen.world();
    const p = w.storms[w.playerId];
    // Below MIN_MASS, so the next step dissipates the storm.
    p.mass = 1;
  });
  // The renderer runs on swiftshader here, so wall time and simulated time are
  // not the same thing: the fixed-step loop caps at 5 steps per frame.
  await page.waitForTimeout(9000);
  const overVisible = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.panel')];
    return els.some((e) => !e.hidden && e.querySelector('.over-rank') !== null);
  });
  if (!overVisible) problems.push(`${label}: death did not reach the game-over card`);
  await page.screenshot({ path: `${OUT}/${label}-gameover.png` });

  // And back into a run, so restart is one tap with no dead end.
  await page.click('.panel:not([hidden]) .btn.primary');
  await page.waitForTimeout(900);
  const playing = await page.evaluate(() => window.__sen.phase() === 'playing');
  if (!playing) problems.push(`${label}: "Again" did not start a new run`);

  await page.close();
}

await run('portrait', { width: 720, height: 1280 });
await run('landscape', { width: 1280, height: 720 });
await run('small-portrait', { width: 360, height: 640 });

await browser.close();

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`shell OK - screenshots in ${OUT}`);
