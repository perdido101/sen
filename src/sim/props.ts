/**
 * Prop table shared by the sim and the renderer. The sim only ever stores the
 * integer id; the renderer maps it to art.
 */

import { Biome } from './constants.ts';

export interface PropKind {
  name: string;
  /** 0 generic, 1 tree, 2 cow, 3 car, 4 ship, 5 building. */
  cls: number;
  mass: number;
  r: number;
  /** Which debris art it becomes once it is orbiting you. */
  debris: number;
}

export const PROP_KINDS: PropKind[] = [
  { name: 'tree', cls: 1, mass: 1.2, r: 15, debris: 2 },
  { name: 'pine', cls: 1, mass: 1.2, r: 14, debris: 2 },
  { name: 'bush', cls: 1, mass: 0.6, r: 10, debris: 2 },
  { name: 'rock', cls: 0, mass: 1.5, r: 12, debris: 5 },
  { name: 'fence', cls: 0, mass: 0.5, r: 11, debris: 5 },
  { name: 'barn', cls: 0, mass: 6, r: 26, debris: 1 },
  { name: 'car', cls: 3, mass: 3, r: 14, debris: 0 },
  { name: 'watertower', cls: 0, mass: 4, r: 17, debris: 1 },
  { name: 'cow', cls: 2, mass: 2, r: 13, debris: 7 },
  { name: 'windmill', cls: 0, mass: 5, r: 19, debris: 3 },
  { name: 'cactus', cls: 0, mass: 1, r: 12, debris: 2 },
  { name: 'house', cls: 5, mass: 5, r: 20, debris: 1 },
  { name: 'haybale', cls: 0, mass: 1, r: 10, debris: 5 },
  { name: 'signpost', cls: 0, mass: 0.8, r: 9, debris: 5 },
  { name: 'containership', cls: 4, mass: 30, r: 32, debris: 4 },
  { name: 'tanker', cls: 4, mass: 34, r: 35, debris: 4 },
  { name: 'oilplatform', cls: 4, mass: 40, r: 30, debris: 4 },
  { name: 'fishingboat', cls: 4, mass: 8, r: 15, debris: 4 },
  { name: 'buoy', cls: 4, mass: 2, r: 9, debris: 6 },
  { name: 'island', cls: 0, mass: 12, r: 30, debris: 2 },
  { name: 'palmislet', cls: 0, mass: 6, r: 20, debris: 2 },
];

export const PROP_ID: Record<string, number> = {};
for (let i = 0; i < PROP_KINDS.length; i++) PROP_ID[PROP_KINDS[i].name] = i;

export interface ScatterEntry {
  id: number;
  w: number;
}

function s(name: string, w: number): ScatterEntry {
  return { id: PROP_ID[name], w };
}

/** Per-biome scatter table and base density (props per chunk at full density). */
export const BIOME_SCATTER: Record<
  number,
  { density: number; table: ScatterEntry[] }
> = {
  [Biome.Plains]: {
    density: 46,
    table: [
      s('tree', 10), s('fence', 14), s('cow', 12), s('barn', 4), s('car', 9),
      s('haybale', 8), s('windmill', 3), s('watertower', 2), s('house', 5),
      s('signpost', 6), s('rock', 4),
    ],
  },
  [Biome.Forest]: {
    density: 88,
    table: [
      s('tree', 40), s('pine', 34), s('bush', 16), s('rock', 5), s('house', 2),
      s('fence', 3),
    ],
  },
  [Biome.Desert]: {
    density: 20,
    table: [s('cactus', 30), s('rock', 22), s('signpost', 6), s('car', 4), s('haybale', 2)],
  },
  [Biome.Urban]: {
    density: 62,
    table: [s('house', 30), s('car', 34), s('signpost', 14), s('tree', 10), s('watertower', 4)],
  },
  [Biome.Mountain]: {
    density: 34,
    table: [s('rock', 40), s('pine', 26), s('bush', 8)],
  },
  [Biome.Ice]: {
    density: 6,
    table: [s('rock', 10), s('signpost', 2)],
  },
  [Biome.Ocean]: {
    density: 9,
    table: [
      s('containership', 8), s('tanker', 5), s('oilplatform', 4),
      s('fishingboat', 12), s('buoy', 14), s('island', 4), s('palmislet', 5),
    ],
  },
};

export function pickFromTable(table: ScatterEntry[], roll: number): number {
  let total = 0;
  for (let i = 0; i < table.length; i++) total += table[i].w;
  let r = roll * total;
  for (let i = 0; i < table.length; i++) {
    r -= table[i].w;
    if (r <= 0) return table[i].id;
  }
  return table[table.length - 1].id;
}
