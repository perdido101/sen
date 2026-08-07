/** "Warm Pool" palette (§6), as numbers for Pixi. */

export const C = {
  deep: 0x0a1420,
  coolSea: 0x2c5f8a,
  warmSea: 0xc9432b,
  storm: 0x9aa6b8,
  stormLit: 0xe4ebf2,
  debris: 0xc4762e,
  siren: 0xff3b30,
  crown: 0xffc23c,
  chase: 0x31e0c0,

  plains: 0x7fa85c,
  forest: 0x3f6b37,
  desert: 0xd9b36b,
  urban: 0x6e6a72,
  snow: 0xe8f0f5,
  mountain: 0x8a8477,

  /** Chunky 3px dark outline on every generated asset. */
  ink: 0x131c26,
} as const;

/** Land colours by biome id, matching the terrain G channel ordering. */
export const BIOME_COLOR = [
  C.coolSea,
  C.plains,
  C.forest,
  C.desert,
  C.urban,
  C.mountain,
  C.snow,
];

/** Six shirt colours for the stickmen. */
export const SHIRTS = [0xd8563f, 0x3f7fd8, 0xd8b83f, 0x59b85e, 0xb05fc0, 0xe0e6ec];

export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  return (
    ((ar + (br - ar) * t) << 16) | (((ag + (bg - ag) * t) | 0) << 8) | ((ab + (bb - ab) * t) | 0)
  );
}

export function shade(c: number, k: number): number {
  const r = Math.min(255, Math.max(0, ((c >> 16) & 255) * k)) | 0;
  const g = Math.min(255, Math.max(0, ((c >> 8) & 255) * k)) | 0;
  const b = Math.min(255, Math.max(0, (c & 255) * k)) | 0;
  return (r << 16) | (g << 8) | b;
}
