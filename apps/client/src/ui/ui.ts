/**
 * All chrome is plain HTML/CSS layered over the canvas, updated through this
 * one module. React would cost frames for zero benefit.
 *
 * Nothing here reads the simulation directly - the game pushes it a small
 * view-model each frame.
 */

import { RANKS, clamp } from '@sen/sim/sim/constants.ts';
import { BADGES, type BadgeId } from '../game/badges.ts';
import { load, save, type Save } from '../game/persist.ts';
import { t } from '../i18n/index.ts';
import { badgeIcon, lockedIcon } from './badgeIcons.ts';

export interface HudModel {
  rank: number;
  rankProgress: number;
  mass: number;
  leaders: { name: string; mass: number; me: boolean; nina: boolean }[];
  danger: boolean;
  winProgress: number;
  showHold: boolean;
}

export interface OverModel {
  won: boolean;
  rank: number;
  peakMass: number;
  time: number;
  shreds: number;
  cities: number;
  eaten: number;
  newBadges: BadgeId[];
  canClip: boolean;
}

export interface UIHooks {
  onPlay(seed: number | null): void;
  /** Join a live instance. Only ever called if a server was configured. */
  onPlayOnline(): void;
  onMenu(): void;
  onSetting(key: keyof Save, value: boolean): void;
  onSaveClip(): void;
  onShare(): void;
  onInstall(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

export class UI {
  private root: HTMLElement;
  private loadingEl: HTMLElement;
  private menuEl: HTMLElement;
  private hudEl: HTMLElement;
  private overEl: HTMLElement;
  private galleryEl: HTMLElement;
  private settingsEl: HTMLElement;
  private toastsEl: HTMLElement;
  private debugEl: HTMLElement;
  private installEl: HTMLElement;

  private rankNameEl!: HTMLElement;
  private rankMassEl!: HTMLElement;
  private rankBarEl!: HTMLElement;
  private leaderEl!: HTMLElement;
  private warnEl!: HTMLElement;
  private holdEl!: HTMLElement;
  private holdBarEl!: HTMLElement;
  private alertEl!: HTMLElement;
  readonly mapSlot: HTMLElement;

  private toastQueue: BadgeId[] = [];
  private toastLive = 0;
  private lastRankShown = 0;

  constructor(private hooks: UIHooks) {
    this.root = document.getElementById('ui')!;

    this.loadingEl = el('div', 'loading');
    this.loadingEl.append(el('div', 'spinner'), el('div', '', t('loading')));

    this.mapSlot = el('div', 'hud-map');
    this.hudEl = this.buildHud();
    this.menuEl = this.buildMenu();
    this.overEl = el('div', 'panel');
    this.overEl.hidden = true;
    this.galleryEl = this.buildGallery();
    this.settingsEl = this.buildSettings();
    this.toastsEl = el('div', 'toasts');
    this.debugEl = el('div', 'debug');
    this.debugEl.hidden = true;
    this.installEl = this.buildInstall();

    this.root.append(
      this.hudEl,
      this.menuEl,
      this.overEl,
      this.galleryEl,
      this.settingsEl,
      this.toastsEl,
      this.debugEl,
      this.installEl,
      this.loadingEl,
    );
  }

  // ------------------------------------------------------------------ build

  private buildHud(): HTMLElement {
    const hud = el('div', 'hud');
    hud.hidden = true;

    const rank = el('div', 'hud-rank');
    this.rankNameEl = el('div', 'rank-name');
    this.rankMassEl = el('div', 'rank-mass num');
    const bar = el('div', 'rank-bar');
    this.rankBarEl = el('i');
    bar.append(this.rankBarEl);
    rank.append(this.rankNameEl, this.rankMassEl, bar);

    const alerts = el('div', 'hud-alerts');
    this.alertEl = el('div', 'big-alert');
    alerts.append(this.alertEl);

    const foot = el('div', 'hud-foot');
    this.leaderEl = el('div', 'leader');
    this.warnEl = el('div', 'warn');
    foot.append(this.leaderEl, this.warnEl);

    this.holdEl = el('div', 'hold');
    const hb = el('div', 'hold-bar');
    this.holdBarEl = el('i');
    hb.append(this.holdBarEl);
    this.holdEl.append(el('div', 'hold-label', t('hud.hold')), hb);

    hud.append(rank, this.mapSlot, alerts, foot, this.holdEl);
    return hud;
  }

  private buildMenu(): HTMLElement {
    const p = el('div', 'panel');
    const mark = el('div', 'wordmark');
    mark.innerHTML = `<span class="a"></span><span class="b"></span>`;
    const tag = el('div', 'tagline');

    const play = el('button', 'btn primary');
    play.onclick = () => this.hooks.onPlay(this.seedValue());

    // Hidden unless a server was configured at build time or on the URL. An
    // online button that cannot connect is worse than no online button.
    const online = el('button', 'btn online');
    online.hidden = true;
    online.onclick = () => this.hooks.onPlayOnline();

    const seedRow = el('div', 'seed');
    const seedInput = el('input');
    seedInput.type = 'text';
    seedInput.inputMode = 'numeric';
    seedInput.placeholder = '';
    seedInput.id = 'seedInput';
    const dailyBtn = el('button', 'btn ghost');
    dailyBtn.onclick = () => {
      seedInput.value = String(dailySeed());
    };
    seedRow.append(el('span', '', ''), seedInput, dailyBtn);

    const row = el('div', 'row');
    const badges = el('button', 'btn ghost');
    badges.onclick = () => this.show('gallery');
    const settings = el('button', 'btn ghost');
    settings.onclick = () => this.show('settings');
    row.append(badges, settings);

    const runs = el('div', 'seed');

    p.append(mark, tag, online, play, seedRow, row, runs);
    p.dataset.role = 'menu';

    // Labels are applied by applyLabels(); stash the nodes it writes to.
    (p as never as Record<string, unknown>).__refs = {
      a: mark.querySelector('.a'),
      b: mark.querySelector('.b'),
      tag,
      play,
      online,
      badges,
      settings,
      seedLabel: seedRow.firstElementChild,
      dailyBtn,
      runs,
    };
    return p;
  }

  private buildGallery(): HTMLElement {
    const p = el('div', 'panel');
    p.hidden = true;
    const title = el('div', 'over-rank');
    const grid = el('div', 'badge-grid');
    const back = el('button', 'btn ghost');
    back.onclick = () => this.show('menu');
    p.append(title, grid, back);
    (p as never as Record<string, unknown>).__refs = { title, grid, back };
    return p;
  }

  private buildSettings(): HTMLElement {
    const p = el('div', 'panel');
    p.hidden = true;
    const title = el('div', 'over-rank');
    const box = el('div', 'settings');

    const s = load();
    const mk = (key: keyof Save, labelKey: string): HTMLElement => {
      const row = el('div', 'setting');
      const label = el('span', '', t(labelKey));
      label.dataset.key = labelKey;
      const sw = el('button', 'switch');
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(Boolean(s[key])));
      sw.onclick = () => {
        const next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(next));
        this.hooks.onSetting(key, next);
      };
      row.append(label, sw);
      return row;
    };

    box.append(
      mk('sound', 'set.sound'),
      mk('pointerSteer', 'set.pointer'),
      mk('calm', 'set.calm'),
      mk('debug', 'set.debug'),
      mk('harsh', 'set.harsh'),
    );

    const back = el('button', 'btn ghost');
    back.onclick = () => this.show('menu');
    p.append(title, box, back);
    (p as never as Record<string, unknown>).__refs = { title, back };
    return p;
  }

  private buildInstall(): HTMLElement {
    const box = el('div', 'install');
    box.hidden = true;
    const label = el('span');
    const yes = el('button', 'btn ghost');
    const no = el('button', 'btn ghost');
    yes.onclick = () => {
      box.hidden = true;
      this.hooks.onInstall();
    };
    no.onclick = () => {
      box.hidden = true;
      save({ installPromptDismissed: true });
    };
    box.append(label, yes, no);
    (box as never as Record<string, unknown>).__refs = { label, yes, no };
    return box;
  }

  private seedValue(): number | null {
    const input = document.getElementById('seedInput') as HTMLInputElement | null;
    if (input === null) return null;
    const v = input.value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : hashString(v);
  }

  // ----------------------------------------------------------------- screens

  private onlineLabel = '';

  /**
   * Reveal the online entry point. Called once, at boot, only when a server
   * URL exists.
   */
  offerOnline(): void {
    const m = (this.menuEl as never as Record<string, Record<string, HTMLElement>>).__refs;
    this.onlineLabel = t('menu.online');
    m.online.textContent = this.onlineLabel;
    (m.online as HTMLButtonElement).hidden = false;
  }

  show(which: 'loading' | 'menu' | 'game' | 'over' | 'gallery' | 'settings'): void {
    this.loadingEl.hidden = which !== 'loading';
    this.menuEl.hidden = which !== 'menu';
    this.hudEl.hidden = which !== 'game';
    this.overEl.hidden = which !== 'over';
    this.galleryEl.hidden = which !== 'gallery';
    this.settingsEl.hidden = which !== 'settings';
    if (which === 'gallery') this.renderGallery();
    if (which === 'menu') this.applyLabels();
  }

  offerInstall(): void {
    const s = load();
    if (s.installPromptDismissed || s.runs < 3) return;
    this.installEl.hidden = false;
    this.applyLabels();
  }

  hideInstall(): void {
    this.installEl.hidden = true;
  }

  // --------------------------------------------------------------------- hud

  updateHud(m: HudModel): void {
    const def = RANKS[clamp(m.rank, 1, RANKS.length) - 1];
    const name = t(`rank.${def.key}`);
    if (this.rankNameEl.textContent !== name) {
      this.rankNameEl.textContent = name;
      this.rankNameEl.dataset.rank = String(m.rank);
    }
    this.rankMassEl.textContent = `${Math.round(m.mass).toLocaleString()} ${t('hud.mass')}`;
    this.rankBarEl.style.width = `${(m.rankProgress * 100).toFixed(1)}%`;

    if (m.rank !== this.lastRankShown) {
      if (this.lastRankShown > 0 && m.rank > this.lastRankShown) this.flashAlert(name);
      this.lastRankShown = m.rank;
    }

    let html = '';
    for (const l of m.leaders) {
      const cls = l.me ? 'me' : l.nina ? 'nina' : '';
      html += `<div class="${cls}"><b>${escapeHtml(l.name)}</b> ${Math.round(l.mass)}</div>`;
    }
    if (this.leaderEl.innerHTML !== html) this.leaderEl.innerHTML = html;

    this.warnEl.classList.toggle('on', m.danger);
    if (this.warnEl.textContent !== t('hud.warnField')) this.warnEl.textContent = t('hud.warnField');

    this.holdEl.classList.toggle('on', m.showHold);
    this.holdBarEl.style.width = `${(m.winProgress * 100).toFixed(1)}%`;
  }

  flashAlert(text: string): void {
    this.alertEl.textContent = text;
    this.alertEl.classList.remove('show');
    void this.alertEl.offsetWidth; // restart the animation
    this.alertEl.classList.add('show');
  }

  setDebug(text: string | null): void {
    this.debugEl.hidden = text === null;
    if (text !== null) this.debugEl.textContent = text;
  }

  /**
   * A plain line of text over the menu - connecting, or why it did not work.
   * Not a toast: those are badge-shaped and disappear on their own.
   */
  notice(text: string | null): void {
    const m = (this.menuEl as never as Record<string, Record<string, HTMLElement>>).__refs;
    const n = m.online as HTMLButtonElement;
    if (text === null) {
      n.disabled = false;
      n.textContent = this.onlineLabel;
      return;
    }
    n.disabled = true;
    n.textContent = text;
  }

  // ------------------------------------------------------------------ toasts

  /** Stacks to 3 visible with the rest queued. Never pauses the game. */
  toast(id: BadgeId): void {
    this.toastQueue.push(id);
    this.pumpToasts();
  }

  private pumpToasts(): void {
    while (this.toastLive < 3 && this.toastQueue.length > 0) {
      const id = this.toastQueue.shift()!;
      this.toastLive++;
      const node = el('div', 'toast');
      node.innerHTML =
        `<span class="ico">${badgeIcon(id)}</span>` +
        `<span><span class="nm">${escapeHtml(t(`badge.${id}`))}</span>` +
        `<span class="ds">${escapeHtml(t(`badge.${id}.d`))}</span></span>`;
      this.toastsEl.append(node);
      window.setTimeout(() => {
        node.classList.add('out');
        window.setTimeout(() => {
          node.remove();
          this.toastLive--;
          this.pumpToasts();
        }, 320);
      }, 2600);
    }
  }

  // --------------------------------------------------------------- game over

  showGameOver(m: OverModel): void {
    const def = RANKS[clamp(m.rank, 1, RANKS.length) - 1];
    const stat = (k: string, v: string): string =>
      `<div class="stat"><u>${escapeHtml(t(k))}</u><b class="num">${escapeHtml(v)}</b></div>`;

    const mins = Math.floor(m.time / 60);
    const secs = Math.floor(m.time % 60);

    let badgesHtml = '';
    if (m.newBadges.length > 0) {
      badgesHtml =
        `<div class="over-sub">${escapeHtml(t('over.newBadges'))}</div><div class="badge-row">` +
        m.newBadges
          .map(
            (b) =>
              `<div class="badge got"><span class="ico">${badgeIcon(b)}</span>` +
              `<span><span class="nm">${escapeHtml(t(`badge.${b}`))}</span></span></div>`,
          )
          .join('') +
        '</div>';
    }

    this.overEl.innerHTML =
      `<div class="over-rank">${escapeHtml(m.won ? t('over.win') : t('over.title'))}</div>` +
      `<div class="over-sub">${escapeHtml(m.won ? t('over.winSub') : t('over.sub'))}</div>` +
      `<div class="stats">` +
      stat('over.rank', t(`rank.${def.key}`)) +
      stat('over.peak', String(Math.round(m.peakMass))) +
      stat('over.time', `${mins}:${String(secs).padStart(2, '0')}`) +
      stat('over.shreds', String(m.shreds)) +
      stat('over.cities', String(m.cities)) +
      stat('over.eaten', String(m.eaten)) +
      `</div>` +
      badgesHtml +
      `<div class="row">` +
      `<button class="btn primary" data-a="again">${escapeHtml(t('over.again'))}</button>` +
      (m.canClip ? `<button class="btn ghost" data-a="clip">${escapeHtml(t('over.clip'))}</button>` : '') +
      `<button class="btn ghost" data-a="share">${escapeHtml(t('over.share'))}</button>` +
      `<button class="btn ghost" data-a="menu">${escapeHtml(t('over.menu'))}</button>` +
      `</div>`;

    this.overEl.querySelectorAll<HTMLButtonElement>('button[data-a]').forEach((b) => {
      b.onclick = () => {
        switch (b.dataset.a) {
          case 'again': this.hooks.onPlay(null); break;
          case 'menu': this.hooks.onMenu(); break;
          case 'clip': this.hooks.onSaveClip(); break;
          case 'share': this.hooks.onShare(); break;
        }
      };
    });

    this.show('over');
  }

  // ---------------------------------------------------------------- gallery

  private renderGallery(): void {
    const refs = (this.galleryEl as never as Record<string, Record<string, HTMLElement>>).__refs;
    const have = new Set(load().badges);
    refs.title.textContent = `${t('menu.badges')} ${have.size}/${BADGES.length}`;
    refs.grid.innerHTML = BADGES.map((b) => {
      const got = have.has(b.id);
      const hidden = b.secret === true && !got;
      const icon = got ? badgeIcon(b.id) : lockedIcon();
      const name = hidden ? '???' : t(`badge.${b.id}`);
      const desc = hidden ? '' : t(`badge.${b.id}.d`);
      return (
        `<div class="badge${got ? ' got' : ''}"><span class="ico">${icon}</span>` +
        `<span><span class="nm">${escapeHtml(name)}</span>` +
        `<span class="ds">${escapeHtml(desc)}</span></span></div>`
      );
    }).join('');
    refs.back.textContent = t('menu.back');
  }

  // --------------------------------------------------------------- labels

  private applyLabels(): void {
    const m = (this.menuEl as never as Record<string, Record<string, HTMLElement>>).__refs;
    m.a.textContent = t('app.title.a');
    m.b.textContent = t('app.title.b');
    m.tag.textContent = t('app.tagline');
    m.play.textContent = t('menu.play');
    m.online.textContent = this.onlineLabel;
    m.badges.textContent = t('menu.badges');
    m.settings.textContent = t('menu.settings');
    m.seedLabel.textContent = t('menu.seed');
    m.dailyBtn.textContent = t('menu.daily');
    const s = load();
    m.runs.textContent = `${t('menu.runs')} ${s.runs}`;

    const g = (this.galleryEl as never as Record<string, Record<string, HTMLElement>>).__refs;
    g.back.textContent = t('menu.back');

    const st = (this.settingsEl as never as Record<string, Record<string, HTMLElement>>).__refs;
    st.title.textContent = t('menu.settings');
    st.back.textContent = t('menu.back');
    this.settingsEl.querySelectorAll<HTMLElement>('[data-key]').forEach((n) => {
      n.textContent = t(n.dataset.key!);
    });

    const i = (this.installEl as never as Record<string, Record<string, HTMLElement>>).__refs;
    i.label.textContent = t('pwa.install');
    i.yes.textContent = t('pwa.yes');
    i.no.textContent = t('pwa.no');

    this.loadingEl.lastElementChild!.textContent = t('loading');
  }
}

export function dailySeed(): number {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
