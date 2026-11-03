import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { runSync } from "../sync.mjs";
import { getEvent, getEvents } from "../db.mjs";
import { canonicalState, resolveState, isRunning } from "../scrapers/states.mjs";
import { tempDb, pgAvailable } from "./helpers.mjs";

const available = await pgAvailable();
const skip = available ? false : "Postgres not reachable (set DATABASE_URL)";

let ctx;
before(async () => {
  if (available) ctx = await tempDb();
});
after(async () => {
  await ctx?.cleanup();
});

const ev = (over = {}) => ({
  id: "e1",
  title: "Alpha Run 2026",
  start_date: "2099-09-01",
  state: "Selangor",
  categories: [{ distance_km: 10, price_normal: 50 }],
  entitlements: [],
  sources: [{ portal: "howei", source_url: "https://howei.com/event_details/e1" }],
  ...over,
});

const stub = (events, errors = []) => async () => ({ events, errors });
const boom = async () => {
  throw new Error("timeout");
};

/** Fresh schema per test so archive/prune state does not leak between cases. */
const withDb = async (fn) => {
  const local = await tempDb();
  try {
    return await fn(local.db);
  } finally {
    await local.cleanup();
  }
};

const count = async (db, sql) => (await db.query(sql)).rows[0].c;

test("TC-DB-01: sync is idempotent and records a run (AC-01, AC-02)", { skip }, () =>
  withDb(async (db) => {
    const scrapers = [["howei", stub([
      ev(),
      ev({ id: "e2", title: "Beta Marathon", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/e2" }] }),
      // distinct titles: dedupe merges same-title/same-state rows, so fixtures must differ
    ])]];
    await runSync({ db, log: () => {}, scrapers });
    await runSync({ db, log: () => {}, scrapers });
    assert.equal(await count(db, "SELECT count(*)::int c FROM events"), 2);
    assert.equal(await count(db, "SELECT count(*)::int c FROM sync_runs"), 2);
    assert.equal(await count(db, "SELECT count(*)::int c FROM categories"), 2);
    const run = (await db.query("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1")).rows[0];
    assert.ok(run.started_at && run.finished_at);
    assert.equal(run.errors, "[]", "AC-04");
  }));

test("TC-DB-03: one failing source is recorded, others still stored", { skip }, () =>
  withDb(async (db) => {
    const res = await runSync({ db, log: () => {}, scrapers: [["bad", boom], ["howei", stub([ev()])]] });
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /bad: timeout/);
    assert.deepEqual(res.portals, ["howei"]);
    assert.equal(await count(db, "SELECT count(*)::int c FROM events"), 1);
  }));

test("quality gate: undated and non-running events are skipped and counted", { skip }, () =>
  withDb(async (db) => {
    const res = await runSync({
      db,
      log: () => {},
      scrapers: [["howei", stub([
        ev({ title: "Alpha Kept Run 2099" }),
        ev({ id: "u", title: "Undated Run", start_date: null, sources: [{ portal: "howei", source_url: "u" }] }),
        ev({ id: "b", title: "ASICS Badminton Championship", sources: [{ portal: "howei", source_url: "b" }] }),
      ])]],
    });
    assert.equal(res.counts.skipped_undated, 1);
    assert.equal(res.counts.skipped_not_running, 1);
    assert.equal(await count(db, "SELECT count(*)::int c FROM events"), 1);
  }));

test("empty source yields an empty DB, no crash", { skip }, () =>
  withDb(async (db) => {
    const res = await runSync({ db, log: () => {}, scrapers: [["howei", stub([])]] });
    assert.equal(res.counts.unique, 0);
    assert.equal(await count(db, "SELECT count(*)::int c FROM events"), 0);
  }));

test("sync archives (never deletes) events that vanished from a portal", { skip }, () =>
  withDb(async (db) => {
    const a = ev({ id: "a", title: "Alpha River Run 2099" });
    const b = ev({ id: "b", title: "Bravo Hill Run 2099", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/b" }] });
    await runSync({ db, log: () => {}, scrapers: [["howei", stub([a, b])]] });
    assert.equal(await count(db, "SELECT count(*)::int c FROM events"), 2);

    const second = await runSync({ db, log: () => {}, scrapers: [["howei", stub([a])]] });
    assert.equal(second.counts.archived_stale, 1);

    assert.equal(await count(db, "SELECT count(*)::int c FROM events"), 2, "row kept");
    const gone = await getEvent(db, "b");
    assert.equal(gone.archived_reason, "delisted");
    assert.equal((await getEvents(db)).length, 1, "hidden from the default listing");
  }));

test("sync archives past events after the 7-day grace window", { skip }, () =>
  withDb(async (db) => {
    const scrapers = [["howei", stub([
      ev({ id: "old", title: "Old Coast Run 2020", start_date: "2020-01-01", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/old" }] }),
      ev({ id: "future", title: "Future Peak Run 2099" }),
    ])]];
    const res = await runSync({ db, log: () => {}, scrapers });
    assert.ok(res.counts.archived_date >= 1);
    assert.equal((await getEvent(db, "old")).archived_reason, "date_passed");
    assert.equal((await getEvent(db, "future")).archived_at, null);
  }));

test("sync keeps upcoming sold-out / closed events and never archives them", { skip }, () =>
  withDb(async (db) => {
    const scrapers = [["howei", stub([
      ev({ id: "a", title: "Alpha Sold Out Run 2099", status: "sold_out" }),
      ev({ id: "b", title: "Bravo Closed Run 2099", status: "closed", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/b" }] }),
      ev({ id: "c", title: "Charlie Open Run 2099", status: "open", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/c" }] }),
    ])]];
    await runSync({ db, log: () => {}, scrapers });
    await runSync({ db, log: () => {}, scrapers });
    const rows = (await db.query("SELECT id, status, archived_at FROM events ORDER BY id")).rows;
    assert.deepEqual(rows.map((r) => `${r.id}:${r.status}`), ["a:sold_out", "b:closed", "c:open"]);
    assert.ok(rows.every((r) => r.archived_at === null));
  }));

test("canonicalState unifies spellings and rejects non-places", () => {
  assert.equal(canonicalState("Pulau Pinang"), "Penang");
  assert.equal(canonicalState("Penang"), "Penang");
  assert.equal(canonicalState("KL"), "Kuala Lumpur");
  assert.equal(canonicalState("Anywhere"), null);
  assert.equal(canonicalState(null), null);
});

test("resolveState infers from venue/title when portal gave none", () => {
  assert.equal(resolveState({ state: null, venue: "Dewan Masyarakat, Jalan Padungan, Kuching" }), "Sarawak");
  assert.equal(resolveState({ state: null, venue: null, title: "Kuala Kangsar Half Marathon" }), "Perak");
  assert.equal(resolveState({ state: null, venue: "Unknown", title: "X Run" }), null);
});

test("isRunning keeps real races even without a keyword in the title", () => {
  for (const title of ["Selmar 2026", "Race Against Cancer @ Wangsa Maju", "RUNLIGA Team Race 2027", "Bristwalk Madani Kita Tanjung 3km", "Cendol Funwalk 2.0"]) {
    assert.ok(isRunning({ title }), `${title} must be kept`);
  }
});

test("isRunning drops non-running listings", () => {
  for (const title of ["Strategic Recruitment & AI-driven Hiring", "Hybrid Training Session For Fitness Races", "Decathlon The Waterfront Shoppes Zumba 2026", "Kayuhan Santai MTB Jerai Geopark 2027"]) {
    assert.ok(!isRunning({ title }), `${title} must be dropped`);
  }
});
