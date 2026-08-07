/**
 * The game controller: owns the world, the loop, the renderer, audio, badges
 * and the UI, and nothing else knows about more than one of those.
 */

import { Application } from 'pixi.js';
import { audio } from '../audio/engine.ts';
import { InputCollector } from '@sen/sim/bots/drive.ts';
import { botInput } from '@sen/sim/bots/brain.ts';
import { RunTracker, type BadgeId } from '../game/badges.ts';
import { ClipRecorder } from '../game/clip.ts';
import { awardMeta, load, save, unlock } from '../game/persist.ts';
import { shareCard } from '../game/shareCard.ts';
import { GameRenderer } from '../render/renderer.ts';
import {
  BOOST_SPEED_MUL,
  CAP_BOTS,
  FIXED_DT,
  RANKS,
  START_MASS,
  WARM_POOL_X,
  WARM_POOL_Y,
  clamp,
  angleDelta,
  maxTurnRate,
  rankOf,
  stormSpeed,
  warmPoolT,
  wrapDeltaX,
  wrapDist,
  wrapX,
} from '@sen/sim/sim/constants.ts';
import { step } from '@sen/sim/sim/step.ts';
import { sampleTerrain } from '@sen/sim/sim/terrain.ts';
import type { TerrainData, WorldState } from '@sen/sim/sim/types.ts';
import { createWorld, findLandSpawn, makeStorm } from '@sen/sim/sim/world.ts';
import { Flag as NetFlag } from '@sen/protocol';
import { NetClient, type NetStorm } from '../net/client.ts';
import { serverUrl } from '../net/server.ts';
import { TouchControls } from '../ui/touch.ts';
import { UI, dailySeed } from '../ui/ui.ts';
import { t } from '../i18n/index.ts';
import { FixedLoop } from './loop.ts';
import { InputSource } from './input.ts';

/** The server told us this storm dissipated; see applyNetwork(). */
const NET_DEAD = NetFlag.Dead;

type Phase = 'menu' | 'playing' | 'dying' | 'over';

export class Game {
  private world: WorldState;
  private renderer: GameRenderer;
  private ui: UI;
  private input: InputSource;
  private touch = new TouchControls();
  private inputs = new InputCollector();
  private tracker = new RunTracker();
  private clip = new ClipRecorder();
  private loop: FixedLoop;

  private net = new NetClient();
  /** Online mode: the server owns storms and mass; the local sim is scenery. */
  private online = false;
  private netStorms: NetStorm[] = [];
  /** Set once a snapshot has carried our own storm; see stepOnce(). */
  private netSeenSelf = false;
  /**
   * Debug-only: drive the local storm with the game's own bot brain.
   *
   * The automated netplay test needs a player competent enough to stay alive
   * for a measurement window. Steering it from outside the page can only
   * happen a few times a second, and a storm crossing 520 units a second is
   * committed to a heading for a long way between corrections. This runs the
   * same brain the bots use, at the sim's own rate, through the same Input
   * the pointer produces - so the wire sees an ordinary player.
   */
  private autopilot: ((x: number, y: number, ang: number) => number) | null = null;

  private phase: Phase = 'menu';
  private dieTimer = 0;
  private seed = 1;
  private runBadges: BadgeId[] = [];
  private reduced = false;
  private installEvent: Event | null = null;

  constructor(
    private app: Application,
    private terrain: TerrainData,
  ) {
    const s = load();

    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.world = createWorld({
      seed: 1,
      terrain,
      bots: CAP_BOTS,
      instantDeathOnShred: s.harsh,
    });
    this.renderer = new GameRenderer(app, this.world);
    this.renderer.reducedMotion = this.reduced;

    this.ui = new UI({
      // "Again" after an online run means another live run, not a solo one:
      // this.online is still set until the player goes back to the menu.
      onPlay: (seed) => (this.online ? this.rejoinOnline() : this.startRun(seed)),
      onPlayOnline: () => this.startOnline(serverUrl()),
      onMenu: () => this.toMenu(),
      onSetting: (k, v) => this.setSetting(k, v),
      onSaveClip: () => void this.saveClip(),
      onShare: () => void this.share(),
      onInstall: () => void this.doInstall(),
    });
    this.ui.mapSlot.append(this.renderer.minimap.canvas);

    document.getElementById('ui')!.append(this.touch.root);
    this.input = new InputSource(app.canvas as unknown as HTMLElement, this.touch);
    this.input.pointerSteer = s.pointerSteer;
    this.input.onGesture = () => {
      if (s.sound) void audio.start();
    };
    this.input.onPause = () => {
      if (this.phase === 'playing') this.toMenu();
    };

    audio.calm = s.calm || this.reduced;
    audio.muted = !s.sound;

    this.loop = new FixedLoop(
      () => this.stepOnce(),
      (alpha, dt) => this.draw(alpha, dt),
    );

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => this.resize());
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvent = e;
      this.ui.offerInstall();
    });
    window.addEventListener('appinstalled', () => {
      this.pushBadges(unlock(['installPwa']));
      this.ui.hideInstall();
    });

    this.resize();
    this.tracker.preload(load().badges);
    // The online entry point exists only when a server does.
    if (serverUrl() !== '') this.ui.offerOnline();
    this.ui.show('menu');
    this.loop.start();

    // Diagnostic hook for the browser smoke test. Off unless this is a dev
    // build or the page was opened with ?debug, so the shipped game has no
    // handle on the world.
    if (import.meta.env.DEV || location.search.includes('debug')) {
      (window as unknown as Record<string, unknown>).__sen = {
        world: () => this.world,
        loop: () => this.loop,
        phase: () => this.phase,
        net: () => this.net,
        online: (url: string) => this.startOnline(url),
        // Terrain lookup, so an automated player can steer along a coastline
        // instead of driving into the sea and starving in a second - which is
        // the game working correctly and makes for a useless netcode test.
        terrainAt: (x: number, y: number) => sampleTerrain(this.terrain, x, y),
        // The heading the game's own bot brain would pick for the local storm.
        // A netcode test that drives with worse instincts than the AI spends
        // its time measuring how badly it plays rather than how the wire
        // behaves; this makes the automated player a competent one, and it
        // still goes out through the ordinary pointer input path.
        autoSteer: (): number => {
          const me = this.world.storms[this.world.playerId];
          if (me === undefined) return 0;
          const out = { steerAngle: me.ang, boosting: false };
          botInput(this.world, me, FIXED_DT, out);
          return out.steerAngle;
        },
        /**
         * Hand the wheel to the bot brain, optionally biased toward a point.
         * Pass null to take it back.
         */
        autopilot: (bias: { x: number; y: number } | null | false): void => {
          if (bias === false) {
            this.autopilot = null;
            return;
          }
          this.autopilot = (x, y, ang) => {
            const me = this.world.storms[this.world.playerId];
            if (me === undefined) return ang;
            if (bias !== null) {
              const dx = wrapDeltaX(x, bias.x);
              const dy = bias.y - y;
              if (Math.hypot(dx, dy) < 4500) {
                const want = Math.atan2(dy, dx);
                const t = sampleTerrain(
                  this.terrain,
                  wrapX(x + Math.cos(want) * 620),
                  y + Math.sin(want) * 620,
                );
                if (!t.water && !t.ice) return want;
              }
            }
            const out = { steerAngle: ang, boosting: false };
            botInput(this.world, me, FIXED_DT, out);
            return out.steerAngle;
          };
        },
      };
    }
  }

  // ------------------------------------------------------------------ setup

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.app.renderer.resize(w, h);
    this.renderer.resize(w, h);
  }

  private setSetting(key: string, value: boolean): void {
    save({ [key]: value } as never);
    if (key === 'sound') {
      audio.setMuted(!value);
      if (value) void audio.start();
    }
    if (key === 'calm') {
      audio.calm = value || this.reduced;
      this.renderer.reducedMotion = value || this.reduced;
    }
    if (key === 'pointerSteer') this.input.pointerSteer = value;
    if (key === 'debug' && !value) this.ui.setDebug(null);
    if (key === 'harsh') this.world.instantDeathOnShred = value;
  }

  // -------------------------------------------------------------------- run

  private startRun(seed: number | null): void {
    const s = load();
    this.seed = seed ?? ((Math.random() * 0x7fffffff) | 0);
    this.world = createWorld({
      seed: this.seed,
      terrain: this.terrain,
      bots: CAP_BOTS,
      instantDeathOnShred: s.harsh,
    });
    this.inputs = new InputCollector();
    this.tracker.reset();
    this.tracker.preload(s.badges);
    this.runBadges = [];
    this.phase = 'playing';
    this.dieTimer = 0;

    this.renderer.reset(this.world);
    save({ runs: s.runs + 1 });
    this.pushBadges(awardMeta());

    this.ui.show('game');
    this.touch.setActive(true);
    if (load().sound) void audio.start();
    audio.setRank(1);
    this.clip.start(this.app.canvas as unknown as HTMLCanvasElement);
  }

  /**
   * Join a live instance.
   *
   * The local world still runs: it owns the terrain, props, stickmen and
   * cities, all of which are deterministic from the server's seed and none of
   * which need to cross the wire. The server owns storms, mass and every
   * outcome, and overwrites them here each tick.
   */
  startOnline(url: string): void {
    if (url === '') return;
    const s = load();
    this.online = true;
    this.netSeenSelf = false;
    this.ui.notice(t('menu.connecting'));

    // A server that is down must not leave the player staring at a dead
    // button: give up after a few seconds and say so, with single player one
    // click away.
    const giveUp = window.setTimeout(() => {
      if (this.net.status !== 'live') {
        this.net.disconnect();
        this.online = false;
        this.ui.notice(t('menu.offline'));
        window.setTimeout(() => this.ui.notice(null), 4000);
      }
    }, 8000);
    this.net.onWelcome = (welcome) => {
      this.seed = welcome.seed;
      this.world = createWorld({
        seed: welcome.seed,
        terrain: this.terrain,
        bots: CAP_BOTS,
        instantDeathOnShred: s.harsh,
        // Storms, mass and every outcome belong to the server from here on.
        remoteAuthority: true,
      });
      // The server's storm ids are dense from 0; ours must line up so a
      // snapshot can address them directly. An instance that has been running
      // a while hands out ids past our local bot count, so the gap is filled
      // with real, distinctly-identified storms - never with aliases of
      // storm 0, which would leave two array slots pointing at one object and
      // let a bookkeeping pass over one of them kill the other.
      this.world.playerId = welcome.selfId;
      while (this.world.storms.length <= welcome.selfId) {
        const id = this.world.storms.length;
        const ghost = makeStorm(id, 'bot', '', 0, 0, START_MASS);
        // It exists only so ids line up. The server decides whether it is real.
        ghost.alive = false;
        this.world.storms.push(ghost);
      }
      // Our own storm is real from this moment, whether it came out of the
      // local bot roster or out of the gap above. It is not dead just because
      // the first snapshot is still 100ms away.
      const me = this.world.storms[welcome.selfId];
      me.kind = 'player';
      me.name = 'You';
      me.alive = true;
      me.mass = START_MASS;
      if (me.x === 0 && me.y === 0) {
        const [sx, sy] = findLandSpawn(this.world);
        me.x = sx;
        me.y = sy;
      }
      window.clearTimeout(giveUp);
      this.ui.notice(null);
      this.net.resetPrediction(me.x, me.y, me.ang);
      this.renderer.reset(this.world);
      this.phase = 'playing';
      this.ui.show('game');
      this.touch.setActive(true);
      this.net.sendViewport(this.renderer.cam.w / this.renderer.cam.zoom,
        this.renderer.cam.h / this.renderer.cam.zoom);
    };
    this.net.connect(url, 'Storm');
  }

  /** Drop the socket and take a fresh spawn on the same server. */
  private rejoinOnline(): void {
    const url = serverUrl();
    this.net.disconnect();
    this.online = false;
    if (url === '') {
      this.startRun(null);
      return;
    }
    this.ui.show('menu');
    this.startOnline(url);
  }

  private toMenu(): void {
    this.phase = 'menu';
    if (this.online) {
      this.net.disconnect();
      this.online = false;
    }
    this.touch.setActive(false);
    this.clip.stop();
    this.ui.show('menu');
  }

  // ------------------------------------------------------------------- step

  private stepOnce(): void {
    if (this.phase === 'menu') return;

    const w = this.world;
    const p = w.storms[w.playerId];

    if (this.phase === 'playing' && p !== undefined && p.alive) {
      this.inputs.setPlayer(
        w.playerId,
        this.steerNow(p.x, p.y, p.ang),
        this.input.boosting,
      );
    }

    step(w, this.inputs.collect(w));

    // In online mode everything the server owns is stamped over the local
    // sim's version of it, after the step and before anything reads it.
    if (this.online) this.applyNetwork(w);

    this.renderer.handleEvents(w, w.events);
    this.reactToEvents();
    this.tracker.update(w, FIXED_DT);
    for (const e of w.events) this.tracker.onEvent(w, e);
    this.pushBadges(unlock(this.tracker.drain()));

    // Online, a storm is dead only when the server says so. Before the first
    // snapshot lands there is nothing to say it, and treating the gap as a
    // death shows a game-over card to a player who has not started yet.
    const canDie = !this.online || this.netSeenSelf;
    if (this.phase === 'playing' && canDie && (w.over || (p !== undefined && !p.alive))) {
      this.phase = 'dying';
      this.dieTimer = 0;
      if (!w.over || w.winner !== w.playerId) audio.dissipate();
    }

    if (this.phase === 'dying') {
      this.dieTimer += FIXED_DT;
      this.renderer.fade = clamp(this.dieTimer / 0.4, 0, 1);
      // Dissipation plays out over 0.8s, the win holds for a beat longer.
      const wait = w.winner === w.playerId ? 2.2 : 1.25;
      if (this.dieTimer >= wait) this.finish();
    }
  }

  /**
   * Where the player wants to go. One source, used by both the local step and
   * the prediction - two would drift against each other by a frame and the
   * reconciler would spend its life mopping it up.
   */
  private steerNow(x: number, y: number, ang: number): number {
    if (this.autopilot !== null) return this.autopilot(x, y, ang);
    return this.input.steerAngle(this.renderer.cam, x, y, ang);
  }

  /**
   * Stamp server truth over the local sim.
   *
   * Movement for our own storm comes from the predictor; everything else is
   * interpolated 100ms in the past. Mass is never predicted - it is whatever
   * the last snapshot said, which is why eating never rubber-bands.
   */
  private applyNetwork(w: WorldState): void {
    const me = w.storms[w.playerId];
    if (me === undefined) return;

    // Predict our own movement with the same integration the sim uses.
    this.net.predict(FIXED_DT, (x, y, ang, dt) => {
      const target = this.steerNow(x, y, ang);
      const turn = maxTurnRate(me.mass) * dt;
      const na = ang + clamp(angleDelta(ang, target), -turn, turn);
      const sp = stormSpeed(me.mass) * (this.input.boosting ? BOOST_SPEED_MUL : 1);
      return [x + Math.cos(na) * sp * dt, y + Math.sin(na) * sp * dt, na];
    });

    const p = this.net.predicted();
    me.x = p.x;
    me.y = p.y;
    me.ang = p.ang;

    const remote = this.net.interpolated(this.netStorms);
    const seen = new Set<number>();
    for (const r of remote) {
      seen.add(r.id);
      const s = w.storms[r.id];
      if (s === undefined) continue;
      if (r.id === w.playerId) this.netSeenSelf = true;
      if (r.id === w.playerId && (r.flags & NET_DEAD) !== 0) {
        // The server says we dissipated. Let the normal death path run.
        s.alive = false;
        s.mass = 0;
        continue;
      }
      s.alive = true;
      s.mass = r.mass;
      s.rank = rankOf(r.mass);
      if (r.name !== '') s.name = r.name;
      if (r.id === w.playerId) continue;
      s.x = wrapX(r.x);
      s.y = r.y;
      s.ang = r.ang;
    }
    // Anything the server stopped sending is out of view or gone.
    for (const s of w.storms) {
      if (s.id !== w.playerId && !seen.has(s.id)) s.alive = false;
    }

    for (const e of this.net.drainEvents()) {
      w.events.push({ type: e.type as never, storm: e.storm, x: e.x, y: e.y, a: e.a, b: 0 });
      // The local sim is forbidden from declaring a winner online, so the win
      // arrives the same way every other outcome does: as an event.
      if (e.type === 'win') {
        w.winner = e.storm;
        if (e.storm === w.playerId) w.over = true;
      }
    }
  }

  private reactToEvents(): void {
    const w = this.world;
    for (const e of w.events) {
      const mine = e.storm === w.playerId;
      switch (e.type) {
        case 'absorb':
          audio.play('inhale', mine ? 1 : 0.35, 0.8 + (e.a % 5) * 0.12);
          if (e.b === 1) audio.play('scream', mine ? 0.9 : 0.3);
          break;
        case 'buildingCollapse':
          audio.play('collapse', mine ? 1 : 0.4);
          break;
        case 'shred':
          audio.play('shred', mine ? 1 : 0.35);
          break;
        case 'eyeHit':
          audio.play('crunch', mine ? 1 : 0.3);
          break;
        case 'rankUp':
          if (mine) {
            audio.play('rankup');
            audio.setRank(e.a);
          }
          break;
        case 'dissipate':
          audio.play('dissipate', mine ? 1 : 0.25);
          break;
        case 'boostEject':
          if (mine) audio.play('boost', 0.5);
          break;
        case 'chaser':
          if (mine) audio.play('badge');
          break;
        default:
          break;
      }
    }
  }

  private pushBadges(ids: BadgeId[]): void {
    for (const id of ids) {
      this.runBadges.push(id);
      this.ui.toast(id);
      audio.play('badge');
    }
  }

  private finish(): void {
    const w = this.world;
    const p = w.storms[w.playerId];
    const won = w.winner === w.playerId;
    this.phase = 'over';
    this.touch.setActive(false);

    const s = load();
    save({
      bestMass: Math.max(s.bestMass, p?.stats.peakMass ?? 0),
      bestRank: Math.max(s.bestRank, rankOf(p?.stats.peakMass ?? 0)),
      wins: s.wins + (won ? 1 : 0),
    });
    this.pushBadges(awardMeta());

    this.ui.showGameOver({
      won,
      rank: rankOf(p?.stats.peakMass ?? 10),
      peakMass: p?.stats.peakMass ?? 0,
      time: p?.stats.aliveTime ?? 0,
      shreds: p?.stats.shredsDealt ?? 0,
      cities: p?.stats.citiesEmptied ?? 0,
      eaten: p?.stats.stickmen ?? 0,
      newBadges: this.runBadges.slice(0, 8),
      canClip: this.clip.hasClip,
    });
  }

  // ------------------------------------------------------------------- draw

  private draw(_alpha: number, dt: number): void {
    const w = this.world;
    if (this.online && this.phase === 'playing') {
      const p = w.storms[w.playerId];
      if (p !== undefined) {
        this.net.sendInput(
          dt,
          this.input.steerAngle(this.renderer.cam, p.x, p.y, p.ang),
          this.input.boosting,
        );
      }
    }
    this.renderer.draw(w, dt);

    if (this.phase === 'playing' || this.phase === 'dying') {
      this.updateHud();
      this.updateAudio();
    }

    const s = load();
    if (s.debug) this.ui.setDebug(this.debugText());
  }

  private updateHud(): void {
    const w = this.world;
    const p = w.storms[w.playerId];
    if (p === undefined) return;

    const def = RANKS[clamp(p.rank, 1, RANKS.length) - 1];
    const span = def.max === Infinity ? def.min : def.max - def.min;
    const progress = def.max === Infinity ? 1 : clamp((p.mass - def.min) / span, 0, 1);

    // Leaderboard: top four plus you, so you always see the gap.
    const sorted = w.storms.filter((s) => s.alive).sort((a, b) => b.mass - a.mass);
    const leaders = sorted.slice(0, 4).map((s) => ({
      name: s.id === w.playerId ? 'You' : s.name,
      mass: s.mass,
      me: s.id === w.playerId,
      nina: s.isLaNina,
    }));
    if (!leaders.some((l) => l.me)) {
      leaders.push({ name: 'You', mass: p.mass, me: true, nina: false });
    }

    // Danger: any rival's field edge within a storm's length of your eye.
    let danger = false;
    for (const s of w.storms) {
      if (!s.alive || s.id === p.id || s.mass < p.mass * 0.6) continue;
      const d = wrapDist(p.x, p.y, s.x, s.y);
      if (d < s.mass * 0.06 + 260) {
        danger = true;
        break;
      }
    }

    this.ui.updateHud({
      rank: p.rank,
      rankProgress: progress,
      mass: p.mass,
      leaders,
      danger,
      winProgress: clamp(p.winTimer / 60, 0, 1),
      showHold: p.rank >= 6 && warmPoolT(p.x, p.y) <= 1.6,
    });
  }

  private updateAudio(): void {
    if (!audio.ready) return;
    const w = this.world;
    const p = w.storms[w.playerId];
    if (p === undefined) return;

    let rival = null;
    let rivalD = Infinity;
    for (const s of w.storms) {
      if (!s.alive || s.id === p.id) continue;
      const d = wrapDist(p.x, p.y, s.x, s.y);
      if (d < rivalD) {
        rivalD = d;
        rival = s;
      }
    }

    const here = sampleTerrain(w.terrain, p.x, p.y);
    // At Hurricane and above over water, the funnel wobble gives way to a
    // deeper ocean swell. The storm should sound different at sea.
    const oceanMix = here.water && p.rank >= 4 ? 1 : 0;

    audio.update({
      mass: p.mass,
      oceanMix,
      rank: p.rank,
      rivalMass: rival?.mass ?? 10,
      rivalPan: rival === null ? 0 : clamp(wrapDeltaX(p.x, rival.x) / 1400, -1, 1),
      rivalDist: rivalD,
      draining: p.drainingCity >= 0,
      winProgress: clamp(p.winTimer / 60, 0, 1),
      duck: p.drainingCity >= 0,
    });
  }

  private debugText(): string {
    const w = this.world;
    const p = w.storms[w.playerId];
    const c = this.renderer.counts;
    const alive = w.storms.filter((s) => s.alive).length;
    return (
      `fps ${this.loop.fps.toFixed(0)}  sim ${this.loop.simMs.toFixed(2)}ms  ` +
      `draw ${this.loop.drawMs.toFixed(2)}ms  steps ${this.loop.steps}\n` +
      `mass ${p?.mass.toFixed(1) ?? '-'}  rank ${p?.rank ?? '-'}  ` +
      `field ${p?.field.length ?? 0}  zoom ${this.renderer.cam.zoom.toFixed(2)}\n` +
      `props ${c.props}  men ${c.men}  debris ${c.debris}  bldg ${c.buildings}\n` +
      `storms ${alive}/${w.storms.length}  chunks ${w.chunks.size}  tick ${w.tick}\n` +
      `pos ${p?.x.toFixed(0) ?? '-'},${p?.y.toFixed(0) ?? '-'}  ` +
      `pool ${warmPoolT(p?.x ?? 0, p?.y ?? 0).toFixed(2)}  seed ${this.seed}`
    );
  }

  // ------------------------------------------------------------------ share

  private async saveClip(): Promise<void> {
    const ok = await this.clip.save(`superelnino-${this.seed}`);
    if (ok) this.pushBadges(unlock(['shareClip']));
  }

  private async share(): Promise<void> {
    const p = this.world.storms[this.world.playerId];
    const ok = await shareCard(this.world, {
      rank: rankOf(p?.stats.peakMass ?? 10),
      peakMass: p?.stats.peakMass ?? 0,
      seed: this.seed,
      badges: load().badges,
      won: this.world.winner === this.world.playerId,
    });
    if (ok) this.pushBadges(unlock(['shareClip']));
  }

  private async doInstall(): Promise<void> {
    const e = this.installEvent as (Event & { prompt?: () => Promise<void> }) | null;
    if (e?.prompt !== undefined) {
      await e.prompt();
      this.installEvent = null;
    }
  }

  /** Exposed so the menu can offer today's world. */
  static daily(): number {
    return dailySeed();
  }

  /** Kept for symmetry with the warm-pool constants the HUD references. */
  static poolCentre(): [number, number] {
    return [WARM_POOL_X, WARM_POOL_Y];
  }
}
