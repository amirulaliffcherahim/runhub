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
npm test         # 63 tests, real SQLite + real server
npm run verify   # fixture + live-DB sanity check
npm run inspect  # DB stats
```

A daily task `RunHub-DailySync` runs `run-sync.cmd` at 07:00 and logs to `logs/sync.log`.

## Key files

- `docs/BUILD_PLAN.md` — build plan, ACs, design, test plan (read this)
- `db.mjs` — schema, migrations, query helpers, `pruneStale`
- `sync.mjs` — daily orchestrator (injectable scrapers, quality gate, prune)
- `scrapers/*.mjs` — per-portal extractors, `normalizer.mjs` (dedupe),
  `states.mjs` (state canonicalisation + running filter), `html.mjs` (text helpers)
- `server.mjs` — `/api/*` + static (binds 127.0.0.1)
- `public/index.html` — UI (self-contained, no CDN)
- `run-sync.cmd` — Windows Task Scheduler wrapper

## Known limits

- CheckpointSpot is still behind Cloudflare (needs Playwright + credentials in `.env`).
- `social.mjs` (FB/IG) is not implemented — Meta's API needs app review (see BUILD_PLAN §9).
- Ads are not built; they are a deferred, flag-gated module (BUILD_PLAN §8).

## Deploy (itsmini)

- Path `~/code/runhub`, pm2 app `runhub` via `ecosystem.config.cjs`, bound to the Tailscale IP: `http://100.109.19.100:3300`.
- **Do not start it with `pm2 start server.mjs`.** pm2's wrapper becomes `process.argv[1]`, so the `isMain`
  guard fails and nothing listens. The ecosystem file runs `node server.mjs` directly (`interpreter: "none"`).
- Daily sync: cron `0 7 * * *` (host is Asia/Kuala_Lumpur) -> `logs/sync.log`.
- ufw: `allow in on tailscale0 to any port 3300`.
- Update: `git archive HEAD | ssh itsmini 'tar -xf - -C ~/code/runhub' && ssh itsmini 'pm2 restart runhub'`.
  The DB lives in `~/code/runhub/data/` and is not touched by the archive.
