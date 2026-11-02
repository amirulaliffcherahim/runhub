# RunHub MY — Malaysia running-event aggregator

Local, single-user app. Aggregates Malaysian running events from multiple portals, dedupes them,
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

## Key files

- `docs/BUILD_PLAN.md` — build plan, ACs, design, test plan (read this)
- `db.mjs` — schema + query helpers
- `sync.mjs` — daily orchestrator
- `scrapers/*.mjs` — per-portal extractors + `normalizer.mjs` (dedupe)
- `server.mjs` — `/api/*` + static
- `public/index.html` — UI
- `run-sync.cmd` — Windows Task Scheduler wrapper
