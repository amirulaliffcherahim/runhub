/**
 * Postgres data layer (node-postgres `pg`). The only runtime dependency.
 *
 * Connection: `DATABASE_URL` (from .env / pm2 env). Never hard-code credentials.
 * Tests point at a throwaway schema via `createDb({ schema })`, so they can run
 * against the same server without touching real data.
 *
 * Lifecycle of an event:
 *   active    - upcoming, or within `ARCHIVE_GRACE_DAYS` of its date
 *   archived  - date + grace days has passed. Row and children stay in the DB,
 *               but API/UI hide them by default.
 *   delisted  - the source stopped listing it. Kept and archived, never deleted.
 */
import pg from "pg";
import { readFileSync } from "node:fs";

const { Pool } = pg;

/** Days after the event date before an event moves to the archive. */
export const ARCHIVE_GRACE_DAYS = Number(process.env.ARCHIVE_GRACE_DAYS ?? 7);

/** Minimal .env reader (no dependency). Existing process.env wins. */
export function loadEnv(path = new URL("./.env", import.meta.url)) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
  }
}

loadEnv();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  organizer             TEXT,
  start_date            TEXT,
  end_date              TEXT,
  state                 TEXT,
  venue                 TEXT,
  description           TEXT,
  status                TEXT,
  banner_url            TEXT,
  race_pack             TEXT,
  key_dates             TEXT,
  registration_deadline TEXT,
  origin                TEXT,
  first_seen_at         TEXT,
  updated_at            TEXT,
  last_seen_at          TEXT,
  archived_at           TEXT,
  archived_reason       TEXT
);

CREATE TABLE IF NOT EXISTS event_sources (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  portal     TEXT NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY (event_id, portal)
);

CREATE TABLE IF NOT EXISTS categories (
  id            SERIAL PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  distance_km   DOUBLE PRECISION,
  label         TEXT,
  price_early   DOUBLE PRECISION,
  price_normal  DOUBLE PRECISION,
  price_note    TEXT,
  cutoff_time   TEXT,
  flag_off_time TEXT,
  status        TEXT
);

CREATE TABLE IF NOT EXISTS entitlements (
  id        SERIAL PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind      TEXT,
  title     TEXT,
  image_url TEXT,
  notes     TEXT
);

CREATE TABLE IF NOT EXISTS my_races (
  event_id        TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  my_status       TEXT,
  target_distance TEXT,
  target_time     TEXT,
  shirt_size      TEXT,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          SERIAL PRIMARY KEY,
  started_at  TEXT,
  finished_at TEXT,
  portals     TEXT,
  counts      TEXT,
  errors      TEXT,
  status      TEXT              -- running | ok | failed | interrupted
);

-- One row per portal per run, so a silent run can still be inspected afterwards.
CREATE TABLE IF NOT EXISTS sync_portal_runs (
  run_id      INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  portal      TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  events      INTEGER,
  errors      TEXT,
  status      TEXT,
  PRIMARY KEY (run_id, portal)
);

CREATE INDEX IF NOT EXISTS idx_categories_event ON categories(event_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_event ON entitlements(event_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived_at);
CREATE INDEX IF NOT EXISTS idx_sources_url ON event_sources(source_url);
CREATE INDEX IF NOT EXISTS idx_portal_runs_run ON sync_portal_runs(run_id);
`;

/** Columns added after the first release; applied idempotently to existing DBs. */
const MIGRATIONS = [
  ["race_pack", "TEXT"],
  ["key_dates", "TEXT"],
  ["registration_deadline", "TEXT"],
  ["origin", "TEXT"],
  ["last_seen_at", "TEXT"],
  ["archived_at", "TEXT"],
  ["archived_reason", "TEXT"],
];

const now = () => new Date().toISOString();

/**
 * Open a pool and make sure the schema exists.
 * `schema` (tests) isolates everything inside a throwaway Postgres schema.
 */
export async function openDb({ connectionString = process.env.DATABASE_URL, schema = null } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is not set (see .env.example)");

  const pool = new Pool({ connectionString, max: 4 });
  const db = {
    pool,
    schema,
    query: (text, params) => pool.query(text, params),
    async close() {
      await pool.end();
    },
  };

  if (schema) {
    // Identifiers cannot be parameterised; the name is generated by our own tests.
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name: ${schema}`);
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    pool.on("connect", (c) => c.query(`SET search_path TO ${schema}`));
  }

  await pool.query(SCHEMA);
  for (const [col, type] of MIGRATIONS) {
    await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  }
  // Columns added to other tables after their first release.
  await pool.query("ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS status TEXT");
  return db;
}

const parseJson = (v) => {
  try {
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
};

const parseRow = (row) => {
  if (!row) return row;
  return { ...row, race_pack: parseJson(row.race_pack), key_dates: parseJson(row.key_dates) };
};

/**
 * Upsert one event plus its children, in a single transaction.
 * Idempotent: re-running refreshes `updated_at` and never duplicates rows.
 * Children are replaced wholesale so a re-sync cannot accumulate stale rows.
 */
export async function saveEvent(db, event) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // Stable id: a known source URL wins, so a richer portal appearing later
    // updates the existing row instead of spawning a duplicate.
    let id = event.id;
    for (const s of event.sources ?? []) {
      const known = await client.query("SELECT event_id FROM event_sources WHERE source_url = $1 LIMIT 1", [s.source_url]);
      if (known.rowCount) {
        id = known.rows[0].event_id;
        break;
      }
    }

    const ts = now();
    const existing = await client.query("SELECT first_seen_at FROM events WHERE id = $1", [id]);

    await client.query(
      `INSERT INTO events (id, title, organizer, start_date, end_date, state, venue,
          description, status, banner_url, first_seen_at, updated_at,
          race_pack, key_dates, registration_deadline, origin, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, organizer=EXCLUDED.organizer,
         start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date,
         state=EXCLUDED.state, venue=EXCLUDED.venue,
         description=EXCLUDED.description, status=EXCLUDED.status,
         banner_url=EXCLUDED.banner_url, updated_at=EXCLUDED.updated_at,
         race_pack=EXCLUDED.race_pack, key_dates=EXCLUDED.key_dates,
         registration_deadline=EXCLUDED.registration_deadline,
         origin=COALESCE(events.origin, EXCLUDED.origin),
         last_seen_at=EXCLUDED.last_seen_at,
         archived_at=NULL, archived_reason=NULL`,
      [
        id,
        event.title ?? null,
        event.organizer ?? null,
        event.start_date ?? null,
        event.end_date ?? null,
        event.state ?? null,
        event.venue ?? null,
        event.description ?? null,
        event.status ?? null,
        event.banner_url ?? null,
        existing.rows[0]?.first_seen_at ?? ts,
        ts,
        event.race_pack?.length ? JSON.stringify(event.race_pack) : null,
        event.key_dates?.length ? JSON.stringify(event.key_dates) : null,
        event.registration_deadline ?? null,
        event.origin ?? null,
        ts,
      ]
    );

    await client.query("DELETE FROM categories WHERE event_id = $1", [id]);
    for (const c of event.categories ?? []) {
      await client.query(
        `INSERT INTO categories (event_id, distance_km, label, price_early, price_normal,
            price_note, cutoff_time, flag_off_time, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          c.distance_km ?? null,
          c.label ?? null,
          c.price_early ?? null,
          c.price_normal ?? null,
          c.price_note ?? null,
          c.cutoff_time ?? null,
          c.flag_off_time ?? null,
          c.status ?? null,
        ]
      );
    }

    await client.query("DELETE FROM entitlements WHERE event_id = $1", [id]);
    for (const e of event.entitlements ?? []) {
      await client.query(
        `INSERT INTO entitlements (event_id, kind, title, image_url, notes)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, e.kind ?? null, e.title ?? null, e.image_url ?? null, e.notes ?? null]
      );
    }

    for (const s of event.sources ?? []) {
      await client.query(
        `INSERT INTO event_sources (event_id, portal, source_url)
         VALUES ($1,$2,$3)
         ON CONFLICT (event_id, portal) DO UPDATE SET source_url=EXCLUDED.source_url`,
        [id, s.portal, s.source_url]
      );
    }

    await client.query("COMMIT");
    return id;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Attach sources/categories/entitlements to a list of events with 3 queries, not 3N. */
async function attachChildren(db, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const [src, cats, ents] = await Promise.all([
    db.query("SELECT event_id, portal, source_url FROM event_sources WHERE event_id = ANY($1)", [ids]),
    db.query("SELECT * FROM categories WHERE event_id = ANY($1) ORDER BY distance_km", [ids]),
    db.query("SELECT * FROM entitlements WHERE event_id = ANY($1) ORDER BY id", [ids]),
  ]);
  const group = (list) => {
    const m = new Map();
    for (const { event_id, ...rest } of list) {
      if (!m.has(event_id)) m.set(event_id, []);
      m.get(event_id).push(rest);
    }
    return (id) => m.get(id) ?? [];
  };
  const s = group(src.rows);
  const c = group(cats.rows);
  const e = group(ents.rows);
  for (const r of rows) {
    r.sources = s(r.id);
    r.categories = c(r.id);
    r.entitlements = e(r.id);
  }
  return rows;
}

/**
 * List events. Archived rows are excluded unless `includeArchived` is set.
 * `state` narrows to one state.
 */
export async function getEvents(db, { state, includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived) where.push("archived_at IS NULL");
  if (state) {
    params.push(state);
    where.push(`state = $${params.length}`);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY start_date NULLS LAST`;
  const { rows } = await db.query(sql, params);
  return attachChildren(db, rows.map(parseRow));
}

/** One event with nested children. Archived events are still readable by id. */
export async function getEvent(db, id) {
  const { rows } = await db.query("SELECT * FROM events WHERE id = $1", [id]);
  if (!rows.length) return null;
  const [event] = await attachChildren(db, [parseRow(rows[0])]);
  return event;
}

/**
 * Move events whose date + grace days has passed into the archive.
 * The row and its children stay in the DB; only visibility changes.
 * Returns the number archived.
 */
export async function archiveExpired(db, { graceDays = ARCHIVE_GRACE_DAYS, now: at = new Date() } = {}) {
  const cutoff = new Date(at);
  cutoff.setDate(cutoff.getDate() - graceDays);
  const { rowCount } = await db.query(
    `UPDATE events SET archived_at = $1, archived_reason = 'date_passed'
     WHERE archived_at IS NULL AND start_date IS NOT NULL AND start_date < $2`,
    [now(), cutoff.toISOString().slice(0, 10)]
  );
  return rowCount;
}

/**
 * Events that vanished from a portal are archived, never deleted, so history and
 * `my_races` survive. Only events whose every source portal ran successfully this
 * sync are eligible: if a portal timed out we cannot tell "gone" from "unreachable".
 * Returns the number archived.
 */
export async function archiveStale(db, { seenIds, portalsRun }) {
  const { rows } = await db.query(
    `SELECT e.id, array_agg(s.portal) AS portals
       FROM events e JOIN event_sources s ON s.event_id = e.id
      WHERE e.archived_at IS NULL AND NOT (e.id = ANY($1))
      GROUP BY e.id`,
    [seenIds]
  );
  const ran = new Set(portalsRun);
  const stale = rows.filter((r) => r.portals.length && r.portals.every((p) => ran.has(p))).map((r) => r.id);
  if (!stale.length) return 0;

  const { rowCount } = await db.query(
    `UPDATE events SET archived_at = $1, archived_reason = 'delisted'
     WHERE id = ANY($2) AND archived_at IS NULL`,
    [now(), stale]
  );
  return rowCount;
}

export async function saveMyRace(db, r) {
  await db.query(
    `INSERT INTO my_races (event_id, my_status, target_distance, target_time, shirt_size, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (event_id) DO UPDATE SET
       my_status=EXCLUDED.my_status,
       target_distance=EXCLUDED.target_distance,
       target_time=EXCLUDED.target_time,
       shirt_size=EXCLUDED.shirt_size,
       notes=EXCLUDED.notes`,
    [
      r.event_id,
      r.my_status ?? null,
      r.target_distance ?? null,
      r.target_time ?? null,
      r.shirt_size ?? null,
      r.notes ?? null,
    ]
  );
}

export const getMyRaces = async (db) => (await db.query("SELECT * FROM my_races")).rows;

export const deleteMyRace = async (db, eventId) => {
  await db.query("DELETE FROM my_races WHERE event_id = $1", [eventId]);
};

/**
 * Sync runs are recorded in Postgres so a silent/cron run can be inspected later:
 * one `sync_runs` row per run (status running -> ok|failed) plus one
 * `sync_portal_runs` row per portal (events, errors, duration).
 * A run still marked "running" after `STALE_MINUTES` is reported as interrupted,
 * which is how a crashed or killed process shows up.
 */
export const STALE_MINUTES = 90;

/** Open a run row. Returns its id. */
export async function startSyncRun(db, { startedAt = now(), portals = [] } = {}) {
  const { rows } = await db.query(
    `INSERT INTO sync_runs (started_at, portals, status, counts, errors)
     VALUES ($1,$2,'running','{}','[]') RETURNING id`,
    [startedAt, JSON.stringify(portals)]
  );
  return rows[0].id;
}

/** Record (or update) one portal's result inside a run. */
export async function recordPortalRun(db, runId, portal, { startedAt, finishedAt, events = 0, errors = [], status = "ok" }) {
  await db.query(
    `INSERT INTO sync_portal_runs (run_id, portal, started_at, finished_at, events, errors, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (run_id, portal) DO UPDATE SET
       finished_at=EXCLUDED.finished_at, events=EXCLUDED.events,
       errors=EXCLUDED.errors, status=EXCLUDED.status`,
    [runId, portal, startedAt, finishedAt, events, JSON.stringify(errors), status]
  );
}

/** Close a run row. */
export async function finishSyncRun(db, runId, { finishedAt = now(), portals, counts, errors, status = "ok" }) {
  await db.query(
    `UPDATE sync_runs SET finished_at=$1, portals=$2, counts=$3, errors=$4, status=$5 WHERE id=$6`,
    [finishedAt, JSON.stringify(portals), JSON.stringify(counts), JSON.stringify(errors), status, runId]
  );
}

/** Back-compat single-shot insert (used by older tests). */
export async function recordSyncRun(db, { startedAt, finishedAt, portals, counts, errors, status = "ok" }) {
  await db.query(
    `INSERT INTO sync_runs (started_at, finished_at, portals, counts, errors, status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [startedAt, finishedAt, JSON.stringify(portals), JSON.stringify(counts), JSON.stringify(errors), status]
  );
}

const markStale = async (db) => {
  await db.query(
    `UPDATE sync_runs SET status='interrupted'
      WHERE status='running' AND started_at < $1`,
    [new Date(Date.now() - STALE_MINUTES * 60_000).toISOString()]
  );
};

/** Latest run plus its per-portal rows. Used by /api/sync/status. */
export async function lastSyncRun(db) {
  await markStale(db);
  const run = (await db.query("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1")).rows[0] ?? null;
  if (!run) return null;
  const portals = (
    await db.query("SELECT portal, started_at, finished_at, events, errors, status FROM sync_portal_runs WHERE run_id=$1 ORDER BY portal", [run.id])
  ).rows.map((p) => ({ ...p, errors: parseJson(p.errors) }));
  return { ...run, portal_runs: portals };
}

/** Recent runs (newest first) for a status page or curl. */
export async function recentSyncRuns(db, limit = 10) {
  await markStale(db);
  const { rows } = await db.query(
    `SELECT id, started_at, finished_at, status, portals, counts, errors
       FROM sync_runs ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    ...r,
    counts: parseJson(r.counts),
    errors: parseJson(r.errors),
    portals: parseJson(r.portals),
  }));
}

/** Counts used by /api/sync/status and the footer. */
export async function dbStats(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE archived_at IS NULL)::int AS active,
            count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived
       FROM events`
  );
  return rows[0];
}
