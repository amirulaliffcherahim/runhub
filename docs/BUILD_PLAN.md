# RunHub MY — Build Plan, Acceptance Criteria, Design & Test Plan

> Handoff document. Target reader: an implementer agent (likely a smaller model) building this
> app from scratch. Read in full before writing any code. Every acceptance criterion (AC) has a
> testable, exact pass/fail condition. Every test case traces to an AC id.

## 1. Context & goal

A single-user, local web app ("RunHub MY") that aggregates Malaysian running events from multiple
ticketing portals and social/organizer sources, deduplicates the same race across sources, and
shows **what each event offers** (distances, price tiers, early-bird deadlines, event tee vs
finisher tee, medal, race-pack collection, route) so the owner never misses a good event.

- **Scope now:** one user (the owner). No auth, no multi-tenancy.
- **Revenue:** subtle ads only. Single-user product first; ads must never block or interrupt
  browsing (see §8). Ads are **not** part of the core build — they are a later, isolated module.
- **Legal posture:** non-profit aggregator. Always deep-link to the **official ticket URL** of the
  event (or multiple official URLs when the race sells on more than one portal). Never host the
  ticket-purchase flow. This is the correct posture — keep it.

The existing file `larihub_my_malaysian_race_calendar_apparel_hub.html` is a **static prototype**
with a hardcoded `RACES` array. The real app replaces that array with a SQLite database served by a
local Node server, plus daily scrapers that refresh it.

## 2. Architecture decision (read before coding)

**Stack:** Node.js (>= 22, uses `node:sqlite` — verified v25.9.0 is installed), no npm framework for
the server (plain `node:http`), Playwright only where a site needs a real browser (Cloudflare/login).

**Two crawl modes (the key decision):**

| Mode | When | Tool |
|---|---|---|
| **Plain HTTP fetch** | Public list/detail pages, RSS, sitemaps | global `fetch` with browser User-Agent |
| **Login-based crawl** | Sites behind Cloudflare challenge or login wall (CheckpointSpot, Facebook, Instagram) | Playwright + persistent profile + session cookies |

The user will supply account credentials for login-gated sources. Store them **only** in a local
`.env` (gitignored, chmod 0600). Never commit them, never log them.

### 2.1 Source access matrix (verified by probing on 2026-11-02)

| Source | Access | Extraction path | Yields |
|---|---|---|---|
| **Howei** | Public, 200 | `/events/feed` (RSS) → list; `/event_details/<slug>` HTML → detail | date, venue, organizer, `RM X - RM Y`, category, **T-shirt & Medal tab images**, entitlements table |
| **RaceXasia** | Public, 200 | `/events` HTML → list cards; `/event/<slug>` HTML → detail | **embedded PHP `stdClass` dump** in HTML comment gives structured `Event`, `KeyDate`, `Category` (name/distance/prices), `Entitlement` (finisher tee, medal, fee table images), `RacePack` |
| **JomRun** | Public, 200 | `/events` HTML → list; `/event/<slug>` → detail; `/sitemap.xml` for full list | cover image, date, time, venue, **"ABOUT" `<pre>` block has full entitlement text**, fee image, partner images |
| **BiiB** | Public, 200 | `/events` → `/events/<id>` | title, description, banner image, register URL |
| **HeyJom** | Public | `calendar.heyjom.com` → Inertia `data-page` attribute contains **JSON** `eventCalendars[]` | structured events (name, date, state, venue, status) |
| **Ticket2U** | Public, 200 | `/event/list/?cc=sport` → card links | sport/running events, links |
| **CheckpointSpot** | **403 Cloudflare "Just a moment…"** | needs Playwright + cookies (login or session) | major marathons (SCORE, SELMAR, PBIM) |
| **Facebook / Instagram** | **Official API needs app review** (PPCA/PPMA); hashtag search deprecated | see §9 | organizer announcements |

**Verdict (recorded):** official Meta API is **not** viable for a single-user personal tool
(requires business verification + app review). Use login-based Playwright crawl for FB/IG organizer
pages, or prefer organizer-owned portals. Do **not** block the build on Meta.

## 3. Project layout

```
runhub/
├── package.json            # type:module, deps: playwright (dev), no runtime deps
├── .env                    # credentials (gitignored, 0600)
├── .env.example            # placeholder, no real secrets
├── .gitignore
├── db.mjs                  # SQLite schema + query helpers (node:sqlite)
├── server.mjs              # node:http server, serves public/ + /api/* endpoints
├── sync.mjs                # orchestrates all scrapers, runs daily
├── run-sync.cmd            # thin wrapper for Windows Task Scheduler
├── scrapers/
│   ├── fetch.mjs           # shared HTTP fetch helper (UA, timeout, retry)
│   ├── howei.mjs
│   ├── racexasia.mjs
│   ├── jomrun.mjs
│   ├── biib.mjs
│   ├── heyjom.mjs
│   ├── ticket2u.mjs
│   ├── checkpointspot.mjs  # Playwright login crawl (enabled via .env flag)
│   ├── social.mjs          # FB/IG login crawl (disabled by default)
│   └── normalizer.mjs      # dedupe + merge same race across sources
├── public/
│   └── index.html          # upgraded UI (serves live data from /api)
├── tests/
│   ├── fixtures/           # saved HTML snapshots for offline parser tests
│   └── *.test.mjs          # node:test — unit + integration
└── data/
    └── runhub.db           # created at runtime
```

## 4. Data model (SQLite)

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,        -- stable slug, e.g. "klscm-2026"
  title         TEXT NOT NULL,
  organizer     TEXT,
  start_date    TEXT,                    -- ISO yyyy-mm-dd
  end_date      TEXT,
  state         TEXT,                    -- KL, Selangor, Penang, ...
  venue         TEXT,
  description   TEXT,
  status        TEXT,                    -- open | upcoming | closed | sold_out
  banner_url    TEXT,
  first_seen_at TEXT,
  updated_at    TEXT
);

CREATE TABLE event_sources (             -- dedupe: one race may list on 2+ portals
  event_id   TEXT NOT NULL REFERENCES events(id),
  portal     TEXT NOT NULL,              -- howei | racexasia | jomrun | biib | ...
  source_url TEXT NOT NULL,              -- the canonical register/landing URL
  PRIMARY KEY (event_id, portal)
);

CREATE TABLE categories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL REFERENCES events(id),
  distance_km     REAL,
  label           TEXT,                  -- "A: 21km Men Open (17yrs+)"
  price_early     REAL,                  -- RM
  price_normal    REAL,
  price_note      TEXT,                  -- "excludes RM4 insurance"
  cutoff_time     TEXT,
  flag_off_time   TEXT,
  status          TEXT
);

CREATE TABLE entitlements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES events(id),
  kind        TEXT,                      -- event_tee | finisher_tee | medal | fee_table | ...
  title       TEXT,
  image_url   TEXT,
  notes       TEXT
);

CREATE TABLE my_races (                  -- personal tracker (single user)
  event_id     TEXT PRIMARY KEY REFERENCES events(id),
  my_status    TEXT,                     -- watchlist | registered | skip
  target_distance TEXT,
  target_time  TEXT,
  shirt_size   TEXT,
  notes        TEXT
);

CREATE TABLE sync_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  portals    TEXT,                       -- json array of what ran
  counts     TEXT,                       -- json {events, categories, entitlements}
  errors     TEXT                        -- json array
);
```

**Dedupe rule (`normalizer.mjs`):** same `title` normalized (lowercase, strip years/edition noise)
+ same `state` **or** overlapping `start_date` (within ±1 day) ⇒ same event. Merge by preferring the
source with the most entitlements data (RaceXasia > Howei > JomRun > BiiB > HeyJom). Store every
source URL in `event_sources` so "Buy Ticket" can list **multiple official links**.

## 5. Acceptance criteria (testable, exact)

### Core data flow
- **AC-01** Running `node sync.mjs` populates `data/runhub.db` with `events`, `categories`,
  `entitlements`, `event_sources`, and one row in `sync_runs` (started + finished timestamps set).
- **AC-02** Re-running `node sync.mjs` twice in a row does not create duplicate `events` rows
  (idempotent — same slug is upserted, `updated_at` refreshed).
- **AC-03** For the seeded sample race "SHARP HSNKL Half Marathon 2026", after sync the DB contains
  at least 1 `category` with `distance_km = 21`, a non-null `price_normal`, and at least 1
  `entitlement` with `kind = finisher_tee` and a non-empty `image_url`.
- **AC-04** `sync_runs.errors` is `"[]"` (empty) when all enabled sources succeed.

### Server / API
- **AC-05** `GET /api/events` returns JSON array; every item has non-empty `id`, `title`,
  `start_date`, `state`, and an array `sources` with ≥1 `{portal, source_url}`.
- **AC-06** `GET /api/events?state=Selangor` returns only events where `state = 'Selangor'`.
- **AC-07** `GET /api/events/<id>` returns the single event with nested `categories` and
  `entitlements` arrays.
- **AC-08** `GET /api/my-races` returns `[]` on a fresh DB; `POST /api/my-races` upserts and a
  subsequent `GET` returns the saved row.
- **AC-09** `GET /api/sync/status` returns the latest `sync_runs` row (last run time, counts).

### UI
- **AC-10** Opening `http://localhost:3300` shows the race grid populated from `/api/events`
  (not from a hardcoded array). With an empty DB it shows the empty state.
- **AC-11** The search box, year/distance/tier/state filters work against live data and update the
  result count.
- **AC-12** Clicking a race card opens a **detail drawer** showing: distance chips, price table
  (early/normal), entitlement images (tee/medal) with full-size image links, race-pack info, and
  **every** `event_sources` URL as a clickable "Buy Ticket" link.
- **AC-13** A "Sync now" button calls the sync endpoint and shows a spinner then "Last synced Xs ago";
  a "New since last check" badge marks events whose `first_seen_at` is newer than the last UI visit.
- **AC-14** "My Season" (watchlist) persists across page reloads (via `/api/my-races`, not localStorage).

### Scheduling
- **AC-15** A Windows Scheduled Task `RunHub-DailySync` exists, runs `run-sync.cmd` daily, and a
  manual `schtasks /Run` of it produces a fresh `sync_runs` row. Task's "Last Run Result" is `0`.

### Ads (subtle) — deferred, isolated
- **AC-16** When the ads module is enabled, the app shows **exactly one** non-blocking native ad
  unit per page load (a sponsored event card or a footer strip). No popup, no interstitial, no
  autoplay, no overlay. Ad code is behind a config flag `ADS_ENABLED=false` by default.

## 6. Build order

1. **Scaffold + db** — `package.json`, `.gitignore`, `db.mjs` (schema + upsert helpers), `server.mjs`
   stub. Seed the DB from the prototype's hardcoded races so the UI never regresses.
2. **Scrapers (public sources first)** — `fetch.mjs`, then Howei, RaceXasia, JomRun, BiiB, HeyJom,
   Ticket2U. Use the HTML fixtures in `tests/fixtures/` to write parsers offline (deterministic).
3. **Normalizer** — dedupe + merge, idempotency.
4. **sync.mjs** — orchestrates, writes `sync_runs`, tolerant to single-source failure (one portal
   failing must not abort the run; record it in `sync_runs.errors`).
5. **Server + UI** — `/api/*` endpoints, upgrade `index.html` to fetch live data + detail drawer.
6. **Login-based crawls (opt-in)** — CheckpointSpot via Playwright; social.mjs stubbed off.
7. **Scheduler + verify** — `run-sync.cmd`, `schtasks`, run the real sync end-to-end.

## 7. Test plan (traceable to ACs)

Run with `node --test`. **Real SQLite, not mocks.** Only network is mocked (via `tests/fixtures/`).

| Test id | Type | Traces to | Method / expected |
|---|---|---|---|
| TC-DB-01 | integration | AC-01, AC-02 | Run `sync.mjs` against fixture-backed sources; assert `sync_runs` row exists and event slug count unchanged on 2nd run |
| TC-DB-02 | unit | AC-03 | Parse `racexasia-detail.html` fixture; assert extracted category `distance_km=21`, `price_normal` number, `finisher_tee` entitlement has URL |
| TC-DB-03 | unit | AC-04 | Run sync with one failing source stub; assert `sync_runs.errors` non-empty but other sources still stored |
| TC-API-01 | integration | AC-05..07 | Start server on test DB; `fetch` `/api/events`, assert shape + `state=Selangor` filter + `/api/events/<id>` nesting |
| TC-API-02 | integration | AC-08 | POST then GET `/api/my-races`; assert upsert semantics |
| TC-API-03 | integration | AC-09 | Assert `/api/sync/status` reflects latest run |
| TC-UI-01 | e2e (Playwright) | AC-10..12 | Load `localhost:3300`; assert grid renders from API, filter changes count, drawer shows entitlement images + ≥1 buy link |
| TC-UI-02 | e2e | AC-13, AC-14 | Click "Sync now" → spinner → "Last synced"; add to My Season → reload → still present |
| TC-SCHED-01 | manual/script | AC-15 | `schtasks /Query /TN RunHub-DailySync` exists; `/Run` it; assert `sync_runs` new row + exit 0 |
| TC-ADS-01 | unit | AC-16 | With `ADS_ENABLED=true`, assert exactly 1 non-blocking unit rendered; with `false`, assert zero ad markup |

**Boundary/negative cases** (each P0 flow): empty feed (zero events → empty state, no crash),
malformed date (`start_date` unparseable → skip event, record error, don't abort), duplicate slug
collision (upsert, no throw), one source times out (other sources still commit), DB locked/concurrent
(sync run serialized — single process only).

**Entry criteria:** fixtures present, DB schema applies cleanly, server boots. **Exit criteria:** all
TC-* above pass on a clean DB; `node sync.mjs` completes with `sync_runs.errors == []` for the
enabled public sources; scheduled task verified manually once.

## 8. Ads policy (subtle, non-intrusive)

- **Never**: popups, interstitials, auto-playing media, full-screen takeovers, sticky overlays that
  cover content, or more than one ad surface per view.
- **Allowed (later, flag-gated):** one inline "sponsored event" card in the grid (clearly labeled
  "Sponsored"), or a slim footer strip. No ad code ships in the core build; it is a separate module
  behind `ADS_ENABLED`.

## 9. Facebook / Instagram finding (recorded, do not re-research)

- **Official API:** requires a Meta developer app + Business verification + **App Review**.
  - Instagram *other-account* media needs **Page Public Content Access** or
    **Page Public Metadata Access** feature approval (denied for non-analytics/personal uses).
  - Instagram **hashtag search is deprecated** (7-day, 30-hashtag limits already removed/legacy).
  - **Business Discovery** (`business_discovery.username`) only works for your own connected
    Business/Creator account, not arbitrary organizers.
- **Conclusion:** Meta API is not viable for this personal aggregator. If FB/IG coverage is wanted,
  it must be **login-based Playwright crawl** of specific organizer pages (user-supplied account),
  implemented as the opt-in `social.mjs`, **disabled by default**. Lower priority than the 6 public
  portals.

## 10. What is unverified / open

- CheckpointSpot post-Cloudflare page structure (not yet reached behind the challenge).
- Exact FB/IG login-crawl selectors (blocked until credentials + a target list are provided).
- Whether some JomRun/Howei event images are behind referrer checks (assume yes; fetch with UA +
  `Accept` headers and store the remote URL, do not hotlink locally).

## 11. Build log — deviations from this plan (append-only)

**2026-11-02 — Phases P1–P4 complete, verified against live portals.**

Implementation notes that differ from the sections above; they supersede them:

1. **`node:sqlite` export is `DatabaseSync`, not `Database`.** A `better-sqlite3`
   detour was added and then reverted — the project still has **zero runtime
   dependencies**, as planned.
2. **`scrapers/seed.mjs` was dropped.** It tried to `JSON.parse` the prototype's
   JS object literal, which is not JSON. Live scrapers make it unnecessary; the
   empty state (AC-10) covers the no-data case instead of fake seed rows.
3. **`scrapers/phpdump.mjs` added.** RaceXasia's embedded PHP `var_dump` is parsed
   by a real recursive-descent parser, not regex chains. Multi-line scalars and
   empty-value-vs-nested-block ambiguity are both handled. 5 unit tests.
4. **`scrapers/dates.mjs` added.** `toIso()` normalises the portal date shapes
   (`2nd May 2027`, `24 - 25 October 2026`, ISO, `29 November, 2026`).
5. **Howei state extraction**: the meta description's first `<X> event,` match is
   the *country* (`Malaysia`); the first non-`Malaysia` match is the state.
6. **Howei slugs must be captured from `event_details/<slug>`**, not the whole
   absolute `href` — the earlier bug produced 404s on every detail fetch.
7. **Entry-point guard**: use `pathToFileURL(process.argv[1]).href === import.meta.url`.
   Naive backslash replacement silently prevented `sync.mjs`/`server.mjs` from running.
8. **JomRun distances come from the `ABOUT` text** (`5KM Fun Run`, `10KM ...`),
   since there is no structured category table on the page.

### Verified results (live, 2026-11-02)

```
sync: racexasia 16 | jomrun 17 | howei 42 | biib 24 | heyjom 47
      146 scraped -> 142 unique, 160 categories, 342 entitlements, 0 errors
DB:   142 events, 145 sources, 3 multi-source merges
      114 with start_date, 79 with state, 215 entitlement images, 136 priced categories
```

- **AC-01 pass** — one `sync_runs` row, started/finished/counts/errors all populated.
- **AC-02 pass** — second run produced byte-identical counts (142/160/342), no duplicates.
- **AC-03 pass** — 21km category + priced + `finisher_tee` image URL from the fixture.
- **AC-04 pass** — `sync_runs.errors == []`.
- **AC-05..AC-09 pass** — covered by `tests/api.test.mjs` (6 assertions).

**Test suite: 38/38 passing** (`npm test`). Files: `tests/phpdump.test.mjs`,
`tests/parsers.test.mjs`, `tests/db.test.mjs`, `tests/api.test.mjs`.

**Still open:** AC-10..AC-16 (UI, sync button, e2e, scheduled task, ads) and the
remaining plan steps below.

---

**Fixture inventory (already saved and verified 2026-11-02 — use these for offline parser tests):**

| Fixture | Verified content |
|---|---|
| `racexasia-list.html` | 16 event links (13 marked closed) |
| `racexasia-detail.html` | embedded dump contains `[KeyDate] [Category] [Entitlement] [RacePack]` — all true |
| `jomrun-list.html` | 17 event links |
| `jomrun-detail.html` | `ABOUT`, `RACE PACK COLLECTION`, `REGISTRATION ENDS AT` blocks — all present |
| `howei-feed.xml` | 30 RSS items |
| `howei-detail.html` | `category`, `entitle`, `tshirt` tabs — all present |
| `biib-list.html` | 32 event links |
| `biib-detail.html` | title, description, banner, register URL |
| `heyjom-calendar.html` | `data-page` JSON parses: 47 events (name, state, start_date, venue, status) |

`tests/verify.mjs` re-runs these checks; keep it green whenever fixtures are refreshed.

## 12. Phase 2 plan (2026-11-02 code review → finish the app)

### 12.1 Review findings (verified against code + live DB)

| # | Finding | Impact | Fix (task) |
|---|---|---|---|
| F1 | No `public/` — `/` returns 404 | AC-10..14 all fail | T6 |
| F2 | Event id = winning portal's slug; when a richer portal appears later, a **new** row is created and the old one stays | duplicate races across syncs (breaks AC-02 over time), orphaned `my_races` | T1: resolve id via existing `event_sources.source_url` before save |
| F3 | `race_pack`, `key_dates`, `registration_deadline` parsed, never persisted | AC-12 race-pack info impossible | T1: JSON columns + idempotent `ALTER TABLE` migration |
| F4 | `saveEvent` loop not in a transaction | partial writes on crash, slow | T1 |
| F5 | 63/142 no `state`, 28/142 no `start_date`; `Pulau Pinang` vs `Penang` split | AC-05 (non-empty state/date) fails on live data, AC-06/11 state filter splits | T2: `scrapers/states.mjs` canonicaliser + infer from venue/title; skip undated (§7 boundary rule) and count them |
| F6 | JomRun title derived from slug; BiiB has no date/distances; BiiB lists non-running events | poor dedupe + noise | T2 |
| F7 | `sync.mjs` exit code compares *all* errors (incl. per-detail 404s) to portal count | false exit 1 → Task Scheduler reports failure | T4: exit 1 only when zero portals succeeded |
| F8 | `runSync` scrapers hard-coded | TC-DB-01 / TC-DB-03 untestable | T4: injectable `scrapers` option |
| F9 | Server binds all interfaces; static path check is a regex strip; bad JSON → 500 | security / correctness | T5: bind `127.0.0.1`, `resolve()`+prefix check, 400 on bad JSON |
| F10 | Ticket2U scraper missing; `run-sync.cmd` missing; `tests/verify.mjs` referenced but absent | AC-15, source coverage | T3, T8, T9 |

### 12.2 Decisions

- **UI:** port the prototype's look (dark, lime/orange) into `public/index.html` with **plain CSS + inline SVG**, no Tailwind/FontAwesome CDN — works offline, zero deps.
- **Apparel tier (AC-11 filter):** derived, not hand-graded: `GLOBAL` if description/entitlements mention a global brand (ASICS, adidas, Nike, Puma, New Balance, Under Armour, HOKA, Saucony, Brooks, Mizuno, On); `CUSTOM` if a tee entitlement exists; else `UNKNOWN`.
- **"New since last check" (AC-13):** last-visit timestamp in `localStorage` (UI state only). My Season stays server-side (AC-14).
- **Past events** stay in the DB; the UI hides them by default (toggle).
- **Deferred:** CheckpointSpot (needs creds), `social.mjs` (off), ads (AC-16) — last, flag-gated.

### 12.3 Task list (traceable)

| T | Task | ACs |
|---|---|---|
| T1 | Data layer: transaction, stable-id resolution, JSON columns, `last_seen_at`, migration | AC-01, AC-02, AC-12 |
| T2 | Data quality: state canonicaliser/inference, JomRun og:title, BiiB date+distances, running-only filter, skip undated | AC-05, AC-06, AC-11 |
| T3 | Ticket2U scraper + fixture + parser test | AC-01 |
| T4 | `runSync` injectable scrapers, exit-code fix, TC-DB-01 + TC-DB-03 | AC-01, AC-02, AC-04 |
| T5 | Server hardening + `/api/my-races` joined with event + sync `running` flag; tests | AC-05..09, AC-13 |
| T6 | `public/index.html`: live grid, filters, detail drawer, Sync now, New badge, My Season via API | AC-10..14 |
| T7 | Playwright e2e TC-UI-01/02 | AC-10..14 |
| T8 | `run-sync.cmd` + `RunHub-DailySync` scheduled task, verify Last Run Result 0 | AC-15 |
| T9 | `tests/verify.mjs`, README/build-log update, live end-to-end sync | exit criteria |
| T10 | (deferred) CheckpointSpot Playwright opt-in, `social.mjs` stub, ads module | AC-16 |

## 13. Phase 2 build log — T1–T9 done, verified live (append-only)

**2026-11-02 (evening).** All of T1–T9 complete. Deviations from §12 and findings that
were only visible once the code ran:

### What changed, in order

1. **T1 — data layer.** `saveEvent` now runs in a transaction and resolves its id from any
already-known `event_sources.source_url`, so a richer portal appearing later updates the
existing row instead of creating a duplicate. `race_pack` / `key_dates` /
`registration_deadline` / `last_seen_at` are new `events` columns, added by an idempotent
`migrate()` (`PRAGMA table_info` + `ALTER TABLE`), and JSON columns are parsed on read.
2. **T2 — data quality.** New `scrapers/states.mjs` (`canonicalState` / `resolveState` /
`isRunning`). New `scrapers/html.mjs` holds the shared `stripHtml` + `decodeEntities` that
were duplicated in four scrapers. BiiB now reads date/venue/distances from its
"Event Details" block; JomRun takes its title from `og:title`.
3. **T3 — Ticket2U.** The listing is a Vue SPA, but its data is a plain JSON POST to
`/api/api2.ashx` (`{"method":"eventlisting","data":{"cc":"sport","stateid":""}}`).
No browser needed. **The `link` field is absolute in a browser and relative over plain
HTTP** — the parser resolves it against the base URL.
4. **T4 — sync.** `runSync({ scrapers })` is injectable, so TC-DB-01/TC-DB-03 run offline.
Exit code is 1 only when *no* portal succeeded.
5. **T5 — server.** Binds `127.0.0.1` (`HOST` env to override), static serving uses
`resolve()` + prefix check, malformed JSON is a 400, `/api/my-races` joins the event, and
`/api/sync/status` reports `running`.
6. **T6 — UI.** `public/index.html` is a single self-contained file (plain CSS, inline SVG,
no CDN) so it works offline. Grid, search, year/distance/entitlement/state filters, past
toggle, detail drawer, Sync now with polling, "New" badge, and My Season via the API.
7. **T7 — e2e.** `tests/ui.test.mjs` drives the real server with Playwright and skips
(rather than fails) when no browser is installed.
8. **T8 — scheduler.** `run-sync.cmd` logs to `logs/sync.log`; task `RunHub-DailySync`
runs daily at 07:00. Verified: `Last Result: 0`, fresh `sync_runs` row.
9. **T9 — verify.** `tests/verify.mjs` (`npm run verify`) checks all 10 fixtures plus the
live DB.

### Bugs found by running it (not visible in review)

- **`getEvents` returned no `categories`/`entitlements`.** The list view filters on distance
  and entitlement tier, so every distance chip and price on the cards was dead and the 42K
  filter matched nothing. Now attached in one grouped pass (no N+1).
- **The running filter was an allowlist and dropped real races** — `Selmar 2026`,
  `Race Against Cancer @ Wangsa Maju`, `RUNLIGA Team Race 2027`, `Bristwalk ... 3km`.
  Rewritten as a denylist of clearly non-running categories (badminton, zumba, seminars,
  cycling…), with a positive keyword override. Regression test added.
- **Upserts never removed anything**, so the 34 pre-quality-gate rows (badminton cups,
  business seminars) stayed in the DB forever. Added `pruneStale()`, which only deletes an
  event when *every* portal it came from succeeded this run, and never deletes a race saved
  to `my_races`.
- **HTML entities/mojibake leaked into titles** (`JomRunÂ®`, `Kellie&#039;s Castle`).
  Fixed centrally in `scrapers/html.mjs`.

### Verified results (live, 2026-11-02)

```
sync: racexasia 16 | jomrun 16 | howei 42 | biib 24 | heyjom 48 | ticket2u 18
      164 scraped -> 134 unique, pruned 22, 150 categories, 320 entitlements, 0 errors
DB:   134 events, 139 sources, 5 multi-source merges
      134 with start_date (100%), 117 with state (87%), 215 entitlement images,
      151 priced categories
```

- **AC-01..AC-09 pass** — `tests/db.test.mjs`, `tests/api.test.mjs`, `tests/sync.test.mjs`.
- **AC-10..AC-14 pass** — `tests/ui.test.mjs` (Playwright, real server, real SQLite).
- **AC-15 pass** — `schtasks /Query /TN RunHub-DailySync` → `Last Result: 0`.
- **AC-16 open** — ads remain the deferred, flag-gated module (§8).

**Test suite: 63/63 passing** (`npm test`). Files: `tests/phpdump.test.mjs`,
`tests/parsers.test.mjs`, `tests/db.test.mjs`, `tests/api.test.mjs`, `tests/sync.test.mjs`,
`tests/ui.test.mjs`.

### Still open

- **AC-16** ads module (deferred by design, §8).
- **CheckpointSpot** — still behind Cloudflare; needs Playwright + credentials in `.env`.
- **`social.mjs`** — stub only; needs a target list and an account.
- 17/134 events still have no state (virtual runs, `MyCity RUN`, `STAKAN National Day Night
  Run`). They are kept, not guessed; the state filter simply excludes them.
