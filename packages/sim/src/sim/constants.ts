/**
 * SUPER EL NINO - simulation constants.
 *
 * HARD RULE: nothing in /src/sim may import PixiJS, howler, window or document.
 * This file must run in bare Node. `npm run check:purity` enforces it.
 */

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/**
 * World size, in world units, at Earth's 2:1 equirectangular aspect.
 *
 * One world unit is 40075km / 16384 = 2.45km, which makes the storms
 * themselves true to scale: a capped core radius of 95 units is a 466km-wide
 * hurricane, which is what a real major hurricane measures. Cities are
 * deliberately NOT to that scale - a real megacity would be 16 units across,
 * smaller than the storm eating it, and "pinned and slow while you chew"
 * would become a single frame. El Nino here is a costume, not a model.
 */
export const WORLD_W = 16384;
export const WORLD_H = 8192;
/** The equator is a real gameplay line: Coriolis flips here. */
export const EQUATOR_Y = WORLD_H / 2;

/** Terrain data PNG dimensions. World units per terrain pixel = 2. */
export const TERRAIN_W = 4096;
export const TERRAIN_H = 2048;

/** Live sea-surface-temperature overlay resolution. */
export const SST_W = 256;
export const SST_H = 128;
/** The overlay decays back toward the PNG baseline at this rate (units/sec). */
export const SST_DECAY = 0.4;
/** The sim only re-evaluates the overlay at 10Hz, not every frame. */
export const SST_HZ = 10;

/**
 * Longitude (degrees east) that sits at world x = 0.
 * Chosen so the equatorial Pacific warm pool - the win arena - sits mid-map
 * instead of straddling the wrap seam.
 */
export const MAP_LON_ORIGIN = 20;

export const FIXED_DT = 1 / 60;

// ---------------------------------------------------------------------------
// Wrapping. The single most common source of bugs in this project.
// Write it once, use it everywhere.
// ---------------------------------------------------------------------------

/** Shortest signed x-delta from `a` to `b` on a horizontally wrapping world. */
export function wrapDeltaX(a: number, b: number): number {
  let d = b - a;
  if (d > WORLD_W * 0.5) d -= WORLD_W;
  else if (d < -WORLD_W * 0.5) d += WORLD_W;
  return d;
}

/** Normalise an x coordinate into [0, WORLD_W). */
export function wrapX(x: number): number {
  const m = x % WORLD_W;
  return m < 0 ? m + WORLD_W : m;
}

/** Clamp a y coordinate to the ice caps. */
export function clampY(y: number): number {
  return y < 0 ? 0 : y > WORLD_H ? WORLD_H : y;
}

/** Squared distance honouring horizontal wrap. */
export function wrapDist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = wrapDeltaX(ax, bx);
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function wrapDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(wrapDist2(ax, ay, bx, by));
}

// ---------------------------------------------------------------------------
// Storm shape & movement
// ---------------------------------------------------------------------------

export const START_MASS = 10;
export const MIN_MASS = 8;
export const CORE_RADIUS_CAP = 95;
/**
 * Base speed, world units/sec. The world doubled to Earth proportions, and a
 * storm that crossed the old map in 30s took a minute on the new one, which
 * read as wading. A lap is now ~37s at Dust Devil pace.
 */
export const BASE_SPEED = 520;

export const SUCTION_MUL = 2.6;
export const EYE_MUL = 0.55;
export const FIELD_MUL = 2.2;

export function coreRadius(mass: number): number {
  const r = 12 * Math.sqrt(mass / 10);
  return r > CORE_RADIUS_CAP ? CORE_RADIUS_CAP : r;
}
export function suctionRadius(mass: number): number {
  return coreRadius(mass) * SUCTION_MUL;
}
/** The eye is the vulnerable part. */
export function eyeRadius(mass: number): number {
  return coreRadius(mass) * EYE_MUL;
}
export function fieldRadius(mass: number): number {
  return coreRadius(mass) * FIELD_MUL;
}

const LOG_500 = Math.log(500);
export function sizeFactor(mass: number): number {
  const f = Math.log(mass / 10) / LOG_500;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
/**
 * Size costs speed, but far less than it used to.
 *
 * The brief's 0.35 made a Megastorm feel like it was dragging an anchor. The
 * tension that matters is turning, not top speed - maxTurnRate still falls by
 * more than half across the range, so a big storm is still committed to its
 * line and still cannot corner. It just no longer feels slow while it does it.
 */
export const SIZE_SPEED_PENALTY = 0.12;

export function stormSpeed(mass: number): number {
  return BASE_SPEED * (1 - SIZE_SPEED_PENALTY * sizeFactor(mass));
}
export function maxTurnRate(mass: number): number {
  const f = sizeFactor(mass);
  return 4.2 + (1.6 - 4.2) * f;
}

// Boost ("spin up")
export const BOOST_SPEED_MUL = 1.75;
export const BOOST_TURN_MUL = 1.2;
/** Fraction of current mass drained per second while boosting. */
export const BOOST_DRAIN = 0.04;
export const BOOST_MIN_MASS = 25;
export const BOOST_EJECT_INTERVAL = 0.12;

/** Turning toward your Coriolis spin direction is 8% faster. */
export const CORIOLIS_TURN_BONUS = 0.08;
/** Visible unwind when the spin direction flips at the equator. */
export const CORIOLIS_FLIP_TIME = 0.5;

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/**
 * Ship false. A 30% shred keeps mobile players in the run and allows
 * comebacks. Exposed in the debug menu to test the harsh rule.
 */
export const INSTANT_DEATH_ON_SHRED = false;

export const SHRED_MASS_LOSS = 0.3;
export const SHRED_KNOCKBACK = 180;
export const SHRED_INVULN = 1.2;
/** Eye-vs-eye: the larger storm absorbs this fraction of the smaller's mass. */
export const EYE_ABSORB = 0.4;
export const EYE_THROW = 260;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/** Plain const object, not an enum: /src/sim must survive Node type-stripping. */
export const Biome = {
  Ocean: 0,
  Plains: 1,
  Forest: 2,
  Desert: 3,
  Urban: 4,
  Mountain: 5,
  Ice: 6,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];

/** Green channel encoding in the terrain PNG. */
export const BIOME_G = [0, 40, 80, 120, 160, 200, 240];

export const BIOME_SPEED = [
  1.1, // ocean - overridden by water rules below, kept for completeness
  1.1, // plains  +10%
  0.9, // forest  -10%
  1.15, // desert +15%
  0.65, // urban  -35%
  0.65, // mountain -35%
  0.85, // ice     -15%
];

/**
 * Water speed. Cold water is the brief's flat +10%.
 *
 * Warm water is faster still, and that is a game rule rather than meteorology:
 * a real storm over a warm sea intensifies, it does not accelerate - its
 * translation speed comes from the steering winds around it. But the warm pool
 * is where the endgame lives, and making it the fastest water as well as the
 * richest gives the map inversion a second thing the player can feel.
 */
export const WATER_SPEED = 1.1;
export const WARM_WATER_SPEED = 1.28;
export const ICE_SPEED = 0.85;

/** Sea surface temperature (0-255) at or above which water counts as warm. */
export const WARM_SST = 150;

/**
 * Mass per second by rank index (0-based rank-1) for cold and warm water.
 * Rank 1-2 bleed, rank 3 is the hinge, rank 4+ feeds. This table is the
 * whole mid-game: the moment the map flips under the player.
 */
export const COLD_WATER_MPS = [-1.8, -1.8, 0, 1.2, 1.2, 1.2, 1.2];
export const WARM_WATER_MPS = [-1.8, -1.8, 1.0, 3.5, 3.5, 3.5, 3.5];
/** The poles are a soft wall at every rank. */
export const ICE_MPS = -4.0;

/** Mass per second while draining a live city. */
export const CITY_FEED_MPS = 22;

// ---------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------

export interface RankDef {
  index: number; // 1-based, matches the design doc
  key: string; // i18n key suffix
  min: number;
  max: number;
}

export const RANKS: RankDef[] = [
  { index: 1, key: 'dustDevil', min: 10, max: 40 },
  { index: 2, key: 'twister', min: 40, max: 120 },
  { index: 3, key: 'cyclone', min: 120, max: 350 },
  { index: 4, key: 'hurricane', min: 350, max: 900 },
  { index: 5, key: 'megastorm', min: 900, max: 2200 },
  { index: 6, key: 'elNino', min: 2200, max: 5000 },
  { index: 7, key: 'superElNino', min: 5000, max: Infinity },
];

/** Returns a 1-based rank index. */
export function rankOf(mass: number): number {
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (mass >= RANKS[i].min) return RANKS[i].index;
  }
  return 1;
}

/**
 * La Nina's feeding advantage. She is the closest thing this game has to a
 * boss and she costs almost nothing to implement - a name, a tint, and a
 * personality weight - but she has to actually stay the biggest storm on the
 * map for any of that to land.
 */
export const LA_NINA_FEED = 1.3;

export const RANK_EL_NINO = 6;
export const RANK_SUPER = 7;

// ---------------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------------

/**
 * Reserve = tier * 400, drained at 22/sec, rebuilding over 90s.
 * NOTE: taken literally from the brief. It makes T1 megacities the *smallest*
 * feed; flip CITY_RESERVE_INVERT in the debug menu to test tier-weighted
 * reserves instead.
 */
export const CITY_RESERVE_PER_TIER = 400;
export const CITY_DRAIN_RATE = 22;
export const CITY_REBUILD_TIME = 90;
/**
 * City footprint radius by tier, world units. Sized against the debris field
 * of the rank that can take the city (Cyclone's field is ~100-155), so a city
 * is an arena you orbit inside rather than a disc you cross in one pass.
 * Larger than this and neighbouring cities merge into one continent-wide
 * suburb.
 */
export const CITY_RADIUS = [0, 270, 180, 118];

// ---------------------------------------------------------------------------
// Stickmen
// ---------------------------------------------------------------------------

export const STICKMAN_ALERT_RANGE = 900;
export const STICKMAN_FLEE_SPEED = 140;
export const STICKMAN_MASS = 1.0;
export const CHASER_MASS_MUL = 5;
/** Chance a given stickman is the storm chaser with the camera. */
export const CHASER_CHANCE = 0.004;

// ---------------------------------------------------------------------------
// Win condition
// ---------------------------------------------------------------------------

/** Equatorial Pacific warm pool, in world units. The named place everyone converges on. */
export const WARM_POOL_X = (((175 - MAP_LON_ORIGIN + 360) % 360) / 360) * WORLD_W;
export const WARM_POOL_Y = EQUATOR_Y;
export const WARM_POOL_RX = WORLD_W * 0.105;
export const WARM_POOL_RY = WORLD_H * 0.085;
export const WIN_HOLD_TIME = 60;

/** Normalised distance from the warm pool centre; <= 1 is inside. */
export function warmPoolT(x: number, y: number): number {
  const dx = wrapDeltaX(WARM_POOL_X, x) / WARM_POOL_RX;
  const dy = (y - WARM_POOL_Y) / WARM_POOL_RY;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Performance caps (§13)
// ---------------------------------------------------------------------------

export const CAP_LOOSE_DEBRIS = 900;
export const CAP_STICKMEN = 400;
/**
 * Rival count. Brief 2 backfills every instance to ~80 total storms, so the
 * single-player world matches what a live server will feel like.
 */
export const CAP_BOTS = 64;
export const CAP_DETAIL_CITIES = 6;
export const CAP_FIELD_ITEMS = 150;

export const CHUNK_SIZE = 512;
export const SPATIAL_CELL = 128;

/** Distant storms sim at 20Hz with simplified fields. */
export const FAR_SIM_DIST = 3000;
export const FAR_SIM_HZ = 20;

// ---------------------------------------------------------------------------
// Small math helpers used across the sim
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Shortest signed angle from a to b, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** lat/lon -> world position. Used by cities and by the terrain generator. */
export function lonToX(lon: number): number {
  return (((lon - MAP_LON_ORIGIN + 360) % 360) / 360) * WORLD_W;
}
export function latToY(lat: number): number {
  return ((90 - lat) / 180) * WORLD_H;
}
export function xToLon(x: number): number {
  return (((x / WORLD_W) * 360 + MAP_LON_ORIGIN + 180) % 360) - 180;
}
export function yToLat(y: number): number {
  return 90 - (y / WORLD_H) * 180;
}
