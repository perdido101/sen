/**
 * @sen/sim - the whole game, headless and deterministic.
 *
 * The client and the server import THIS. Neither one forks it, and neither
 * one is allowed to reach past this barrel into a private corner of the sim
 * and reimplement a rule. That is the single property that makes the server
 * an adapter rather than a second game that has to be kept in sync.
 *
 * Nothing reachable from here may import PixiJS, howler, `window` or
 * `document`; `npm run check:purity` enforces it.
 */

export * from './sim/constants.ts';
export * from './sim/types.ts';
export * from './sim/rng.ts';
export * from './sim/terrain.ts';
export * from './sim/spatial.ts';
export * from './sim/props.ts';
export * from './sim/chunks.ts';
export * from './sim/cities.ts';
export * from './sim/storm.ts';
export * from './sim/world.ts';
export * from './sim/step.ts';
export * from './sim/names.ts';
export { CITY_DATA, type CityDef } from './data/cities.ts';

export * from './bots/brain.ts';
export * from './bots/drive.ts';
