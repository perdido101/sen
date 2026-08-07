/**
 * Share card: a canvas-generated 1080x1920 with the final rank, mass, badges,
 * the shape of the ocean bloom, the seed code and the domain.
 *
 * The bloom is the point. It is the scoreboard, the threat display and the
 * marketing image in one object, so it gets the top third of the card.
 */

import { SST_H, SST_W, WORLD_H, WORLD_W, RANKS, clamp } from '@sen/sim/sim/constants.ts';
import type { WorldState } from '@sen/sim/sim/types.ts';
import { t } from '../i18n/index.ts';
import { badgeIcon } from '../ui/badgeIcons.ts';
import type { BadgeId } from './badges.ts';

const W = 1080;
const H = 1920;

export interface CardModel {
  rank: number;
  peakMass: number;
  seed: number;
  badges: BadgeId[];
  won: boolean;
}

async function svgToImage(svg: string, size: number): Promise<HTMLImageElement | null> {
  const wrapped = svg.replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(wrapped)}`;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function buildShareCard(w: WorldState, m: CardModel): Promise<Blob | null> {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (ctx === null) return null;

  ctx.fillStyle = '#0A1420';
  ctx.fillRect(0, 0, W, H);

  // --- the ocean, and what the player did to it ----------------------------
  const mapH = Math.round((W * WORLD_H) / WORLD_W);
  const mapY = 300;

  const cell = W / SST_W;
  const cellH = mapH / SST_H;
  for (let y = 0; y < SST_H; y++) {
    for (let x = 0; x < SST_W; x++) {
      const i = y * SST_W + x;
      const isSea = w.sstBase[i] > 0;
      if (!isSea) continue;
      ctx.fillStyle = '#16283c';
      ctx.fillRect(x * cell, mapY + y * cellH, cell + 1, cellH + 1);
    }
  }
  // Land silhouette, sampled coarsely off the data map.
  const td = w.terrain;
  for (let y = 0; y < SST_H; y++) {
    for (let x = 0; x < SST_W; x++) {
      const sx = Math.floor((x / SST_W) * td.w);
      const sy = Math.floor((y / SST_H) * td.h);
      const r = td.data[(sy * td.w + sx) * 4];
      if (r < 64) continue;
      ctx.fillStyle = r > 192 ? '#c8d6e2' : '#39492f';
      ctx.fillRect(x * cell, mapY + y * cellH, cell + 1, cellH + 1);
    }
  }
  // The bloom.
  for (let y = 0; y < SST_H; y++) {
    for (let x = 0; x < SST_W; x++) {
      const i = y * SST_W + x;
      const excess = w.sst[i] - w.sstBase[i];
      if (excess <= 2 || w.sstBase[i] <= 0) continue;
      const k = clamp(excess / 90, 0, 1);
      ctx.fillStyle = `rgba(201,67,43,${k.toFixed(3)})`;
      ctx.fillRect(x * cell, mapY + y * cellH, cell + 1, cellH + 1);
    }
  }

  // --- headline ------------------------------------------------------------
  const def = RANKS[clamp(m.rank, 1, RANKS.length) - 1];
  ctx.textAlign = 'center';

  ctx.fillStyle = '#E4EBF2';
  ctx.font = '800 66px "Fira Sans Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(t('app.title.a'), W / 2, 130);

  ctx.fillStyle = '#FFC23C';
  ctx.font = '800 118px "Fira Sans Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(t('app.title.b'), W / 2, 244);

  const bottom = mapY + mapH + 120;

  ctx.fillStyle = m.won ? '#FFC23C' : '#E4EBF2';
  ctx.font = '800 96px "Fira Sans Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(t(`rank.${def.key}`).toUpperCase(), W / 2, bottom);

  ctx.fillStyle = '#9AA6B8';
  ctx.font = '600 44px Inter, system-ui, sans-serif';
  ctx.fillText(
    `${Math.round(m.peakMass).toLocaleString()} ${t('hud.mass')}`,
    W / 2,
    bottom + 66,
  );

  // --- badges --------------------------------------------------------------
  const show = m.badges.slice(0, 8);
  const size = 92;
  const gap = 18;
  const totalW = show.length * size + (show.length - 1) * gap;
  let bx = (W - totalW) / 2;
  const by = bottom + 130;
  for (const id of show) {
    const img = await svgToImage(badgeIcon(id), size);
    if (img !== null) ctx.drawImage(img, bx, by, size, size);
    bx += size + gap;
  }

  // --- footer --------------------------------------------------------------
  ctx.fillStyle = '#9AA6B8';
  ctx.font = '400 34px Inter, system-ui, sans-serif';
  ctx.fillText(`${t('menu.seed')} ${m.seed}`, W / 2, H - 130);

  ctx.fillStyle = '#31E0C0';
  ctx.font = '600 40px Inter, system-ui, sans-serif';
  ctx.fillText('superelnino.gg', W / 2, H - 72);

  return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
}

export async function shareCard(w: WorldState, m: CardModel): Promise<boolean> {
  const blob = await buildShareCard(w, m);
  if (blob === null) return false;
  const file = new File([blob], 'superelnino.png', { type: 'image/png' });

  if (
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] }) &&
    typeof navigator.share === 'function'
  ) {
    try {
      await navigator.share({ files: [file], title: 'Super El Nino' });
      return true;
    } catch {
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
