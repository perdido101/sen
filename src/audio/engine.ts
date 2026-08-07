/**
 * Audio.
 *
 * The storm roar is procedural, not a sample. It is the one continuously
 * playing sound and it must be the mass readout: zero download, infinitely
 * responsive, and it does what a sample can't - players hear how big a rival
 * is before seeing it.
 *
 * A second distant-roar bus tracks the nearest rival, panned by direction and
 * attenuated by distance: a proximity warning built from the game's own
 * fiction.
 *
 * The one-shots and music stems are synthesised here too rather than loaded,
 * so the game ships with no audio assets at all and plays offline on first
 * run. Every voice is pooled through the same graph.
 */

import { RANKS, clamp, lerp } from '../sim/constants.ts';

type Ctx = AudioContext;

function noiseBuffer(ctx: Ctx, seconds = 4): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Deterministic noise so the roar sounds the same every session.
  let s = 0x2f6e2b1;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x3fffffff - 1) * 0.6;
  }
  return buf;
}

/** One continuously-running noise voice with a filter chain. */
class RoarVoice {
  readonly gain: GainNode;
  private src: AudioBufferSourceNode;
  private lp: BiquadFilterNode;
  private bp: BiquadFilterNode;
  private swell: BiquadFilterNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  readonly pan: StereoPannerNode;

  constructor(ctx: Ctx, buf: AudioBuffer) {
    this.src = ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.loop = true;

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 800;

    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 320;
    this.bp.Q.value = 1.4;

    // The deeper ocean-swell layer, blended in at Hurricane+ over water.
    this.swell = ctx.createBiquadFilter();
    this.swell.type = 'lowshelf';
    this.swell.frequency.value = 140;
    this.swell.gain.value = 0;

    // Wobble.
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.7;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 120;
    this.lfo.connect(this.lfoGain).connect(this.bp.frequency);

    this.pan = ctx.createStereoPanner();
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.src.connect(this.lp).connect(this.bp).connect(this.swell).connect(this.pan).connect(this.gain);
    this.src.start();
    this.lfo.start();
  }

  /**
   * @param mass  drives pitch and body - this is the readout
   * @param level output gain
   * @param oceanMix 0 = funnel wobble, 1 = ocean swell
   */
  set(t: number, mass: number, level: number, oceanMix: number, pan: number, detune = 1): void {
    const m = clamp(Math.log(Math.max(10, mass) / 10) / Math.log(500), 0, 1);
    // Bigger storms are lower and wider. Small ones hiss.
    const lpf = lerp(1100, 340, m) * detune;
    const bpf = lerp(560, 90, m) * detune;
    this.lp.frequency.setTargetAtTime(lpf, t, 0.25);
    this.bp.frequency.setTargetAtTime(bpf, t, 0.25);
    this.bp.Q.setTargetAtTime(lerp(1.1, 3.4, m), t, 0.4);
    this.lfo.frequency.setTargetAtTime(lerp(1.6, 0.34, m) * (1 - oceanMix * 0.6), t, 0.5);
    this.lfoGain.gain.setTargetAtTime(lerp(140, 46, m) * (1 - oceanMix * 0.75), t, 0.5);
    this.swell.gain.setTargetAtTime(oceanMix * 16, t, 0.6);
    this.pan.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.2);
    this.gain.gain.setTargetAtTime(level, t, 0.12);
  }

  /** Rank-up drops the roar a semitone; dissipation opens the filter and cuts. */
  flourish(t: number, kind: 'rankup' | 'die'): void {
    if (kind === 'rankup') {
      this.bp.frequency.cancelScheduledValues(t);
      const f = this.bp.frequency.value;
      this.bp.frequency.setValueAtTime(f, t);
      this.bp.frequency.exponentialRampToValueAtTime(Math.max(40, f * 0.944), t + 0.5);
    } else {
      this.lp.frequency.cancelScheduledValues(t);
      this.lp.frequency.setValueAtTime(this.lp.frequency.value, t);
      this.lp.frequency.exponentialRampToValueAtTime(9000, t + 0.55);
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(this.gain.gain.value, t);
      this.gain.gain.linearRampToValueAtTime(0, t + 0.8);
    }
  }
}

// ---------------------------------------------------------------------------
// Music: four stems layering in by rank. 2s crossfade on rank change.
// ---------------------------------------------------------------------------

const CHORD = [
  [0, 3, 7, 10],
  [-2, 2, 5, 9],
  [-4, 0, 3, 7],
  [-5, -1, 2, 7],
];

class Stems {
  readonly out: GainNode;
  private gains: GainNode[] = [];
  private step = 0;
  private nextAt = 0;
  private bpm = 78;

  constructor(private ctx: Ctx, noise: AudioBuffer) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.0;

    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out);
      this.gains.push(g);
    }

    // Stem 0: wind pad - filtered noise, always the bed.
    const wind = ctx.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 420;
    wf.Q.value = 0.6;
    const wlfo = ctx.createOscillator();
    wlfo.frequency.value = 0.08;
    const wlg = ctx.createGain();
    wlg.gain.value = 180;
    wlfo.connect(wlg).connect(wf.frequency);
    wind.connect(wf).connect(this.gains[0]);
    wind.start();
    wlfo.start();
  }

  /** Percussion and strings are scheduled a bar ahead on each tick. */
  schedule(now: number, rank: number): void {
    const beat = 60 / this.bpm;
    while (this.nextAt < now + 0.4) {
      if (this.nextAt < now) this.nextAt = now + 0.05;
      const t = this.nextAt;
      const bar = Math.floor(this.step / 8) % CHORD.length;

      // Stem 1: low percussion.
      if (rank >= 2 && this.step % 4 === 0) this.kick(t, 1);
      if (rank >= 5 && this.step % 2 === 1) this.tick(t, 3);

      // Stem 2: strings.
      if (rank >= 3 && this.step % 8 === 0) {
        for (const semi of CHORD[bar]) this.pad(t, 110 * Math.pow(2, semi / 12), beat * 4, 2);
      }

      // Stem 3: full storm - a fifth above, with a brassy edge.
      if (rank >= 4 && this.step % 8 === 4) {
        for (const semi of CHORD[bar]) this.pad(t, 220 * Math.pow(2, (semi + 7) / 12), beat * 2, 3);
      }

      this.step++;
      this.nextAt += beat / 2;
    }
  }

  private kick(t: number, stem: number): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.gains[stem]);
    o.start(t);
    o.stop(t + 0.34);
  }

  private tick(t: number, stem: number): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = 2400;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(this.gains[stem]);
    o.start(t);
    o.stop(t + 0.07);
  }

  private pad(t: number, freq: number, dur: number, stem: number): void {
    const o = this.ctx.createOscillator();
    const o2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    o.type = 'sawtooth';
    o2.type = 'sawtooth';
    o.frequency.value = freq;
    o2.frequency.value = freq * 1.006;
    f.type = 'lowpass';
    f.frequency.value = stem === 3 ? 2000 : 900;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(stem === 3 ? 0.055 : 0.075, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(f);
    o2.connect(f);
    f.connect(g).connect(this.gains[stem]);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 0.1);
    o2.stop(t + dur + 0.1);
  }

  /** Stems layer in by rank with a 2s crossfade. */
  setRank(t: number, rank: number): void {
    const want = [1, rank >= 2 ? 1 : 0, rank >= 3 ? 1 : 0, rank >= 4 ? 1 : 0];
    for (let i = 0; i < 4; i++) {
      this.gains[i].gain.setTargetAtTime(want[i] * (i === 0 ? 0.5 : 0.85), t, 2 / 3);
    }
  }
}

// ---------------------------------------------------------------------------

export type SfxName =
  | 'inhale' | 'collapse' | 'crunch' | 'snap' | 'scream' | 'siren'
  | 'boost' | 'shred' | 'rankup' | 'dissipate' | 'badge' | 'poolhum' | 'ui';

export class Audio {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private roar: RoarVoice | null = null;
  private rival: RoarVoice | null = null;
  private stems: Stems | null = null;
  private noise: AudioBuffer | null = null;
  private sirenGain: GainNode | null = null;
  private poolGain: GainNode | null = null;
  private poolOsc: OscillatorNode | null = null;

  private lastOne = new Map<string, number>();
  muted = false;
  /** Linked to prefers-reduced-motion: calm mode softens everything. */
  calm = false;

  /** Must be called from a user gesture. */
  async start(): Promise<void> {
    if (this.ctx !== null) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.noise = noiseBuffer(ctx);

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.5;
    this.musicBus.connect(this.master);

    this.roar = new RoarVoice(ctx, this.noise);
    this.roar.gain.connect(this.master);
    this.rival = new RoarVoice(ctx, this.noise);
    this.rival.gain.connect(this.master);

    this.stems = new Stems(ctx, this.noise);
    this.stems.out.connect(this.musicBus);
    this.stems.out.gain.value = 1;

    // City siren, looping while draining.
    const so = ctx.createOscillator();
    const sg = ctx.createGain();
    const slfo = ctx.createOscillator();
    const slg = ctx.createGain();
    so.type = 'sawtooth';
    so.frequency.value = 480;
    slfo.frequency.value = 0.28;
    slg.gain.value = 180;
    slfo.connect(slg).connect(so.frequency);
    sg.gain.value = 0;
    so.connect(sg).connect(this.sfxBus);
    so.start();
    slfo.start();
    this.sirenGain = sg;

    // Warm-pool hum, rising in pitch as the timer fills.
    const po = ctx.createOscillator();
    const pg = ctx.createGain();
    po.type = 'triangle';
    po.frequency.value = 90;
    pg.gain.value = 0;
    po.connect(pg).connect(this.sfxBus);
    po.start();
    this.poolGain = pg;
    this.poolOsc = po;

    await ctx.resume();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master !== null && this.ctx !== null) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * @param duck -6dB in cities so sirens carry
   */
  update(o: {
    mass: number;
    oceanMix: number;
    rank: number;
    rivalMass: number;
    rivalPan: number;
    rivalDist: number;
    draining: boolean;
    winProgress: number;
    duck: boolean;
  }): void {
    const ctx = this.ctx;
    if (ctx === null || this.roar === null || this.rival === null) return;
    const t = ctx.currentTime;
    const calm = this.calm ? 0.55 : 1;

    this.roar.set(t, o.mass, 0.26 * calm, o.oceanMix, 0, 1);

    // Distant rival: attenuated by distance, panned by direction.
    const near = clamp(1 - o.rivalDist / 2600, 0, 1);
    this.rival.set(t, o.rivalMass, near * near * 0.2 * calm, o.oceanMix * 0.5, o.rivalPan, 1.15);

    if (this.musicBus !== null) {
      this.musicBus.gain.setTargetAtTime((o.duck ? 0.25 : 0.5) * calm, t, 0.3);
    }
    if (this.sirenGain !== null) {
      this.sirenGain.gain.setTargetAtTime(o.draining ? 0.05 * calm : 0, t, 0.25);
    }
    if (this.poolGain !== null && this.poolOsc !== null) {
      this.poolGain.gain.setTargetAtTime(o.winProgress > 0 ? 0.07 * calm : 0, t, 0.4);
      this.poolOsc.frequency.setTargetAtTime(90 + o.winProgress * 210, t, 0.4);
    }
    if (this.stems !== null) {
      this.stems.schedule(t, o.rank);
    }
  }

  setRank(rank: number): void {
    if (this.ctx === null) return;
    const t = this.ctx.currentTime;
    this.stems?.setRank(t, clamp(rank, 1, RANKS.length));
    this.roar?.flourish(t, 'rankup');
  }

  dissipate(): void {
    if (this.ctx === null) return;
    this.roar?.flourish(this.ctx.currentTime, 'die');
  }

  /** Pooled one-shots. Rate-limited per name so a city drain cannot machine-gun. */
  play(name: SfxName, gain = 1, detune = 1): void {
    const ctx = this.ctx;
    if (ctx === null || this.sfxBus === null || this.noise === null) return;
    const now = ctx.currentTime;
    const min = name === 'inhale' ? 0.045 : name === 'scream' ? 0.09 : 0.02;
    const last = this.lastOne.get(name) ?? -1;
    if (now - last < min) return;
    this.lastOne.set(name, now);

    const g = ctx.createGain();
    g.connect(this.sfxBus);
    const vol = gain * (this.calm ? 0.6 : 1);

    switch (name) {
      case 'inhale': {
        const s = ctx.createBufferSource();
        s.buffer = this.noise;
        s.playbackRate.value = 1.4 * detune;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(500 * detune, now);
        f.frequency.exponentialRampToValueAtTime(2100 * detune, now + 0.12);
        f.Q.value = 5;
        g.gain.setValueAtTime(0.14 * vol, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        s.connect(f).connect(g);
        s.start(now, Math.random() * 3);
        s.stop(now + 0.2);
        break;
      }
      case 'collapse': {
        const s = ctx.createBufferSource();
        s.buffer = this.noise;
        s.playbackRate.value = 0.6;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(1400, now);
        f.frequency.exponentialRampToValueAtTime(180, now + 0.5);
        g.gain.setValueAtTime(0.3 * vol, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        s.connect(f).connect(g);
        s.start(now, Math.random() * 3);
        s.stop(now + 0.65);
        break;
      }
      case 'crunch':
      case 'snap': {
        const s = ctx.createBufferSource();
        s.buffer = this.noise;
        s.playbackRate.value = name === 'snap' ? 2.2 : 1.1;
        const f = ctx.createBiquadFilter();
        f.type = name === 'snap' ? 'highpass' : 'bandpass';
        f.frequency.value = name === 'snap' ? 1800 : 700;
        g.gain.setValueAtTime(0.18 * vol, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        s.connect(f).connect(g);
        s.start(now, Math.random() * 3);
        s.stop(now + 0.15);
        break;
      }
      case 'scream': {
        // Comic, never gruesome - this stays cartoon.
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const base = 420 + Math.random() * 380;
        o.frequency.setValueAtTime(base, now);
        o.frequency.linearRampToValueAtTime(base * 1.7, now + 0.1);
        o.frequency.linearRampToValueAtTime(base * 0.7, now + 0.28);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1100;
        f.Q.value = 3;
        g.gain.setValueAtTime(0.05 * vol, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        o.connect(f).connect(g);
        o.start(now);
        o.stop(now + 0.32);
        break;
      }
      case 'boost': {
        const s = ctx.createBufferSource();
        s.buffer = this.noise;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.setValueAtTime(300, now);
        f.frequency.exponentialRampToValueAtTime(1900, now + 0.3);
        f.Q.value = 2.5;
        g.gain.setValueAtTime(0.12 * vol, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
        s.connect(f).connect(g);
        s.start(now, Math.random() * 3);
        s.stop(now + 0.36);
        break;
      }
      case 'shred': {
        const s = ctx.createBufferSource();
        s.buffer = this.noise;
        s.playbackRate.value = 0.8;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(3000, now);
        f.frequency.exponentialRampToValueAtTime(200, now + 0.4);
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(180, now);
        o.frequency.exponentialRampToValueAtTime(50, now + 0.35);
        g.gain.setValueAtTime(0.4 * vol, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        s.connect(f).connect(g);
        o.connect(g);
        s.start(now, Math.random() * 3);
        s.stop(now + 0.5);
        o.start(now);
        o.stop(now + 0.4);
        break;
      }
      case 'rankup':
      case 'badge':
      case 'ui': {
        const notes = name === 'rankup' ? [523, 659, 784, 1046] : name === 'badge' ? [784, 1046] : [660];
        notes.forEach((freq, i) => {
          const o = ctx.createOscillator();
          const gg = ctx.createGain();
          o.type = 'triangle';
          o.frequency.value = freq;
          const at = now + i * 0.07;
          gg.gain.setValueAtTime(0, at);
          gg.gain.linearRampToValueAtTime(0.1 * vol, at + 0.02);
          gg.gain.exponentialRampToValueAtTime(0.001, at + 0.4);
          o.connect(gg).connect(this.sfxBus!);
          o.start(at);
          o.stop(at + 0.45);
        });
        break;
      }
      case 'dissipate': {
        const s = ctx.createBufferSource();
        s.buffer = this.noise;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(4000, now);
        f.frequency.exponentialRampToValueAtTime(120, now + 0.9);
        g.gain.setValueAtTime(0.3 * vol, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
        s.connect(f).connect(g);
        s.start(now, Math.random() * 3);
        s.stop(now + 1.05);
        break;
      }
      default:
        break;
    }
  }
}

export const audio = new Audio();
