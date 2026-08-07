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
90 seconds to 8 minutes. Installable PWA, desktop first with a phone layout,
fully offline in single player and 60 players to an instance online.

**Play it: https://perdido101.github.io/sen/**

---

## Run it

```bash
npm install
npm run gen:terrain   # writes apps/client/public/terrain.png (~20s, once)
npm run gen:icons     # writes apps/client/public/icons/*
npm run dev           # the game, single player, no server needed
npm run server        # optional: the authoritative server on :8787
```

`npm run build` type-checks and bundles; `npm run preview` serves the build.
Single player needs nothing but the client - the server is only for live
instances. To join one, open the client with `?server=ws://host:8787`.

### Layout

It is an npm workspace, and the split is the architecture rather than
housekeeping:

```
packages/sim        the whole game, headless and deterministic. No DOM, no Pixi.
packages/protocol   the wire format, imported by both sides so it cannot drift
apps/client         Pixi renderer, audio, UI, netcode, PWA
apps/server         uWebSockets host: imports packages/sim and steps it
```

`apps/server` is an adapter, not a second game. It imports the same `step()`
the browser runs. Any rule that exists twice would eventually exist in two
different versions, and that is the failure this layout is built to prevent.

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

That rule is what made multiplayer an adapter rather than a rewrite: the
server runs the same `step()` in Node, ships binary snapshots, and swaps bot
`Input` for socket `Input`. Bots and humans are still indistinguishable to the
sim, so an instance backfilled with bots plays identically to a full one.

```
packages/sim/src/sim/     the whole game, headless and deterministic
packages/sim/src/bots/    four-state brain; emits Input, nothing else
packages/protocol/src/    binary snapshots, deltas, input packets
apps/client/src/render/   Pixi layers, camera, procedural art
apps/client/src/audio/    procedural roar, synthesised SFX and music stems
apps/client/src/net/      prediction, interpolation, reconciliation
apps/client/src/game/     badges, persistence, clip capture, share card
apps/client/src/ui/       plain HTML/CSS chrome over the canvas
apps/client/src/app/      fixed-step loop, input, controller
apps/server/src/          instances, matchmaking, anti-cheat, economy
tools/                    terrain and icon generation, headless and browser tests
```

There is a fifth rule, added when the server arrived:

5. **A world under a remote authority does not decide outcomes.** An online
   client sets `remoteAuthority` on its `WorldState` and the sim then refuses
   to kill a storm, respawn one or declare a winner - it runs terrain, props,
   stickmen, cities and weather from the server's seed and nothing else. A
   local copy inventing its own outcomes is how a player ends up watching a
   game-over card while the server has them alive and eating.

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

The world is 16384×8192 and wraps horizontally. **Every** distance, camera and
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

## Deploying

`.github/workflows/deploy.yml` runs the headless checks, builds, and publishes
to GitHub Pages. It is wired to `workflow_dispatch` as well as `push`, because
pushes made with an app token do not always trigger Actions.

The one thing to get right is the base path. A project site is served from
`/<repo>/`, and a root-relative build dropped at a subpath fails in the least
helpful way available: HTTP 200 on the page, a 404 on `terrain.png`, and a
blank screen. `SEN_BASE` feeds `vite.config.ts`, which is the only place that
knows about it — assets, the manifest's `start_url`/`scope`/icons, workbox's
navigation fallback and `TERRAIN_URL` all derive from that one value. The
workflow re-checks the built `index.html` afterwards, because a silently
root-relative build is the one failure that still produces a green deploy.

To serve from a root domain instead, leave `SEN_BASE` unset.

Note the deploy job is deliberately *not* bound to the `github-pages`
environment: that environment's deployment branch policy rejected the job
before any step ran, which surfaces as a two-second failure with no log.
`deploy-pages` only needs `pages: write` and `id-token: write`.

## Multiplayer

The server is authoritative and the client predicts only its own movement.

| | |
|---|---|
| sim | 60Hz, the same `step()` the browser runs |
| snapshots | 15Hz, binary, delta-compressed against the last frame the client held |
| input | 30Hz, 5 bytes: sequence, steer angle, boost. That is the entire client authority surface |
| area of interest | the client's viewport plus a 400-unit margin, both sides of the wrap seam |
| prediction | movement only - never mass, never absorption, never a collision |
| interpolation | everyone else, 100ms in the past |
| correction | error bled off over 150ms; a correction past 900 units is a teleport and snaps |

There is no lag compensation and no rewind. Debris fields are large and slow
relative to 100ms, so present-time server-authoritative collision is accurate
enough, and it removes an entire class of "he killed me from around the
corner" bugs. That is a choice, not an omission.

Instances hold 60 humans and backfill with bots to 80 storms, so a quiet
instance still plays like a busy one. A player who leaves hands their storm
back to the bots rather than deleting it.

## Anti-cheat, and what it deliberately does not do

Every run's seed and complete input log is recorded, and the server can
re-simulate it and compare the result. That is the ground truth: a client can
send any packet it likes, but the only thing it can say is "steer here, boost
now", and mass forged in browser memory is overwritten by the next snapshot.

Rate limits, packet-size limits, boost-toggle counters and a quantized-steering
detector flag suspicious sessions. Flagged sessions are recorded, not
disconnected mid-run - a false positive that ejects a real player is worse than
a cheat that gets caught on review.

## Economy

Ads, revenue accounting, a devnet token and a mechanical buyback live in
`apps/server`. Everything about them is off until configured, and the rules are
constants rather than settings:

- The buyback is **30% of net ad revenue, every 7 days, with no manual
  trigger**. The percentage and cadence are published before the first
  execution and the schedule advances by exactly one interval per run, so a
  late or failed execution cannot bunch two together.
- The token is **devnet only**. It grants no revenue share, no governance, no
  claim on anything, and carries no promise of value. It touches nothing
  inside the game - no token-gated play, ranks or matchmaking, ever.
- `/treasury` renders the public dashboard from the ledger. Nothing on that
  page is typed in by hand.

`SETUP.md` lists every credential and external account, one at a time, with
what breaks if it is missing.

## Tests

```bash
npm test              # purity + determinism + typecheck + protocol + server
npm run smoke         # boots the built game in Chromium, plays it, screenshots
npm run ui            # walks every screen; fails on any dead end
npm run offline       # loads, cuts the network, reloads, starts a run
npm run controls      # WASD, arrows, pointer and the touch stick
npm run netplay       # two real browsers on one instance, 150ms link, 2% loss
npm run soak          # holds a full instance for N minutes, watches memory
```

`npm run test:server -- 60 20` runs the 60-client acceptance: snapshot rate,
bandwidth per client, sim time under load, and that a forged mass changes
nothing. `npm run soak -- 60` is the hour-long memory run.

`npm run live -- <url>` plays the deployed site rather than a local build —
a 200 on index.html proves nothing when the failure mode is a 404 on the
terrain map.

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
