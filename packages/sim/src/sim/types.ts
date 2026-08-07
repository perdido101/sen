/**
 * Simulation types. Pure data - no methods that touch the outside world.
 */

/**
 * THE CONTRACT (§3).
 *
 * This is the only way anything - human, bot, or one day a socket - moves a
 * storm. A bot may read state to decide, but it acts only through this.
 */
export interface Input {
  /** Desired heading in radians. */
  steerAngle: number;
  boosting: boolean;
}

export type StormKind = 'player' | 'bot';

export interface FieldItem {
  /** Angle around the storm, radians. */
  ang: number;
  /** Orbit radius as a fraction of the field radius (0.35 - 1.0). */
  rt: number;
  /** Per-item angular velocity multiplier, so rings shear against each other. */
  spin: number;
  /** Vertical wobble phase. */
  wob: number;
  /** Visual kind, indexes into the debris art table. */
  type: number;
  /** 0 = generic debris, 1 = stickman (still flailing), 2 = vehicle, 3 = ship. */
  cls: number;
  /** Absorb animation progress, 0..1. 1 = fully in the field. */
  t: number;
  /** Where it was picked up, for the spiral-in animation. */
  sx: number;
  sy: number;
}

export interface Storm {
  id: number;
  kind: StormKind;
  /** Display name. Bots are named after real storm systems. */
  name: string;
  alive: boolean;

  x: number;
  y: number;
  /** Current heading, radians. */
  ang: number;
  mass: number;

  boosting: boolean;
  boostEjectTimer: number;

  /** -1 = counter-clockwise (northern), +1 = clockwise (southern). */
  spinDir: number;
  /** Counts down through the 0.5s unwind after an equator crossing. */
  spinFlip: number;
  /** Accumulated field rotation, radians. Renderer reads this. */
  fieldRot: number;

  invuln: number;
  /** Red-flash timer, purely a hint for the renderer. */
  hurt: number;

  field: FieldItem[];
  /** Mass that arrived without a visible field slot. */

  /** Index into cities[] currently being drained, or -1. */
  drainingCity: number;

  /** Seconds held inside the warm pool at El Nino rank. */
  winTimer: number;

  /** Cached 1-based rank, so rank-up edges are detectable without extra state. */
  rank: number;

  /** Bot brain state - never read by movement code, only by the bot. */
  botState: number;
  botTimer: number;
  botTarget: number;
  botPersonality: number;
  /**
   * Where a FEED-state bot is heading. Recomputed on the decision tick only:
   * the searches behind it (nearest loose debris, probing terrain for land or
   * warmer water) are far too expensive to run per bot per frame once there
   * are 64 of them.
   */
  botAimX: number;
  botAimY: number;
  botAimValid: boolean;
  /** La Nina: the largest bot in any run. Cold-blue, Hunter, contests the pool. */
  isLaNina: boolean;

  /** Distant storms tick at 20Hz; this accumulates their skipped time. */
  farAccum: number;

  // --- run statistics, consumed by badges and the game-over card ---
  stats: StormStats;
}

export interface StormStats {
  peakMass: number;
  shredsTaken: number;
  shredsDealt: number;
  cows: number;
  trees: number;
  cars: number;
  ships: number;
  stickmen: number;
  citiesEmptied: number;
  t1Emptied: number;
  equatorCrossings: number;
  distanceX: number;
  aliveTime: number;
  seaTime: number;
  boostTime: number;
  chaserCaught: number;
  /** Bitmask of continents fed on. */
  continents: number;
  touchedNorthCap: boolean;
  touchedSouthCap: boolean;
  greenlandTime: number;
  minMassSeen: number;
  timeToElNino: number;
  maxHeatCell: number;
  carsIn10s: number;
  carWindow: number[];
}

export interface LooseDebris {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  type: number;
  cls: number;
  /** Time alive; loose debris from a shred spreads then settles. */
  life: number;
  active: boolean;
}

export const ManState = {
  Idle: 0,
  Alert: 1,
  Flee: 2,
  Caught: 3,
} as const;
export type ManState = (typeof ManState)[keyof typeof ManState];

export interface Stickman {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: ManState;
  /** Animation phase. */
  ph: number;
  /** Height multiplier, 0.8 - 1.2. */
  h: number;
  /** Shirt colour index 0-5. */
  c: number;
  hat: boolean;
  bike: boolean;
  /** The rare one who runs toward you holding a camera. */
  chaser: boolean;
  active: boolean;
  /** Which chunk owns it, for unloading. */
  chunk: number;
}

export interface Prop {
  x: number;
  y: number;
  /** Prop art index. */
  type: number;
  /** 0 generic, 1 tree, 2 cow, 3 car, 4 ship, 5 building, 6 aircraft. */
  cls: number;
  mass: number;
  r: number;
  alive: boolean;
  /** Heading, radians. Only meaningful when spd > 0. */
  ang: number;
  /** World units per second. 0 for everything rooted to the ground. */
  spd: number;
}

export interface Chunk {
  cx: number;
  cy: number;
  key: number;
  props: Prop[];
  stickmen: number[];
  lastSeen: number;
}

export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = intact, 1 = rubble. Interpolates while collapsing. */
  dmg: number;
  kind: number;
}

export interface City {
  id: number;
  name: string;
  tier: number;
  x: number;
  y: number;
  r: number;
  reserveMax: number;
  reserve: number;
  /** Countdown after being emptied; rebuilds over CITY_REBUILD_TIME. */
  rebuild: number;
  buildings: Building[];
  /** Detail-simmed cities generate buildings lazily. */
  detailed: boolean;
  emptiedBy: number;
}

export type SimEventType =
  | 'absorb'
  | 'shred'
  | 'eyeHit'
  | 'dissipate'
  | 'rankUp'
  | 'cityEmptied'
  | 'buildingCollapse'
  | 'equatorCross'
  | 'boostEject'
  | 'win'
  | 'cityDrainStart'
  | 'cityDrainStop'
  | 'chaser';

export interface SimEvent {
  type: SimEventType;
  storm: number;
  x: number;
  y: number;
  a: number;
  b: number;
}

export interface TerrainData {
  w: number;
  h: number;
  /** RGBA, 4 bytes per pixel. R land/water/ice, G biome, B elev or baseline SST. */
  data: Uint8ClampedArray;
}

export interface WorldState {
  seed: number;
  /** Mutable mulberry32 state. All randomness in the sim goes through this. */
  rng: number;

  tick: number;
  time: number;

  storms: Storm[];
  debris: LooseDebris[];
  stickmen: Stickman[];
  cities: City[];
  chunks: Map<number, Chunk>;

  terrain: TerrainData;
  /** Live SST overlay, SST_W * SST_H, 0-255 float. Mutated as storms feed. */
  sst: Float32Array;
  sstBase: Float32Array;
  sstAccum: number;

  /** Cleared at the top of every step. */
  events: SimEvent[];

  playerId: number;
  /** Set once someone reaches Super El Nino. */
  winner: number;
  over: boolean;

  /** Debug flag, see §1. */
  instantDeathOnShred: boolean;

  /**
   * Someone else owns the storms.
   *
   * Set only by an online client, whose local world exists to draw terrain,
   * props, stickmen, cities and weather from the server's seed - none of which
   * need to cross the wire. In that mode the sim must not kill a storm, must
   * not respawn one, and must not declare a winner: those are outcomes, the
   * server owns outcomes, and a local copy inventing its own is how a player
   * ends up watching a game-over card while the server has them alive and
   * eating. The server never sets this, so its own determinism is untouched.
   */
  remoteAuthority: boolean;

  /**
   * Rolling allocation cursor for the loose-debris pool. Lives on the state,
   * not in module scope, so two worlds stepped in one process stay independent
   * and byte-identical for the same seed.
   */
  debrisCursor: number;

  /** Scratch, reused every frame - zero allocation in the hot loop. */
  _hash: SpatialHash;
}

export interface SpatialHash {
  cells: Map<number, number[]>;
  /** Parallel arrays of everything inserted this frame. */
  ix: Float64Array;
  iy: Float64Array;
  /** 0 = loose debris, 1 = stickman, 2 = prop. */
  kind: Uint8Array;
  ref: Int32Array;
  count: number;
}
