import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../server.mjs";
import { saveEvent, recordSyncRun } from "../db.mjs";
import { tempDb, pgAvailable } from "./helpers.mjs";

const available = await pgAvailable();
const skip = available ? false : "Postgres not reachable (set DATABASE_URL)";

let ctx;
let server;
let base;

before(async () => {
  if (!available) return;
  ctx = await tempDb();

  await saveEvent(ctx.db, {
    id: "api-race-2026",
    title: "API Race 2026",
    organizer: "Tester",
    start_date: "2099-08-01",
    state: "Selangor",
    venue: "Dataran",
    status: "open",
    categories: [{ distance_km: 21, label: "21km", price_normal: 160 }],
    entitlements: [{ kind: "finisher_tee", title: "Finisher Tee", image_url: "https://x/y.jpg" }],
    sources: [
      { portal: "racexasia", source_url: "https://racexasia.com/event/a" },
      { portal: "howei", source_url: "https://howei.com/event_details/a" },
    ],
  });
  await saveEvent(ctx.db, {
    id: "api-penang-2026",
    title: "Penang Race 2026",
    start_date: "2099-09-01",
    state: "Penang",
    status: "sold_out",
    categories: [],
    entitlements: [],
    sources: [{ portal: "jomrun", source_url: "https://jomrun.com/event/b" }],
  });
  await saveEvent(ctx.db, {
    id: "api-old-2020",
    title: "Old Race 2020",
    start_date: "2020-01-01",
    state: "Perak",
    status: "closed",
    categories: [],
    entitlements: [],
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/old" }],
  });
  await ctx.db.query("UPDATE events SET archived_at = '2026-01-01T00:00:00Z', archived_reason = 'date_passed' WHERE id = 'api-old-2020'");
  await recordSyncRun(ctx.db, {
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    portals: ["racexasia"],
    counts: { unique: 2 },
    errors: [],
  });

  server = await createApp({ db: ctx.db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!available) return;
  server.close();
  await ctx.cleanup();
});

const get = (p) => fetch(base + p);

test("GET /api/events returns shape with sources (AC-05)", { skip }, async () => {
  const res = await get("/api/events");
  assert.equal(res.status, 200);
  const events = await res.json();
  assert.equal(events.length, 2, "archived events are not returned");
  for (const e of events) {
    assert.ok(e.id && e.title && e.start_date && e.state);
    assert.ok(Array.isArray(e.sources) && e.sources.length >= 1);
  }
});

test("GET /api/events?archived=1 includes the archive", { skip }, async () => {
  const events = await (await get("/api/events?archived=1")).json();
  assert.equal(events.length, 3);
  assert.ok(events.some((e) => e.id === "api-old-2020"));
});

test("GET /api/events includes categories and entitlements for list-view filtering (AC-11)", { skip }, async () => {
  const events = await (await get("/api/events")).json();
  const race = events.find((e) => e.id === "api-race-2026");
  assert.equal(race.categories.length, 1);
  assert.equal(race.categories[0].distance_km, 21);
  assert.equal(race.entitlements[0].kind, "finisher_tee");
  assert.equal(race.categories[0].event_id, undefined, "internal key must not leak");
});

test("sold-out upcoming events are returned, with their status (never hidden)", { skip }, async () => {
  const events = await (await get("/api/events")).json();
  const penang = events.find((e) => e.id === "api-penang-2026");
  assert.ok(penang, "a sold-out event must still be listed");
  assert.equal(penang.status, "sold_out");
});

test("GET /api/events?state= filters (AC-06)", { skip }, async () => {
  const events = await (await get("/api/events?state=Selangor")).json();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "api-race-2026");
});

test("GET /api/events/:id nests children (AC-07)", { skip }, async () => {
  const ev = await (await get("/api/events/api-race-2026")).json();
  assert.equal(ev.categories.length, 1);
  assert.equal(ev.entitlements[0].kind, "finisher_tee");
  assert.equal(ev.sources.length, 2, "both buy links must be exposed");

  assert.equal((await get("/api/events/nope")).status, 404);
});

test("an archived event is still readable by id", { skip }, async () => {
  const ev = await (await get("/api/events/api-old-2020")).json();
  assert.equal(ev.id, "api-old-2020");
  assert.equal(ev.archived_reason, "date_passed");
});

test("POST then GET /api/my-races (AC-08)", { skip }, async () => {
  assert.deepEqual(await (await get("/api/my-races")).json(), []);

  const post = await fetch(`${base}/api/my-races`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: "api-race-2026", my_status: "watchlist", target_time: "1:45" }),
  });
  assert.equal(post.status, 201);

  const rows = await (await get("/api/my-races")).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].my_status, "watchlist");

  const bad = await fetch(`${base}/api/my-races`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ my_status: "watchlist" }),
  });
  assert.equal(bad.status, 400, "missing event_id is rejected");

  const unknown = await fetch(`${base}/api/my-races`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_id: "nope" }),
  });
  assert.equal(unknown.status, 400, "unknown event_id is rejected");
});

test("GET /api/my-races joins the event so the planner can render", { skip }, async () => {
  const rows = await (await get("/api/my-races")).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "API Race 2026");
  assert.ok(Array.isArray(rows[0].categories));
  assert.ok(rows[0].sources.length >= 1);
});

test("GET /api/sync/status returns the latest run, a running flag and DB stats (AC-09)", { skip }, async () => {
  const run = await (await get("/api/sync/status")).json();
  assert.equal(run.started_at, "2026-01-01T00:00:00Z");
  assert.equal(JSON.parse(run.counts).unique, 2);
  assert.equal(run.running, false);
  assert.equal(run.stats.total, 3);
  assert.equal(run.stats.active, 2);
  assert.equal(run.stats.archived, 1);
});

test("malformed JSON body returns 400, not 500", { skip }, async () => {
  const res = await fetch(`${base}/api/my-races`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("static path traversal is refused", { skip }, async () => {
  for (const p of ["/../db.mjs", "/..%2fdb.mjs", "/%2e%2e/%2e%2e/package.json"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
});

test("unknown api route returns 404", { skip }, async () => {
  assert.equal((await get("/api/nope")).status, 404);
});
