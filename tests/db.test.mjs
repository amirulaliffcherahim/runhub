import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, saveEvent, getEvents, getEvent, saveMyRace, getMyRaces, recordSyncRun, lastSyncRun } from "../db.mjs";
import { dedupe, normaliseTitle } from "../scrapers/normalizer.mjs";

const withDb = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "runhub-"));
  const db = openDb(join(dir, "t.db"));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const sampleEvent = (over = {}) => ({
  id: "test-race-2026",
  title: "Test Race 2026",
  organizer: "Tester",
  start_date: "2026-08-01",
  end_date: "2026-08-01",
  state: "Selangor",
  venue: "Dataran",
  description: "A race",
  status: "open",
  banner_url: null,
  categories: [
    { distance_km: 21, label: "21km", price_early: 100, price_normal: 160, status: "open" },
    { distance_km: 10, label: "10km", price_early: 80, price_normal: 100, status: "open" },
  ],
  entitlements: [{ kind: "finisher_tee", title: "Finisher Tee", image_url: "https://x/y.jpg" }],
  sources: [{ portal: "racexasia", source_url: "https://racexasia.com/event/x" }],
  ...over,
});

test("saveEvent is idempotent - re-running does not duplicate (AC-02)", () =>
  withDb((db) => {
    saveEvent(db, sampleEvent());
    saveEvent(db, sampleEvent());
    saveEvent(db, sampleEvent());

    assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM categories").get().c, 2);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM entitlements").get().c, 1);
  }));

test("saveEvent preserves first_seen_at and refreshes updated_at (AC-02)", () =>
  withDb((db) => {
    saveEvent(db, sampleEvent());
    const first = db.prepare("SELECT first_seen_at, updated_at FROM events").get();
    saveEvent(db, sampleEvent({ title: "Test Race 2026 - Renamed" }));
    const second = db.prepare("SELECT title, first_seen_at, updated_at FROM events").get();

    assert.equal(second.title, "Test Race 2026 - Renamed");
    assert.equal(second.first_seen_at, first.first_seen_at);
    assert.ok(second.updated_at >= first.updated_at);
  }));

test("saveEvent replaces children instead of accumulating them", () =>
  withDb((db) => {
    saveEvent(db, sampleEvent());
    saveEvent(db, sampleEvent({ categories: [{ distance_km: 5, label: "5km" }] }));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM categories").get().c, 1);
  }));

test("getEvents attaches sources; state filter narrows results (AC-05, AC-06)", () =>
  withDb((db) => {
    saveEvent(db, sampleEvent());
    saveEvent(db, sampleEvent({ id: "penang-2026", state: "Penang", categories: [], sources: [{ portal: "jomrun", source_url: "https://jomrun.com/event/penang" }] }));

    const all = getEvents(db);
    assert.equal(all.length, 2);
    for (const e of all) assert.ok(Array.isArray(e.sources) && e.sources.length >= 1);

    const filtered = getEvents(db, { state: "Penang" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "penang-2026");
  }));

test("getEvent nests categories, entitlements and sources (AC-07)", () =>
  withDb((db) => {
    saveEvent(db, sampleEvent());
    const ev = getEvent(db, "test-race-2026");
    assert.equal(ev.categories.length, 2);
    assert.equal(ev.entitlements.length, 1);
    assert.equal(ev.entitlements[0].image_url, "https://x/y.jpg");
    assert.equal(ev.sources[0].portal, "racexasia");
    assert.equal(getEvent(db, "nope"), null);
  }));

test("my_races upserts (AC-08)", () =>
  withDb((db) => {
    assert.deepEqual(getMyRaces(db), []);
    saveEvent(db, sampleEvent());
    saveMyRace(db, { event_id: "test-race-2026", my_status: "watchlist", target_time: "1:45" });
    saveMyRace(db, { event_id: "test-race-2026", my_status: "registered", target_time: "1:40" });
    const rows = getMyRaces(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].my_status, "registered");
    assert.equal(rows[0].target_time, "1:40");
  }));

test("my_races rejects an unknown event id (referential integrity)", () =>
  withDb((db) => {
    assert.throws(() => saveMyRace(db, { event_id: "does-not-exist", my_status: "watchlist" }));
  }));

test("sync_runs records and returns the latest run (AC-09)", () =>
  withDb((db) => {
    assert.equal(lastSyncRun(db), null);
    recordSyncRun(db, {
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:01:00Z",
      portals: ["howei"],
      counts: { unique: 5 },
      errors: [],
    });
    recordSyncRun(db, {
      startedAt: "2026-01-02T00:00:00Z",
      finishedAt: "2026-01-02T00:01:00Z",
      portals: ["howei", "jomrun"],
      counts: { unique: 9 },
      errors: ["jomrun: timeout"],
    });
    const latest = lastSyncRun(db);
    assert.equal(latest.started_at, "2026-01-02T00:00:00Z");
    assert.equal(JSON.parse(latest.errors).length, 1);
  }));

test("normaliseTitle strips years and edition noise", () => {
  assert.equal(normaliseTitle("Kuala Kangsar Half Marathon 2027"), "kuala kangsar half marathon");
  assert.equal(normaliseTitle("BOOM+ Kahf Putrajaya 30km 2026"), "boom kahf putrajaya 30km");
  assert.equal(normaliseTitle("11th Edition Twincity Marathon"), "twincity marathon");
  assert.equal(normaliseTitle(""), "");
});

test("dedupe merges the same race from two portals into one (AC-05, AC-12)", () => {
  const a = sampleEvent({
    id: "rx-1",
    title: "Kuala Kangsar Half Marathon 2027",
    state: "Perak",
    start_date: "2027-05-02",
    sources: [{ portal: "racexasia", source_url: "https://racexasia.com/event/kkhm" }],
    categories: [{ distance_km: 21, price_normal: 95 }],
  });
  const b = sampleEvent({
    id: "hw-1",
    title: "Kuala Kangsar Half Marathon 2027",
    state: "Perak",
    start_date: "2027-05-02",
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/kkhm" }],
    entitlements: [],
    categories: [],
  });

  const merged = dedupe([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sources.length, 2, "both buy links must survive the merge");
  assert.deepEqual(
    merged[0].sources.map((s) => s.portal).sort(),
    ["howei", "racexasia"]
  );
  assert.equal(merged[0].id, "rx-1", "richer portal wins the id");
});

test("dedupe keeps genuinely different races apart", () => {
  const a = sampleEvent({ id: "a", title: "Penang Bridge Marathon 2026", state: "Penang", start_date: "2026-12-13" });
  const b = sampleEvent({ id: "b", title: "Borneo Marathon 2026", state: "Sabah", start_date: "2026-04-26" });
  assert.equal(dedupe([a, b]).length, 2);
});

test("dedupe does not merge same name in different states on far-apart dates", () => {
  const a = sampleEvent({ id: "a", title: "New Year Run 2027", state: "Perak", start_date: "2027-01-01" });
  const b = sampleEvent({ id: "b", title: "New Year Run 2027", state: "Kedah", start_date: "2027-06-01" });
  assert.equal(dedupe([a, b]).length, 2);
});

test("dedupe tolerates duplicate rows within one portal", () => {
  const a = sampleEvent({ id: "x", title: "Same Race 2026", state: "KL", start_date: "2026-03-01" });
  const b = sampleEvent({ id: "y", title: "Same Race 2026", state: "KL", start_date: "2026-03-02" });
  const merged = dedupe([a, b]);
  assert.equal(merged.length, 1, "dates within 1 day are the same event");
});

test("saveEvent keeps the existing id when a source URL is already known (stable ids)", () =>
  withDb((db) => {
    saveEvent(db, sampleEvent({ id: "howei-slug" }));
    saveEvent(db, sampleEvent({ id: "rx-slug", title: "Renamed" }));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 1);
    assert.equal(db.prepare("SELECT title FROM events").get().title, "Renamed");
  }));

test("race_pack / key_dates / registration_deadline persist and parse back", () =>
  withDb((db) => {
    saveEvent(db, sampleEvent({
      race_pack: [{ date: "2026-07-30", venue: "Mall" }],
      key_dates: [{ date: "2026-08-01", title: "Event Day" }],
      registration_deadline: "31 Jul",
    }));
    const ev = getEvent(db, "test-race-2026");
    assert.equal(ev.race_pack[0].venue, "Mall");
    assert.equal(ev.key_dates[0].title, "Event Day");
    assert.equal(ev.registration_deadline, "31 Jul");
    assert.ok(ev.last_seen_at);
  }));

