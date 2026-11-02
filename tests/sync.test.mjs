import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSync } from "../sync.mjs";
import { openDb } from "../db.mjs";
import { canonicalState, resolveState, isRunning } from "../scrapers/states.mjs";

const ev = (over = {}) => ({
  id: "e1",
  title: "Alpha Run 2026",
  start_date: "2026-09-01",
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

const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "runhub-sync-"));
  try {
    return await fn(join(dir, "s.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const count = (dbPath, sql) => {
  const db = openDb(dbPath);
  try {
    return db.prepare(sql).get().c;
  } finally {
    db.close();
  }
};

test("TC-DB-01: sync is idempotent and records a run (AC-01, AC-02)", () =>
  withTmp(async (dbPath) => {
    const scrapers = [["howei", stub([ev(), ev({ id: "e2", title: "Beta Marathon", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/e2" }] })])]];
    await runSync({ dbPath, log: () => {}, scrapers });
    await runSync({ dbPath, log: () => {}, scrapers });
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 2);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM sync_runs"), 2);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM categories"), 2);
    const db = openDb(dbPath);
    const run = db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get();
    db.close();
    assert.ok(run.started_at && run.finished_at);
    assert.equal(run.errors, "[]", "AC-04");
  }));

test("TC-DB-03: one failing source is recorded, others still stored", () =>
  withTmp(async (dbPath) => {
    const res = await runSync({
      dbPath,
      log: () => {},
      scrapers: [["bad", boom], ["howei", stub([ev()])]],
    });
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /bad: timeout/);
    assert.deepEqual(res.portals, ["howei"]);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 1);
  }));

test("quality gate: undated and non-running events are skipped and counted", () =>
  withTmp(async (dbPath) => {
    const res = await runSync({
      dbPath,
      log: () => {},
      scrapers: [[
        "howei",
        stub([
          ev(),
          ev({ id: "u", title: "Undated Run", start_date: null, sources: [{ portal: "howei", source_url: "u" }] }),
          ev({ id: "b", title: "ASICS Badminton Championship", sources: [{ portal: "howei", source_url: "b" }] }),
        ]),
      ]],
    });
    assert.equal(res.counts.skipped_undated, 1);
    assert.equal(res.counts.skipped_not_running, 1);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 1);
  }));

test("empty source yields empty DB, no crash", () =>
  withTmp(async (dbPath) => {
    const res = await runSync({ dbPath, log: () => {}, scrapers: [["howei", stub([])]] });
    assert.equal(res.counts.unique, 0);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 0);
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
  // Regression: an allowlist dropped these live events.
  for (const title of [
    "Selmar 2026",
    "Race Against Cancer @ Wangsa Maju",
    "RUNLIGA Team Race 2027",
    "Bristwalk Madani Kita Tanjung 3km",
    "Cendol Funwalk 2.0",
  ]) {
    assert.ok(isRunning({ title }), `${title} must be kept`);
  }
});

test("isRunning drops non-running listings", () => {
  for (const title of [
    "Strategic Recruitment & AI-driven Hiring",
    "Hybrid Training Session For Fitness Races",
    "Decathlon The Waterfront Shoppes Zumba 2026",
    "Kayuhan Santai MTB Jerai Geopark 2027",
  ]) {
    assert.ok(!isRunning({ title }), `${title} must be dropped`);
  }
});

test("isRunning keeps runs, drops other sports", () => {
  assert.ok(isRunning({ title: "Twincity Marathon 2026" }));
  assert.ok(isRunning({ title: "Larian Rakan Muda" }));
  assert.ok(isRunning({ title: "G2G Paws & Purrs 5KM Fun Run" }));
  assert.ok(!isRunning({ title: "ASICS Badminton University Championship 2026" }));
});

test("pruneStale removes vanished events but spares failed portals and saved races", () =>
  withTmp(async (dbPath) => {
    const evs = (ids) =>
      ids.map((id) => ev({ id, title: `Race ${id}`, sources: [{ portal: "howei", source_url: `https://howei.com/event_details/${id}` }] }));

    // First run stores three events.
    await runSync({ dbPath, log: () => {}, scrapers: [["howei", stub(evs(["a", "b", "c"]))]] });
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 3);

    // Second run only returns "a": b and c are gone.
    const res = await runSync({ dbPath, log: () => {}, scrapers: [["howei", stub(evs(["a"]))]] });
    assert.equal(res.counts.pruned, 2);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 1);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM categories"), 1, "children are pruned too");
  }));

test("pruneStale keeps events from a portal that failed this run", () =>
  withTmp(async (dbPath) => {
    await runSync({
      dbPath,
      log: () => {},
      scrapers: [["howei", stub([ev({ id: "h1", sources: [{ portal: "howei", source_url: "h1" }] })])]],
    });
    // howei fails; jomrun succeeds and returns nothing. h1 must survive.
    const res = await runSync({
      dbPath,
      log: () => {},
      scrapers: [["howei", boom], ["jomrun", stub([])]],
    });
    assert.equal(res.counts.pruned, 0);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 1);
  }));

test("pruneStale never deletes a race saved to My Season", () =>
  withTmp(async (dbPath) => {
    await runSync({
      dbPath,
      log: () => {},
      scrapers: [["howei", stub([ev({ id: "keep", sources: [{ portal: "howei", source_url: "keep" }] })])]],
    });
    const db = openDb(dbPath);
    db.prepare("INSERT INTO my_races (event_id, my_status) VALUES (?, ?)").run("keep", "watchlist");
    db.close();

    const res = await runSync({ dbPath, log: () => {}, scrapers: [["howei", stub([])]] });
    assert.equal(res.counts.pruned, 0);
    assert.equal(count(dbPath, "SELECT COUNT(*) c FROM events"), 1);
  }));

