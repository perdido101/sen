/**
 * The game controller: owns the world, the loop, the renderer, audio, badges
 * and the UI, and nothing else knows about more than one of those.
 */

import { Application } from 'pixi.js';
import { audio } from '../audio/engine.ts';
import { InputCollector } from '../bots/drive.ts';
import { RunTracker, type BadgeId } from '../game/badges.ts';
import { ClipRecorder } from '../game/clip.ts';
import { awardMeta, load, save, unlock } from '../game/persist.ts';
import { shareCard } from '../game/shareCard.ts';
import { GameRenderer } from '../render/renderer.ts';
import {
  CAP_BOTS,
  FIXED_DT,
  RANKS,
  WARM_POOL_X,
  WARM_POOL_Y,
  clamp,
  rankOf,
  warmPoolT,
  wrapDeltaX,
  wrapDist,
} from '../sim/constants.ts';
import { step } from '../sim/step.ts';
import { sampleTerrain } from '../sim/terrain.ts';
import type { TerrainData, WorldState } from '../sim/types.ts';
import { createWorld } from '../sim/world.ts';
import { UI, dailySeed } from '../ui/ui.ts';
import { FixedLoop } from './loop.ts';
import { InputSource } from './input.ts';

type Phase = 'menu' | 'playing' | 'dying' | 'over';

export class Game {
  private world: WorldState;
  private renderer: GameRenderer;
  private ui: UI;
  private input: InputSource;
  private inputs = new InputCollector();
  private tracker = new RunTracker();
  private clip = new ClipRecorder();
  private loop: FixedLoop;

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
      onPlay: (seed) => this.startRun(seed),
      onMenu: () => this.toMenu(),
      onSetting: (k, v) => this.setSetting(k, v),
      onSaveClip: () => void this.saveClip(),
      onShare: () => void this.share(),
      onInstall: () => void this.doInstall(),
    });
    this.ui.mapSlot.append(this.renderer.minimap.canvas);

    this.input = new InputSource(app.canvas as unknown as HTMLElement);
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
    if (load().sound) void audio.start();
    audio.setRank(1);
    this.clip.start(this.app.canvas as unknown as HTMLCanvasElement);
  }

  private toMenu(): void {
    this.phase = 'menu';
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
        this.input.steerAngle(this.renderer.cam, p.x, p.y, p.ang),
        this.input.boosting,
      );
    }

    step(w, this.inputs.collect(w));

    this.renderer.handleEvents(w, w.events);
    this.reactToEvents();
    this.tracker.update(w, FIXED_DT);
    for (const e of w.events) this.tracker.onEvent(w, e);
    this.pushBadges(unlock(this.tracker.drain()));

    if (this.phase === 'playing' && (w.over || (p !== undefined && !p.alive))) {
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
