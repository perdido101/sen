/**
 * Phase 17's public dashboard.
 *
 * Revenue in, buybacks executed, treasury holdings, transaction links, and the
 * next scheduled execution with a countdown. This is simultaneously the trust
 * artifact and the marketing artifact - it is the thing people screenshot - so
 * it is a route on the game site rather than a separate property, and it shows
 * the awkward numbers as plainly as the good ones.
 *
 * The copy here is held to the same language discipline as everything else:
 * the token grants no revenue share, no governance, no claim on anything, and
 * no promise of value. That is stated on the page, not buried in a footer.
 */

import { revenueSince, spentCents, unspentNetCents, adConfig } from './revenue.ts';
import { BUYBACK_PERCENT, CLUSTER, publicState, tokenConfig } from './token.ts';

function cents(v: number): string {
  return `$${(v / 100).toFixed(2)}`;
}

function explorer(sig: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=${CLUSTER}`;
}

export function dashboardJson(): Record<string, unknown> {
  return {
    ...publicState(),
    revenue: {
      unspentCents: unspentNetCents(),
      spentCents: spentCents(),
      last30Days: revenueSince(30),
      network: adConfig.network,
      adsEnabled: adConfig.enabled,
    },
  };
}

export function dashboardHtml(): string {
  const s = publicState();
  const buybacks = s.buybacks as Array<Record<string, unknown>>;
  const next = Number(s.secondsUntilNext);
  const days = Math.floor(next / 86400);
  const hours = Math.floor((next % 86400) / 3600);

  const rows =
    buybacks.length === 0
      ? `<tr><td colspan="5" class="empty">No buyback has executed yet. The first one runs on schedule, whether or not anyone is watching.</td></tr>`
      : buybacks
          .slice()
          .reverse()
          .map((b) => {
            const sig = b.signature as string | null;
            const status = String(b.status);
            return `<tr>
      <td>#${String(b.id)}</td>
      <td>${new Date(Number(b.at)).toISOString().replace('T', ' ').slice(0, 16)}</td>
      <td class="num">${cents(Number(b.revenueCents))}</td>
      <td class="num">${cents(Number(b.spentCents))}</td>
      <td class="${status === 'executed' ? 'ok' : 'skip'}">${
        sig === null ? status : `<a href="${explorer(sig)}" target="_blank" rel="noopener">${status}</a>`
      }${b.note === undefined ? '' : `<span class="note">${String(b.note)}</span>`}</td>
    </tr>`;
          })
          .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Super El Niño — Treasury</title>
<style>
  :root{--deep:#0A1420;--cool:#2C5F8A;--warm:#C9432B;--storm:#9AA6B8;--lit:#E4EBF2;--crown:#FFC23C;--chase:#31E0C0}
  *{box-sizing:border-box}
  body{margin:0;background:var(--deep);color:var(--lit);font:16px/1.6 Inter,system-ui,sans-serif;padding:32px 20px 80px}
  .wrap{max-width:860px;margin:0 auto}
  h1{font:800 clamp(28px,6vw,46px)/1 'Fira Sans Condensed','Arial Narrow',sans-serif;text-transform:uppercase;margin:0 0 4px}
  h1 span{color:var(--crown)}
  h2{font:800 20px/1.2 'Fira Sans Condensed','Arial Narrow',sans-serif;text-transform:uppercase;margin:36px 0 12px;color:var(--storm)}
  .sub{color:var(--storm);margin:0 0 28px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
  .card{background:rgba(154,166,184,.08);border-radius:8px;padding:14px}
  .card u{display:block;text-decoration:none;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--storm)}
  .card b{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
  .card.next b{color:var(--crown)}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px}
  th{text-align:left;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--storm);padding:8px 10px;border-bottom:1px solid rgba(154,166,184,.2)}
  td{padding:10px;border-bottom:1px solid rgba(154,166,184,.1);vertical-align:top}
  td.num{font-variant-numeric:tabular-nums}
  .ok{color:var(--chase)} .skip{color:var(--storm)} .empty{color:var(--storm);text-align:center;padding:26px}
  .note{display:block;font-size:12px;color:var(--storm)}
  a{color:var(--chase)}
  .terms{background:rgba(201,67,43,.1);border:1px solid rgba(201,67,43,.4);border-radius:8px;padding:16px 18px;margin-top:32px}
  .terms h2{margin-top:0;color:var(--warm)}
  .terms li{margin:6px 0}
  code{background:rgba(154,166,184,.12);padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
  .rule{font-size:14px;color:var(--storm);margin-top:6px}
</style></head><body><div class="wrap">

<h1>Super <span>El Niño</span> — Treasury</h1>
<p class="sub">Every figure on this page is generated from the ledger. Nothing here is entered by hand.</p>

<div class="grid">
  <div class="card"><u>Cluster</u><b>${String(s.cluster)}</b></div>
  <div class="card"><u>Buyback share</u><b>${BUYBACK_PERCENT}%</b></div>
  <div class="card"><u>Revenue unspent</u><b>${cents(Number(s.revenueUnspentCents))}</b></div>
  <div class="card"><u>Spent on buybacks</u><b>${cents(Number(s.revenueSpentCents))}</b></div>
  <div class="card next"><u>Next execution</u><b>${days}d ${hours}h</b></div>
  <div class="card"><u>Executions</u><b>${buybacks.length}</b></div>
</div>

<h2>The rule</h2>
<p class="rule">
  <strong>${BUYBACK_PERCENT}% of net ad revenue, every ${Number(s.buybackIntervalHours) / 24} days, with no human discretion.</strong>
  The percentage and the cadence are constants in the source and were published
  before the first execution. The schedule advances by exactly one interval per
  run, so a late or failed execution cannot drift the cadence or bunch two
  together. There is no manual trigger.
</p>

<h2>Addresses</h2>
<p>Treasury: <code>${(s.treasury as string) ?? 'not configured'}</code><br>
Mint: <code>${(s.mint as string) ?? 'not configured'}</code></p>

<h2>Executions</h2>
<table>
  <thead><tr><th>#</th><th>Executed</th><th>Net revenue</th><th>Spent</th><th>Status</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<div class="terms">
  <h2>What this token is not</h2>
  <ul>
    <li>It grants <strong>no revenue share</strong>.</li>
    <li>It grants <strong>no governance</strong> rights.</li>
    <li>It grants <strong>no claim</strong> on the treasury or on anything else.</li>
    <li>It carries <strong>no promise of value</strong>, and none should be inferred.</li>
    <li>It is on <strong>${String(s.cluster)}</strong>. It is not tradeable and not purchasable.</li>
    <li>It touches <strong>nothing inside the game</strong>. No token-gated play, ranks, or matchmaking — ever.</li>
  </ul>
  <p class="rule">Mint authority is retained solely for scheduled airdrops, and that is stated here rather than discovered later.</p>
</div>

</div></body></html>`;
}

export function treasuryAddress(): string {
  return tokenConfig.treasury;
}
