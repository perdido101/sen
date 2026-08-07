/**
 * Where the live-instance server is, if anywhere.
 *
 * Two sources, in order: `?server=` on the URL, so a test or a friend with a
 * private box can point at one without a rebuild, and `SEN_SERVER` baked in at
 * build time for the deployed game. Empty means single player only, and that
 * is the default - the online entry point is hidden rather than shown broken.
 */

declare const __SEN_SERVER__: string;

export function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  const raw = (q ?? (typeof __SEN_SERVER__ === 'string' ? __SEN_SERVER__ : '')).trim();
  if (raw === '') return '';

  // A page on https may not open a plain ws socket; the browser blocks it and
  // the failure surfaces as a mystery. Say so in a way somebody can act on.
  if (location.protocol === 'https:' && raw.startsWith('ws://')) {
    console.warn(`[sen] ignoring insecure server URL ${raw} on an https page; it must be wss://`);
    return '';
  }
  return raw.replace(/\/+$/, '');
}
