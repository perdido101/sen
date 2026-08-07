/**
 * Loads the planet's data map once into a byte array. Never call getImageData
 * per frame - this happens exactly once, at boot.
 */

import type { TerrainData } from '@sen/sim/sim/types.ts';

/**
 * Resolved against the deploy base, not the site root: on GitHub Pages this
 * lives at /sen/terrain.png, and an absolute /terrain.png would 404 into a
 * blank screen.
 */
export const TERRAIN_URL = `${import.meta.env.BASE_URL}terrain.png`;

export async function loadTerrain(url = TERRAIN_URL): Promise<TerrainData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`terrain: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);

  // Read the dimensions before closing: an ImageBitmap reports 0x0 once it is
  // released, and a zero width silently turns every terrain lookup into a
  // read of row 0.
  const w = bmp.width;
  const h = bmp.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('terrain: no 2d context');
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  bmp.close();

  if (img.data.length !== w * h * 4) throw new Error('terrain: unexpected pixel buffer');
  return { w, h, data: img.data };
}
