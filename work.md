# RunHub MY — Future Work

Phase 1 and 2 (T1–T9) are done. See `docs/BUILD_PLAN.md` §13 for the build log.
This file tracks what is left. Order = priority.

## Next

### 1. Ads module (AC-16, T10a)
- Flag-gated: `ADS_ENABLED=false` by default (already in `.env.example`, not yet read anywhere).
- Exactly one non-blocking unit per page load: a labelled "Sponsored" card in the grid, or a slim footer strip.
- Never: popup, interstitial, autoplay, sticky overlay.
- Isolated module (`ads.mjs` + one hook in `public/index.html`); zero ad markup when off.
- Test TC-ADS-01: flag on → exactly 1 unit; flag off → 0.

### 2. CheckpointSpot scraper (T10b)
- Blocked: Cloudflare 403. Needs Playwright + persistent profile + credentials in `.env`
  (`CHECKPOINTSPOT_EMAIL` / `CHECKPOINTSPOT_PASSWORD`).
- Opt-in via env flag, disabled by default. Never log credentials.
- Adds the major marathons (SCORE, SELMAR, PBIM) that the public portals miss.
- Unknown: page structure behind the challenge. Probe first, then save fixtures.

### 3. Social crawl `social.mjs` (T10c)
- Meta API is not viable (BUILD_PLAN §9). Login-based Playwright crawl of named organiser pages only.
- Blocked: needs a target list + a dedicated account. Disabled by default.
- Lowest priority.

## Coverage ideas (biggest lever for "all events in Malaysia")

- Lesgo.My is now the backbone (it lists every portal). Add other directories the same way: `racingschedule.com/races/my`, `ahotu.com` (Cloudflare), `emas.etranspay.com` (Cloudflare).
- Generic `jsonld` source type: give `baseUrl` + list pages + a link regex, read schema.org `Event` JSON-LD. Lets a new portal be added from `sources.json` alone.
- Re-enable JomLari2U when its detail pages stop returning 500.
- Lesgo `race_result` / `running_club` taxonomies hold organiser + club pages that could seed FB/IG targets.

## Data quality

- 17/134 events have no state (virtual runs, `MyCity RUN`, `STAKAN National Day Night Run`). Consider a "Virtual" flag instead of a null state.
- Dedupe: only 5 multi-source merges. Review near-miss titles across portals and tune `normaliseTitle`.
- BiiB, HeyJom and Ticket2U give no entitlements or prices for most events. Fetch detail pages where they exist.
- Ticket2U: only page 1 (18 of ~2,925 sport events). Add paging, filter to running.
- Scrapers fetch details serially (~3 min per sync). Add bounded concurrency (4–6) per portal.
- Howei/JomRun images may be referrer-checked (BUILD_PLAN §10). Verify drawer images load in the browser.

## UI

- Year filter hard-codes 2026/2027. Derive from data.
- Sort control (date / price / distance).
- Calendar / month view.
- ICS export for My Season.
- Mobile pass on the drawer and filters.
- Accessibility: focus trap in drawer and modal, return focus on close.

## Ops

- Sync lock so the scheduled task and the "Sync now" button cannot run at once (SQLite `database is locked`).
- Alert when a portal returns 0 events for several days running (parser drift).
- DB backup before `pruneStale` on large deletes.
- Auto-refresh fixtures (`tests/fixtures/`) with a script, then `npm run verify`.

## Deployment (itsmini)

- Deployed under pm2 as `runhub`, bound to the Tailscale IP only.
- Daily sync via cron on itsmini (the Windows task covers the dev box only).
- See "Deploy" notes in `README.md`.
