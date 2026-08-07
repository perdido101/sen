/**
 * SUPER EL NINO - boot.
 *
 * Publisher: WildBox.
 */

import './styles.css';
import { Application } from 'pixi.js';
import { Game } from './app/game.ts';
import { loadTerrain } from './app/loadTerrain.ts';
import { registerSW } from './pwa/register.ts';

async function boot(): Promise<void> {
  const stage = document.getElementById('stage')!;

  const app = new Application();
  await app.init({
    background: 0x0a1420,
    resizeTo: window,
    antialias: true,
    // A single GL backend keeps the procedural art pipeline predictable
    // across the phones this has to hold 60fps on.
    preference: 'webgl',
    powerPreference: 'high-performance',
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
  });
  stage.append(app.canvas);

  const terrain = await loadTerrain();
  const game = new Game(app, terrain);
  void game;

  registerSW();
}

boot().catch((err: unknown) => {
  // A dead boot should say so rather than showing a black rectangle forever.
  const ui = document.getElementById('ui');
  if (ui !== null) {
    ui.innerHTML =
      '<div class="panel"><div class="over-rank">Storm failed to form</div>' +
      `<div class="tagline">${String(err)}</div></div>`;
  }
  console.error(err);
});
