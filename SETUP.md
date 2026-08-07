# What you need for everything to be functional

Everything in this repository runs today with no accounts, no keys and no
external services. Single player is complete offline; the server, matchmaking,
anti-cheat, replay validation, collusion detection, the ad plumbing, the token
and the airdrop epochs all run locally against file-backed storage and stubbed
services.

What follows is the list of real-world things that have to exist before each
of those stops being local. They are ordered so that each one is useful on its
own — you can stop after any number of them and everything below stays off
without breaking anything above it.

For each: what to get, where to put it, and **what is broken until you do**.

---

## 1. A host for the game itself

**Status: already done.** GitHub Pages, published by
`.github/workflows/deploy.yml`, live at
<https://perdido101.github.io/sen/>.

Nothing needed. If you move to a custom domain, set `SEN_BASE` to the subpath
(or leave it unset at a domain root) and point DNS at Pages.

**Broken until then:** nothing.

---

## 2. A server to host live instances

**What you need:** one Linux box or container with a public address, Node 22+,
and a port open. 2 vCPU / 4 GB is comfortable — measured, a full 60-player
instance costs 2.4ms of a 16.7ms tick budget and about 270 MB.

```bash
git clone <this repo> && cd sen && npm install
PORT=8787 SEN_REGION=eu-west npm run server
```

**Where it goes:** anywhere. Fly.io, Railway, Hetzner, a VPS. It is a single
Node process with no database dependency.

**Broken until then:** multiplayer. Single player is unaffected — it never
contacts a server.

---

## 3. TLS on that server

**What you need:** a hostname and a certificate. A browser on `https://` may
not open a `ws://` socket, so an HTTPS site needs `wss://`. The simplest path
is Caddy or nginx in front of the Node process, with the certificate from
Let's Encrypt.

**Where it goes:** in front of `PORT`. The server speaks plain WebSocket and
expects to be terminated by the proxy.

**Broken until then:** the deployed HTTPS game cannot connect to the server at
all. Local development over `http://127.0.0.1` is fine.

---

## 4. The client pointed at that server

**What you need:** the server's public URL, set at build time:

```
SEN_SERVER=wss://play.yourdomain.com
```

**Where it goes:** a repository variable named `SEN_SERVER` (Settings →
Secrets and variables → Actions → Variables). The deploy workflow already
passes it to the build; nothing else has to change. Locally, `?server=wss://…`
on the URL does the same thing without a rebuild.

**Broken until then:** the live game shows single player only. The multiplayer
entry point stays hidden rather than offering a button that fails.

---

## 5. More regions (optional)

**What you need:** the same server deployed two more times, with
`SEN_REGION=us-east` and `SEN_REGION=ap-southeast`, and their URLs listed for
the client to ping.

**Broken until then:** everyone plays on one region. Players far from it get a
worse experience; nothing malfunctions.

---

## 6. Durable storage (Postgres) — optional, recommended before launch

**What you need:** a Postgres database. Supabase's free tier is enough to
start.

```
SEN_DATABASE_URL=postgres://user:pass@host:5432/superelnino
```

**Where it goes:** the server's environment. The `Store` interface in
`apps/server/src/persistence.ts` is the seam; the file-backed implementation is
the default and a Postgres driver drops in behind it.

**Broken until then:** nothing functionally — accounts, runs, leaderboards and
airdrop points all work, written to `SEN_DATA_DIR` (default `.data/`). But that
directory is the database: it does not survive a container being replaced, and
it is not shared between two servers. Two regions cannot see one leaderboard
until this exists.

---

## 7. Redis — optional

**What you need:** a Redis instance.

```
SEN_REDIS_URL=redis://host:6379
```

**Broken until then:** nothing. Live leaderboards and rate limits are held in
process. With more than one server they are per-server rather than global.

---

## 8. Email or OAuth for account upgrades — optional

**What you need:** an OAuth app (Google or Discord) or a transactional email
sender for magic links.

**Where it goes:** the server, for the `/api/account` upgrade path.

**Broken until then:** play is anonymous by device id, which is the default and
always will be — no signup is ever on the path between opening the page and
playing. Players cannot carry history between two devices until this exists.

---

## 9. An ad network account

**What you need:** an approved publisher account with a web-game network. The
adapter supports **AdInPlay**, **Venatus** and **GameDistribution**. Mobile SDK
networks are the wrong shape for a browser game, and several of them restrict
incentivised rewards next to anything crypto-adjacent.

Approval usually requires a live site with real traffic, so this realistically
comes after launch.

```
SEN_AD_NETWORK=adinplay
SEN_AD_PUBLISHER_ID=<publisher id from their dashboard>
SEN_ADS_ENABLED=true
```

**Where it goes:** the server's environment.

**Broken until then:** the three rewarded placements (continue after death,
double airdrop points, extra daily attempt) resolve as "no ad available" and
grant nothing. No placement is ever required to play, and there is never an
interstitial. Revenue is zero, so the buyback has nothing to compute from.

---

## 10. The ad network's reporting credential

**What you need:** a shared secret you invent, plus a daily job that reads
settled revenue from the network's reporting API and posts it:

```
SEN_REPORT_SECRET=<a long random string>

curl -X POST "https://play.yourdomain.com/api/revenue?day=2026-08-06&netCents=4211&impressions=9033" \
     -H "x-sen-secret: $SEN_REPORT_SECRET"
```

**Broken until then:** the route returns 503 and the treasury dashboard shows
zero revenue. Impressions counted in-game are *not* used for money — only
settled figures from the network are, because that is the number that is
actually true.

---

## 11. A Solana devnet treasury and mint

**What you need:** nothing bought and nobody's permission — devnet SOL is free.
On a machine with internet access:

```bash
npm run token:init          # writes .secrets/treasury.json, creates the mint
```

It prints four values:

```
SEN_SOLANA_CLUSTER=devnet
SEN_TOKEN_MINT=<mint address>
SEN_TREASURY_PUBKEY=<treasury address>
SEN_TREASURY_KEYPAIR=/secure/path/treasury.json
```

**Where it goes:** the server's environment. **The keypair file is the
treasury.** It must live outside the repository and outside `SEN_DATA_DIR`
(which is world-readable ledger data), and it must be backed up somewhere that
is not the server.

**Broken until then:** `/treasury` renders with "not configured" in place of
the addresses and every scheduled buyback records `not-configured` instead of
executing. Nothing else is affected — the token touches nothing inside the
game, by design and permanently.

Optionally, a paid RPC endpoint (Helius, QuickNode) via `SEN_SOLANA_RPC`. The
public devnet RPC is rate-limited but sufficient for a weekly job.

---

## 12. Mainnet

**Not a configuration change, and deliberately not reachable by one.**
`SEN_SOLANA_CLUSTER` accepts `devnet` and `testnet` only, and `token:init`
refuses anything else.

Reaching mainnet requires, at minimum: legal advice in your jurisdiction on
whether the token is a security and whether the airdrop is a promotion; a
decision on the retained mint authority, which is currently retained for
scheduled airdrops and stated publicly; a real market for the buyback to
execute through, since on devnet it moves value into treasury custody and
records it rather than swapping; and an audit of the treasury key handling.
That checklist is the gate, not this file.

---

## 13. A CDN (optional)

**What you need:** any static CDN in front of the client build if traffic
grows. GitHub Pages is fine into the low thousands of players.

**Broken until then:** nothing.

---

## Summary table

| # | Thing | Cost | Blocks |
|---|---|---|---|
| 1 | Static host | done | — |
| 2 | Server box | ~$5–20/mo | multiplayer |
| 3 | TLS certificate | free | multiplayer from the HTTPS site |
| 4 | `SEN_SERVER` build variable | free | the multiplayer button appearing |
| 5 | Extra regions | ~$5–20/mo each | latency for distant players |
| 6 | Postgres | free tier | durability across restarts, shared leaderboards |
| 7 | Redis | free tier | shared rate limits and live boards |
| 8 | OAuth / email | free | carrying history between devices |
| 9 | Ad network account | free, needs traffic | all revenue, all rewarded placements |
| 10 | `SEN_REPORT_SECRET` + daily job | free | revenue figures, and so the buyback |
| 11 | Devnet treasury + mint | free | buyback execution, treasury dashboard addresses |
| 12 | Mainnet | legal review | out of scope by design |
| 13 | CDN | free tier | nothing until traffic grows |

Items 1–4 make the game fully playable online. Everything from 6 onward is
about durability, money and the token, and each is independently optional.

---

## Every environment variable in one place

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `8787` | server |
| `SEN_REGION` | `eu-west` | server, region labelling |
| `SEN_MAX_HUMANS` | `60` | instance capacity |
| `SEN_TARGET_STORMS` | `80` | bot backfill target |
| `SEN_DATA_DIR` | `.data` | file-backed store |
| `SEN_BASE` | unset | client build, Pages subpath |
| `SEN_SERVER` | unset | client build, server URL |
| `SEN_DATABASE_URL` | unset | Postgres store |
| `SEN_REDIS_URL` | unset | Redis leaderboards |
| `SEN_REPORT_SECRET` | unset (route closed) | `/api/revenue` |
| `SEN_AD_NETWORK` | `none` | ad adapter |
| `SEN_AD_PUBLISHER_ID` | empty | ad adapter |
| `SEN_ADS_ENABLED` | `false` | ad adapter |
| `SEN_SOLANA_CLUSTER` | `devnet` | token, buyback |
| `SEN_SOLANA_RPC` | public cluster URL | token, buyback |
| `SEN_TOKEN_MINT` | empty | token |
| `SEN_TREASURY_PUBKEY` | empty | token, dashboard |
| `SEN_TREASURY_KEYPAIR` | empty | buyback signing |
| `SEN_COLLUSION_THRESHOLD` | `7.5` | collusion scoring |
| `SEN_COLLUSION_ENFORCE` | `false` | collusion enforcement |
