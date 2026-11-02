import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

// Located at a function so tests can point at a temp file.
export function openDb(path = "data/runhub.db") {
  mkdirSync(path.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Idempotent column adds for DBs created before these fields existed.
const NEW_EVENT_COLS = ["race_pack", "key_dates", "registration_deadline", "last_seen_at"];
function migrate(db) {
  const have = new Set(db.prepare("PRAGMA table_info(events)").all().map((c) => c.name));
  for (const col of NEW_EVENT_COLS) {
    if (!have.has(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} TEXT`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  organizer     TEXT,
  start_date    TEXT,
  end_date      TEXT,
  state         TEXT,
  venue         TEXT,
  description   TEXT,
  status        TEXT,
  banner_url    TEXT,
  first_seen_at TEXT,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS event_sources (
  event_id   TEXT NOT NULL REFERENCES events(id),
  portal     TEXT NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY (event_id, portal)
);

CREATE TABLE IF NOT EXISTS categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL REFERENCES events(id),
  distance_km  REAL,
  label        TEXT,
  price_early  REAL,
  price_normal REAL,
  price_note   TEXT,
  cutoff_time  TEXT,
  flag_off_time TEXT,
  status       TEXT
);

CREATE TABLE IF NOT EXISTS entitlements (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT NOT NULL REFERENCES events(id),
  kind      TEXT,
  title     TEXT,
  image_url TEXT,
  notes     TEXT
);

CREATE TABLE IF NOT EXISTS my_races (
  event_id       TEXT PRIMARY KEY REFERENCES events(id),
  my_status      TEXT,
  target_distance TEXT,
  target_time    TEXT,
  shirt_size     TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT,
  finished_at TEXT,
  portals     TEXT,
  counts      TEXT,
  errors      TEXT
);

CREATE INDEX IF NOT EXISTS idx_categories_event ON categories(event_id);
CREATE INDEX IF NOT EXISTS idx_entitlements_event ON entitlements(event_id);
`;

const now = () => new Date().toISOString();

/**
 * Upsert one event plus its children. Idempotent: re-running refreshes
 * `updated_at` and never duplicates rows.
 * Child rows (categories, entitlements) are replaced wholesale on each upsert
 * so a re-sync cannot accumulate stale duplicates.
 */
export function saveEvent(db, event) {
  db.exec("BEGIN");
  try {
    saveEventInner(db, event);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function saveEventInner(db, event) {
  const ts = now();
  // Stable id: if any source URL is already known, keep that event row so a
  // richer portal appearing later does not spawn a duplicate (or orphan my_races).
  for (const s of event.sources ?? []) {
    const known = db
      .prepare("SELECT event_id FROM event_sources WHERE source_url = ?")
      .get(s.source_url);
    if (known) {
      event = { ...event, id: known.event_id };
      break;
    }
  }
  const existing = db
    .prepare("SELECT first_seen_at FROM events WHERE id = ?")
    .get(event.id);

  db.prepare(
    `INSERT INTO events (id, title, organizer, start_date, end_date, state, venue,
        description, status, banner_url, first_seen_at, updated_at,
        race_pack, key_dates, registration_deadline, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, organizer=excluded.organizer,
       start_date=excluded.start_date, end_date=excluded.end_date,
       state=excluded.state, venue=excluded.venue,
       description=excluded.description, status=excluded.status,
       banner_url=excluded.banner_url, updated_at=excluded.updated_at,
       race_pack=excluded.race_pack, key_dates=excluded.key_dates,
       registration_deadline=excluded.registration_deadline,
       last_seen_at=excluded.last_seen_at`
  ).run(
    event.id,
    event.title ?? null,
    event.organizer ?? null,
    event.start_date ?? null,
    event.end_date ?? null,
    event.state ?? null,
    event.venue ?? null,
    event.description ?? null,
    event.status ?? null,
    event.banner_url ?? null,
    existing?.first_seen_at ?? ts,
    ts,
    event.race_pack?.length ? JSON.stringify(event.race_pack) : null,
    event.key_dates?.length ? JSON.stringify(event.key_dates) : null,
    event.registration_deadline ?? null,
    ts
  );

  db.prepare("DELETE FROM categories WHERE event_id = ?").run(event.id);
  for (const c of event.categories ?? []) {
    db.prepare(
      `INSERT INTO categories (event_id, distance_km, label, price_early,
          price_normal, price_note, cutoff_time, flag_off_time, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      c.distance_km ?? null,
      c.label ?? null,
      c.price_early ?? null,
      c.price_normal ?? null,
      c.price_note ?? null,
      c.cutoff_time ?? null,
      c.flag_off_time ?? null,
      c.status ?? null
    );
  }

  db.prepare("DELETE FROM entitlements WHERE event_id = ?").run(event.id);
  for (const e of event.entitlements ?? []) {
    db.prepare(
      `INSERT INTO entitlements (event_id, kind, title, image_url, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      event.id,
      e.kind ?? null,
      e.title ?? null,
      e.image_url ?? null,
      e.notes ?? null
    );
  }

  for (const s of event.sources ?? []) {
    db.prepare(
      `INSERT INTO event_sources (event_id, portal, source_url)
       VALUES (?, ?, ?)
       ON CONFLICT(event_id, portal) DO UPDATE SET source_url=excluded.source_url`
    ).run(event.id, s.portal, s.source_url);
  }
}

export function getEvents(db, { state } = {}) {
  const rows = state
    ? db.prepare("SELECT * FROM events WHERE state = ? ORDER BY start_date").all(state)
    : db.prepare("SELECT * FROM events ORDER BY start_date").all();

  // The list view filters on distance and entitlement tier, so it needs the
  // children too. Group them in one pass instead of a query per event.
  const group = (sql) => {
    const map = new Map();
    for (const row of db.prepare(sql).all()) {
      const { event_id, ...rest } = row;
      if (!map.has(event_id)) map.set(event_id, []);
      map.get(event_id).push(rest);
    }
    return (id) => map.get(id) ?? [];
  };
  const src = group("SELECT event_id, portal, source_url FROM event_sources");
  const cats = group("SELECT * FROM categories ORDER BY distance_km");
  const ents = group("SELECT * FROM entitlements ORDER BY id");

  for (const r of rows) {
    r.sources = src(r.id);
    r.categories = cats(r.id);
    r.entitlements = ents(r.id);
  }
  return rows;
}

const parseJson = (v) => {
  try {
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
};

export function getEvent(db, id) {
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (!event) return null;
  event.race_pack = parseJson(event.race_pack);
  event.key_dates = parseJson(event.key_dates);
  event.categories = db
    .prepare("SELECT * FROM categories WHERE event_id = ? ORDER BY distance_km")
    .all(id);
  event.entitlements = db
    .prepare("SELECT * FROM entitlements WHERE event_id = ? ORDER BY id")
    .all(id);
  event.sources = db
    .prepare("SELECT portal, source_url FROM event_sources WHERE event_id = ?")
    .all(id);
  return event;
}

/**
 * Drop events that no longer appear on any portal.
 *
 * Only events whose every source portal ran successfully this sync are eligible:
 * if a portal timed out we cannot tell "gone" from "unreachable", so its events
 * are kept. Rows in `my_races` also pin an event, so a saved race is never lost.
 * Returns the number of events removed.
 */
export function pruneStale(db, { seenIds, portalsRun }) {
  const seen = new Set(seenIds);
  const ran = new Set(portalsRun);
  const portalsOf = db.prepare("SELECT portal FROM event_sources WHERE event_id = ?");
  const saved = new Set(db.prepare("SELECT event_id FROM my_races").all().map((r) => r.event_id));

  const stale = [];
  for (const { id } of db.prepare("SELECT id FROM events").all()) {
    if (seen.has(id) || saved.has(id)) continue;
    const portals = portalsOf.all(id).map((r) => r.portal);
    if (portals.length && portals.every((p) => ran.has(p))) stale.push(id);
  }

  if (!stale.length) return 0;

  const delCats = db.prepare("DELETE FROM categories WHERE event_id = ?");
  const delEnts = db.prepare("DELETE FROM entitlements WHERE event_id = ?");
  const delSrcs = db.prepare("DELETE FROM event_sources WHERE event_id = ?");
  const delEvent = db.prepare("DELETE FROM events WHERE id = ?");

  db.exec("BEGIN");
  try {
    for (const id of stale) {
      delCats.run(id);
      delEnts.run(id);
      delSrcs.run(id);
      delEvent.run(id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return stale.length;
}

export function saveMyRace(db, r) {
  db.prepare(
    `INSERT INTO my_races (event_id, my_status, target_distance, target_time, shirt_size, notes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       my_status=excluded.my_status,
       target_distance=excluded.target_distance,
       target_time=excluded.target_time,
       shirt_size=excluded.shirt_size,
       notes=excluded.notes`
  ).run(
    r.event_id,
    r.my_status ?? null,
    r.target_distance ?? null,
    r.target_time ?? null,
    r.shirt_size ?? null,
    r.notes ?? null
  );
}

export const getMyRaces = (db) => db.prepare("SELECT * FROM my_races").all();

export const lastSyncRun = (db) =>
  db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get() ?? null;

export function recordSyncRun(db, { startedAt, finishedAt, portals, counts, errors }) {
  db.prepare(
    `INSERT INTO sync_runs (started_at, finished_at, portals, counts, errors)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    startedAt,
    finishedAt,
    JSON.stringify(portals),
    JSON.stringify(counts),
    JSON.stringify(errors)
  );
}
