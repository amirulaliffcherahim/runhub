# RunHub MY

Local, single-user app that aggregates Malaysian running events from multiple portals, deduplicates them,
and shows entitlements (distances, prices, tee/medal, race-pack). Non-profit: always deep-link to
the official ticket URL(s).

## How to work in this repo

1. **Read `docs/BUILD_PLAN.md` first** — it is the source of truth for architecture, data model,
   acceptance criteria (AC-01..AC-16), and the test plan. Every change must trace to an AC or a
   task derived from it.
2. Stack: Node.js `node:sqlite` + plain `node:http` server. No framework. Playwright only for
   login-gated/Cloudflare sources (CheckpointSpot, FB/IG — opt-in, disabled by default).
3. Sources (public, verified working): Howei (RSS feed), RaceXasia (embedded PHP dump), JomRun,
   BiiB, HeyJom (Inertia `data-page` JSON), Ticket2U.
4. Credentials live only in `.env` (gitignored). Never log them.
5. Tests: `node --test`, real SQLite, network mocked via `tests/fixtures/`. Run them before
   claiming done.
6. Ads are a deferred, flag-gated module (`ADS_ENABLED=false`). Do not add ads to the core build.

## Run it

```bash
npm run sync     # fetch every portal, dedupe, persist (~3 min)
npm start        # http://127.0.0.1:3300
npm test         # 103 tests, real Postgres + real server
npm run verify   # fixture + live-DB sanity check
npm run inspect  # DB stats
```

Needs `DATABASE_URL` in `.env` (copy `.env.example`). A daily task `RunHub-DailySync` runs
`run-sync.cmd` at 07:00 on the dev box; on itsmini a cron entry does the same.

## Key files

- `docs/BUILD_PLAN.md` — build plan, ACs, design, test plan (read this)
- `db.mjs` — Postgres schema, migrations, query helpers, archive rules
- `sync.mjs` — daily orchestrator (injectable scrapers, quality gate, archive)
- `scrapers/*.mjs` — per-portal extractors, `normalizer.mjs` (dedupe),
  `states.mjs` (state canonicalisation + running filter), `status.mjs` (sold-out/closed),
  `html.mjs` (text helpers), `ai.mjs` (BitNet crawler), `config.mjs` + `pool.mjs`
- `server.mjs` — `/api/*` + static (binds 127.0.0.1 or `HOST`)
- `public/index.html` — UI (self-contained, no CDN)
- `run-sync.cmd` — Windows Task Scheduler wrapper

## Adding a source

Edit `sources.json`. Set `"enabled": false` to switch a portal off. A new portal needs a scraper:
add `scrapers/<name>.mjs` exporting `scrape<Name>(cfg)` returning `{ events, errors }`, register its
`type` in `REGISTRY` in `sync.mjs`, then add its entry (with `baseUrl`) to `sources.json`.

## Storage and archive

Events live in Postgres. Nothing is deleted:

- An event whose date passed more than `ARCHIVE_GRACE_DAYS` (default 7) ago is **archived**.
- An event that vanished from every portal that listed it is archived too (`delisted`).
- Archived rows keep their categories, entitlements and sources. `/api/events` hides them,
  `/api/events?archived=1` returns them, and the UI has a "show archive" toggle.
- Sold-out and closed events are **never** hidden: only the date archives an event. Use the
  Availability filter (Open / Sold out / Reg. closed) to find them.

## Known limits

- CheckpointSpot is still behind Cloudflare (needs Playwright + credentials in `.env`).
- `social.mjs` (FB/IG) is not implemented — Meta's API needs app review (see BUILD_PLAN §9).
- Ads are not built; they are a deferred, flag-gated module (BUILD_PLAN §8).
- The AI crawler (BitNet) is a parser, not an authority: it only writes validated events, and
  its distances/states are occasionally incomplete. It needs `llama-server` running on itsmini.

## Deploy (itsmini)

- Path `~/code/runhub`, pm2 app `runhub` via `ecosystem.config.cjs`, bound to the Tailscale IP: `http://100.109.19.100:3300`.
- **Do not start it with `pm2 start server.mjs`.** pm2's wrapper becomes `process.argv[1]`, so the `isMain`
  guard fails and nothing listens. The ecosystem file runs `node server.mjs` directly (`interpreter: "none"`).
- Postgres: role+db `runhub` on the local server (port 5433); `DATABASE_URL` only in `.env` (0600).
- Daily sync: cron `0 7 * * *` (host is Asia/Kuala_Lumpur) -> `logs/sync.log`.
- ufw: `allow in on tailscale0 to any port 3300`.
- Update: `git archive HEAD | ssh itsmini 'tar -xf - -C ~/code/runhub' && ssh itsmini 'pm2 restart runhub'`.
  Data lives in Postgres, so the archive never touches it. `.env` is not in git either.
