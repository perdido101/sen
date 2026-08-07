# SUPER EL NIÑO

**Publisher:** WildBox · **Slug:** `superelnino` (never a tilde in a filename,
package name, route or storage key — the display name keeps it, nothing
technical does)

You start as a scrappy dust devil and end as Super El Niño — a storm big enough
to have a name, roaming a wrapping cartoon Earth, inhaling cars, forests,
screaming stickmen and entire cities to climb the ladder from twister to
hurricane to planetary weather event. Every other storm on the map wants the
same title, and the debris field spinning around you will shred anyone who
flies into it — including you.

Real-time .io-style arena survival. Top-down, single session, instant restart,
90 seconds to 8 minutes. Installable PWA, mobile-first portrait plus desktop
landscape, fully offline.

---

## Run it

```bash
npm install
npm run gen:terrain   # writes public/terrain.png (~20s, only needed once)
npm run gen:icons     # writes public/icons/*
npm run dev
```

`npm run build` type-checks and bundles; `npm run preview` serves the build.

## The two mechanics

**The debris field is a weapon.** Everything you have inhaled orbits you in
loose rings. Fly your eye into someone else's field and you get shredded — the
tail-kill loop, but it reads as physics rather than an arbitrary rule. It also
means bigger is not strictly better: a huge storm has a wide, slow-turning,
heavily telegraphed field, and a small one can knife through the gaps. That
asymmetry is the skill ceiling; protect it in balancing.

**The ocean inverts.** Small, you are a land creature: water bleeds your mass
and cities are your only real food. Past Hurricane, warm water feeds you and
the Pacific becomes your power base — while land, where all the food is, is now
where you are slowest and most exposed. Nothing teaches this; the numbers in
`COLD_WATER_MPS` / `WARM_WATER_MPS` do it.

Win by reaching El Niño rank, then holding the equatorial Pacific warm pool for
60 seconds without being shredded. Feeding in warm water heats it, and the
bloom is visible on every minimap in the world — you cannot win quietly.

## Architecture — the rule that protects multiplayer later

The simulation is a pure, headless, deterministic function:

```ts
step(state: WorldState, inputs: Map<number, Input>): void   // dt is always 1/60
```

Four hard rules, and breaking them is what would force a rewrite:

1. **Nothing in `/src/sim` may import PixiJS, howler, `window` or `document`.**
   The sim runs in bare Node. `npm run check:purity` fails the build on any
   such import, and on any bare `Math.random()`.
2. **Bots emit `Input` objects and nothing else.** A bot may read state to
   decide, but it acts only through `{steerAngle, boosting}` — identical to a
   human. When a server arrives, bots and players are indistinguishable to the
   sim.
3. **`dt` is fixed at 1/60.** Real time is accumulated outside and spent in
   whole steps; the renderer interpolates.
4. **All randomness goes through a seeded mulberry32 on `WorldState`.** That
   includes the loose-debris allocation cursor — module-level state there would
   couple two worlds stepped in the same process and silently break replays.

The renderer subscribes to state; state never knows the renderer exists. The
sim publishes `SimEvent`s each step and the renderer, audio and badge tracker
all read them without being able to influence the outcome.

The multiplayer path later: run the same `step()` in Node at 20Hz
authoritative, ship binary snapshots, interpolate client-side, swap bot `Input`
for socket `Input`.

```
src/sim/      the whole game, headless and deterministic
src/bots/     four-state brain; emits Input, nothing else
src/render/   Pixi layers, camera, procedural art
src/audio/    procedural roar, synthesised SFX and music stems
src/game/     badges, persistence, clip capture, share card
src/ui/       plain HTML/CSS chrome over the canvas
src/app/      fixed-step loop, input, controller
tools/        terrain and icon generation, headless and browser tests
```

## The world

One 4096×2048 equirectangular PNG carries the whole planet as data:

| channel | meaning |
|---|---|
| R | 0 water · 128 land · 255 ice cap |
| G | biome: 0 ocean · 40 plains · 80 forest · 120 desert · 160 urban · 200 mountain · 240 ice |
| B | land: elevation · water: baseline sea surface temperature |

It is generated from lat/lon continent polygons with noise-warped coastlines
(`tools/genTerrain.mjs`) — no GIS pipeline, no tile server, O(1) lookups. It is
loaded once into a byte array; never `getImageData` per frame. The visible map
is a separate stylized layer built from the same data at boot, so data and
beauty stay decoupled.

The world is 8192×4096 and wraps horizontally. **Every** distance, camera and
collision check goes through `wrapDeltaX` in `sim/constants.ts` — this is the
single most common source of bugs in this project, so it is written once. The
map's x=0 is 20°E, chosen so the warm pool sits mid-map instead of straddling
the seam.

Sea surface temperature is a real terrain channel, not a flag: a live 256×128
overlay the sim mutates as storms feed, decaying back toward the baseline, and
it is what blooms red across the ocean and every minimap.

## Art and audio ship as code

There are no image or audio assets. Every sprite — props, buildings, debris,
the stickman pose atlas, badge icons, the app icons — is drawn in code and
baked to a texture at boot. Every sound, including the storm roar that doubles
as the mass readout and a second distant-roar bus panned to the nearest rival,
is synthesised through Web Audio. The result installs and plays offline on
first load with nothing to download.

Palette, type and the style rules for anything generated later live in the
build brief; the tokens are in `src/render/palette.ts` and `src/styles.css`.

## Tests

```bash
npm test              # purity + determinism + typecheck
npm run smoke         # boots the built game in Chromium, plays it, screenshots
npm run ui            # walks every screen; fails on any dead end
npm run offline       # loads, cuts the network, reloads, starts a run
```

`npm run smoke -- <dir> --mass=3000 --win` drives the endgame and asserts the
win sequence reaches the right card without waiting six minutes for it.

The determinism harness (`npm run sim:determinism [steps] [seed]`) runs the sim
twice with a scripted input log and compares a byte-level fingerprint of every
storm, debris slot, stickman, city and SST cell. It doubles as a balance probe:
it prints the final rank spread, the biggest storm and how many cities got
touched.

## Deliberate deviations from the brief

- **Language.** The brief specified English + Greek from day one with Greek as
  the primary marketing language. The game ships **English only** at the
  client's later instruction. The `t(key)` indirection is kept — every
  user-facing string is still in `src/i18n/en.ts`, so adding a language is a
  data change, not a code change.
- **City reserve.** `reserve = tier * 400` is implemented exactly as written,
  which makes T1 megacities the *smallest* feed and T3 the longest drain. That
  is almost certainly inverted relative to intent, but the brief said to use
  the numbers as given. `CITY_RESERVE_PER_TIER` in `sim/constants.ts` is the
  one-line flip.
- **Badges.** The brief said 32 and then listed 39. All 39 are implemented.
- **Audio.** The brief specified howler for pooled one-shots. With no sample
  files to load, every one-shot is synthesised instead and howler is not a
  dependency — this keeps first-load offline play working. The `play(name)`
  interface is the seam if samples arrive later.

## Non-goals for v1

No server, socket, lobby or accounts. No cosmetics, currency, IAP or ads. No
3D, no real sphere, no great-circle math. No real climate simulation — El Niño
here is a costume, not a model. No tutorial: if the game needs one, the
controls are wrong.
