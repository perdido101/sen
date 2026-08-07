/**
 * Badge icons, drawn as inline SVG.
 *
 * Flat vector, single subject, --crown on transparent, thick outline, no text -
 * the same brief the generated icons would have followed, executed in code so
 * the gallery works offline and scales to any density for free.
 */

import type { BadgeId } from '../game/badges.ts';

const CROWN = '#FFC23C';

function svg(body: string, stroke = CROWN): string {
  return (
    `<svg viewBox="0 0 32 32" fill="none" stroke="${stroke}" stroke-width="2.4" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

const spiral = (turns: number) => {
  let d = '';
  const steps = 26;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * Math.PI * 2 * turns;
    const r = 2 + t * 11;
    const x = 16 + Math.cos(a) * r;
    const y = 16 + Math.sin(a) * r;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `<path d="${d}"/>`;
};

const ICONS: Record<BadgeId, string> = {
  touchdown: svg(`${spiral(1.5)}<path d="M4 27h24"/>`),
  landfall: svg(`${spiral(2)}<path d="M2 27h12l4-4h12"/>`),
  namedStorm: svg(`${spiral(2.5)}<circle cx="16" cy="16" r="2.4"/>`),
  basinWide: svg(`<ellipse cx="16" cy="16" rx="13" ry="7"/>${spiral(1.5)}`),
  superElNino: svg(`<circle cx="16" cy="16" r="12"/>${spiral(2.5)}<path d="M16 2v3M16 27v3M2 16h3M27 16h3"/>`),
  perfectStorm: svg(`${spiral(2.5)}<path d="M6 6l3 3M26 6l-3 3M6 26l3-3M26 26l-3-3"/>`),

  warmPool: svg(`<circle cx="16" cy="16" r="9"/><circle cx="16" cy="16" r="4"/><path d="M4 16h-2M30 16h-2M16 4V2M16 30v-2"/>`),
  crossing: svg(`<path d="M3 20c4-5 8 5 13 0s8-5 13 0"/><path d="M9 12l7-6 7 6"/>`),
  blueWater: svg(`<path d="M3 12c4-4 8 4 13 0s9-4 13 0M3 20c4-4 8 4 13 0s9-4 13 0"/>`),
  boilingPoint: svg(`<path d="M3 24c4-4 9 4 13 0s9-4 13 0"/><path d="M11 16c0-4 4-4 4-8M17 14c0-3 4-3 4-6"/>`),
  armada: svg(`<path d="M5 21h22l-3 5H8z"/><path d="M16 5v13M16 8l7 3-7 3"/>`),
  laNina: svg(`${spiral(2.2)}<path d="M16 2v4M16 26v4"/>`, '#7FD0FF'),

  cattleDrive: svg(`<ellipse cx="16" cy="19" rx="8" ry="6"/><path d="M9 12c-2-3 0-5 2-3M23 12c2-3 0-5-2-3"/><circle cx="13" cy="19" r="1.4"/><circle cx="19" cy="20" r="1.4"/>`),
  deforestation: svg(`<path d="M16 4l7 11h-4l4 8H9l4-8H9z"/><path d="M16 23v6"/>`),
  metropolis: svg(`<path d="M5 28V13h6v15M13 28V6h6v22M21 28V16h6v12"/>`),
  grandTour: svg(`<circle cx="16" cy="16" r="12"/><path d="M4 16h24M16 4c4 5 4 19 0 24M16 4c-4 5-4 19 0 24"/>`),
  rushHour: svg(`<rect x="7" y="6" width="8" height="20" rx="2"/><rect x="19" y="12" width="8" height="16" rx="2"/>`),
  stormChaser: svg(`<rect x="5" y="11" width="22" height="14" rx="2"/><circle cx="16" cy="18" r="4"/><path d="M12 11l2-4h4l2 4"/>`),

  firstBlood: svg(`<path d="M16 3l4 10 10 3-10 3-4 10-4-10-10-3 10-3z"/>`),
  stormHunter: svg(`<circle cx="16" cy="16" r="10"/><path d="M16 2v6M16 24v6M2 16h6M24 16h6"/><circle cx="16" cy="16" r="2"/>`),
  apex: svg(`<path d="M4 26l12-20 12 20z"/><path d="M11 26l5-8 5 8"/>`),
  cleanKill: svg(`<path d="M6 16l7 7L26 8"/>`),
  ambush: svg(`<path d="M5 27V14h7v13M14 27V8h7v19"/><path d="M26 6l-6 6M26 12V6h-6"/>`),
  untouchable: svg(`<path d="M16 3l11 4v9c0 7-5 11-11 13-6-2-11-6-11-13V7z"/>`),

  circumnavigate: svg(`<circle cx="16" cy="16" r="11"/><path d="M27 13a11 11 0 0 1-22 6"/><path d="M24 9l3 4-4 2"/>`),
  coriolis: svg(`<path d="M2 16h28"/><path d="M10 9a6 6 0 1 1 0 0.1"/><path d="M22 23a6 6 0 1 0 0-0.1"/>`),
  polarExpress: svg(`<path d="M4 7h24M4 25h24"/><path d="M16 7v18"/><path d="M11 12l5-5 5 5M11 20l5 5 5-5"/>`),
  greenlandIsHuge: svg(`<path d="M12 3l9 3 5 9-3 12-9 3-7-6-2-12z"/><path d="M14 12l4 6-3 5"/>`),
  homecoming: svg(`<path d="M5 15L16 5l11 10"/><path d="M9 14v13h14V14"/><path d="M14 27v-7h4v7"/>`),

  threadingTheNeedle: svg(`<circle cx="7" cy="16" r="5"/><circle cx="25" cy="16" r="5"/><path d="M16 3v26"/>`),
  comeback: svg(`<path d="M4 24l7-7 5 5 12-13"/><path d="M22 9h6v6"/>`),
  speedrun: svg(`<path d="M18 3l-9 15h6l-2 11 9-15h-6z"/>`),
  pacifist: svg(`<circle cx="16" cy="16" r="12"/><path d="M16 4v24M6 10c6 4 14 4 20 0M6 22c6-4 14-4 20 0"/>`),

  runs10: svg(`<circle cx="16" cy="16" r="12"/><path d="M16 9v7l5 3"/>`),
  runs50: svg(`<circle cx="16" cy="16" r="12"/><path d="M16 9v7l5 3"/><path d="M4 6l3 3M28 6l-3 3"/>`),
  runs200: svg(`<circle cx="16" cy="16" r="12"/><path d="M16 9v7l5 3"/><path d="M16 2v3M16 27v3M2 16h3M27 16h3"/>`),
  installPwa: svg(`<rect x="9" y="3" width="14" height="26" rx="3"/><path d="M16 10v9M12 15l4 4 4-4"/>`),
  shareClip: svg(`<circle cx="24" cy="8" r="4"/><circle cx="8" cy="16" r="4"/><circle cx="24" cy="24" r="4"/><path d="M11 14l10-4M11 18l10 4"/>`),
  allBadges: svg(`<path d="M16 2l4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1z"/>`),
};

export function badgeIcon(id: BadgeId): string {
  return ICONS[id] ?? svg('<circle cx="16" cy="16" r="10"/>');
}

/** Locked badges show a flat silhouette instead of the real mark. */
export function lockedIcon(): string {
  return svg('<rect x="8" y="14" width="16" height="13" rx="2"/><path d="M12 14v-4a4 4 0 0 1 8 0v4"/>', '#9AA6B8');
}
