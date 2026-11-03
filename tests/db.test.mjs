import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  saveEvent, getEvents, getEvent, saveMyRace, getMyRaces,
  recordSyncRun, lastSyncRun, archiveExpired, archiveStale,
} from "../db.mjs";
import { dedupe, normaliseTitle } from "../scrapers/normalizer.mjs";
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

const db = () => ctx.db;
const count = async (sql, params = []) => (await db().query(sql, params)).rows[0].c;

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

test("saveEvent is idempotent - re-running does not duplicate (AC-02)", { skip }, async () => {
  await saveEvent(db(), sampleEvent());
  await saveEvent(db(), sampleEvent());
  await saveEvent(db(), sampleEvent());
  assert.equal(await count("SELECT count(*)::int c FROM events"), 1);
  assert.equal(await count("SELECT count(*)::int c FROM categories"), 2);
  assert.equal(await count("SELECT count(*)::int c FROM entitlements"), 1);
});

test("saveEvent preserves first_seen_at and refreshes updated_at (AC-02)", { skip }, async () => {
  const before = await getEvent(db(), "test-race-2026");
  await saveEvent(db(), sampleEvent({ title: "Test Race 2026 - Renamed" }));
  const after = await getEvent(db(), "test-race-2026");
  assert.equal(after.title, "Test Race 2026 - Renamed");
  assert.equal(after.first_seen_at, before.first_seen_at);
  assert.ok(after.updated_at >= before.updated_at);
});

test("saveEvent replaces children instead of accumulating them", { skip }, async () => {
  await saveEvent(db(), sampleEvent({ categories: [{ distance_km: 5, label: "5km" }] }));
  assert.equal(await count("SELECT count(*)::int c FROM categories WHERE event_id = $1", ["test-race-2026"]), 1);
});

test("getEvents attaches sources; state filter narrows results (AC-05, AC-06)", { skip }, async () => {
  await saveEvent(db(), sampleEvent());
  await saveEvent(db(), sampleEvent({
    id: "penang-2026",
    title: "Penang Race",
    state: "Penang",
    categories: [],
    sources: [{ portal: "jomrun", source_url: "https://jomrun.com/event/penang" }],
  }));

  const all = await getEvents(db());
  assert.ok(all.length >= 2);
  for (const e of all) assert.ok(Array.isArray(e.sources) && e.sources.length >= 1);

  const filtered = await getEvents(db(), { state: "Penang" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "penang-2026");
});

test("getEvent nests categories, entitlements and sources (AC-07)", { skip }, async () => {
  const ev = await getEvent(db(), "test-race-2026");
  assert.ok(ev.categories.length >= 1);
  assert.equal(ev.entitlements[0].image_url, "https://x/y.jpg");
  assert.equal(ev.sources[0].portal, "racexasia");
  assert.equal(await getEvent(db(), "nope"), null);
});

test("saveEvent keeps the existing id when a source URL is already known (stable ids)", { skip }, async () => {
  await saveEvent(db(), sampleEvent({ id: "howei-slug", title: "Stable A", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/stable" }] }));
  await saveEvent(db(), sampleEvent({ id: "rx-slug", title: "Stable B", sources: [{ portal: "howei", source_url: "https://howei.com/event_details/stable" }] }));
  const rows = (await db().query("SELECT id, title FROM events WHERE title LIKE 'Stable %'")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Stable B");
});

test("race_pack / key_dates / registration_deadline persist and parse back", { skip }, async () => {
  await saveEvent(db(), sampleEvent({
    id: "pack-2026",
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/pack" }],
    race_pack: [{ date: "2026-07-30", venue: "Mall" }],
    key_dates: [{ date: "2026-08-01", title: "Event Day" }],
    registration_deadline: "31 Jul",
  }));
  const ev = await getEvent(db(), "pack-2026");
  assert.equal(ev.race_pack[0].venue, "Mall");
  assert.equal(ev.key_dates[0].title, "Event Day");
  assert.equal(ev.registration_deadline, "31 Jul");
  assert.ok(ev.last_seen_at);
});

test("my_races upserts (AC-08)", { skip }, async () => {
  await saveMyRace(db(), { event_id: "test-race-2026", my_status: "watchlist", target_time: "1:45" });
  await saveMyRace(db(), { event_id: "test-race-2026", my_status: "registered", target_time: "1:40" });
  const rows = (await getMyRaces(db())).filter((r) => r.event_id === "test-race-2026");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].my_status, "registered");
});

test("my_races rejects an unknown event id (referential integrity)", { skip }, async () => {
  await assert.rejects(saveMyRace(db(), { event_id: "does-not-exist", my_status: "watchlist" }));
});

test("sync_runs records and returns the latest run (AC-09)", { skip }, async () => {
  await recordSyncRun(db(), {
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z",
    portals: ["howei"], counts: { unique: 5 }, errors: [],
  });
  await recordSyncRun(db(), {
    startedAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T00:01:00Z",
    portals: ["howei", "jomrun"], counts: { unique: 9 }, errors: ["jomrun: timeout"],
  });
  const latest = await lastSyncRun(db());
  assert.equal(latest.started_at, "2026-01-02T00:00:00Z");
  assert.equal(JSON.parse(latest.errors).length, 1);
});

// ---------- archive: nothing is ever deleted ----------
test("archiveExpired hides old events but keeps the row and its children", { skip }, async () => {
  await saveEvent(db(), sampleEvent({
    id: "old-2020",
    start_date: "2020-01-01",
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/old" }],
  }));
  const archived = await archiveExpired(db(), { now: new Date("2026-11-10T00:00:00Z") });
  assert.ok(archived >= 1);

  const visible = await getEvents(db());
  assert.ok(!visible.some((e) => e.id === "old-2020"), "archived events are hidden by default");

  const withArchived = await getEvents(db(), { includeArchived: true });
  assert.ok(withArchived.some((e) => e.id === "old-2020"), "still in the DB");

  const ev = await getEvent(db(), "old-2020");
  assert.ok(ev.categories.length >= 1, "children survive archiving");
  assert.ok(ev.archived_at);
  assert.equal(ev.archived_reason, "date_passed");
});

test("archiveExpired keeps events inside the 7-day grace window", { skip }, async () => {
  const mk = (id, date) => sampleEvent({ id, start_date: date, sources: [{ portal: "howei", source_url: `https://howei.com/event_details/${id}` }] });
  await saveEvent(db(), mk("well-past", "2026-10-01"));
  await saveEvent(db(), mk("recent", "2026-11-09"));
  await archiveExpired(db(), { now: new Date("2026-11-10T00:00:00Z") });
  const rows = (await db().query("SELECT id, archived_at FROM events WHERE id IN ('well-past','recent') ORDER BY id")).rows;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.archived_at]));
  assert.ok(byId["well-past"], "40 days ago is archived");
  assert.equal(byId["recent"], null, "yesterday is inside the 7-day grace window");
});

test("archiveStale archives delisted events instead of deleting them", { skip }, async () => {
  await saveEvent(db(), sampleEvent({ id: "gone", sources: [{ portal: "jomrun", source_url: "https://jomrun.com/event/gone" }] }));
  const n = await archiveStale(db(), { seenIds: ["test-race-2026"], portalsRun: ["jomrun"] });
  assert.ok(n >= 1);
  const ev = await getEvent(db(), "gone");
  assert.ok(ev, "row still exists");
  assert.equal(ev.archived_reason, "delisted");
});

test("archiveStale spares events whose portal failed this run", { skip }, async () => {
  await saveEvent(db(), sampleEvent({ id: "keep-me", sources: [{ portal: "biib", source_url: "https://getbiib.com/events/keep" }] }));
  const n = await archiveStale(db(), { seenIds: [], portalsRun: ["jomrun"] });
  const ev = await getEvent(db(), "keep-me");
  assert.equal(ev.archived_at, null, "biib did not run, so its events are untouched");
  assert.equal(n, 0);
});

// ---------- normaliser ----------
test("normaliseTitle strips years and edition noise", () => {
  assert.equal(normaliseTitle("Kuala Kangsar Half Marathon 2027"), "kuala kangsar half marathon");
  assert.equal(normaliseTitle("BOOM+ Kahf Putrajaya 30km 2026"), "boom kahf putrajaya 30km");
  assert.equal(normaliseTitle("11th Edition Twincity Marathon"), "twincity marathon");
  assert.equal(normaliseTitle(""), "");
});

test("dedupe merges the same race from two portals into one (AC-05, AC-12)", () => {
  const a = sampleEvent({
    id: "rx-1", title: "Kuala Kangsar Half Marathon 2027", state: "Perak", start_date: "2027-05-02",
    sources: [{ portal: "racexasia", source_url: "https://racexasia.com/event/kkhm" }],
    categories: [{ distance_km: 21, price_normal: 95 }],
  });
  const b = sampleEvent({
    id: "hw-1", title: "Kuala Kangsar Half Marathon 2027", state: "Perak", start_date: "2027-05-02",
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/kkhm" }],
    entitlements: [], categories: [],
  });
  const merged = dedupe([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sources.length, 2, "both buy links must survive the merge");
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
  assert.equal(dedupe([a, b]).length, 1, "dates within 1 day are the same event");
});
