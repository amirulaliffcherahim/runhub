import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server.mjs";
import { openDb, saveEvent, recordSyncRun } from "../db.mjs";

const dir = mkdtempSync(join(tmpdir(), "runhub-api-"));
const dbPath = join(dir, "api.db");

// Seed before the server opens the same file.
{
  const db = openDb(dbPath);
  saveEvent(db, {
    id: "api-race-2026",
    title: "API Race 2026",
    organizer: "Tester",
    start_date: "2026-08-01",
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
  saveEvent(db, {
    id: "api-penang-2026",
    title: "Penang Race 2026",
    start_date: "2026-09-01",
    state: "Penang",
    status: "open",
    categories: [],
    entitlements: [],
    sources: [{ portal: "jomrun", source_url: "https://jomrun.com/event/b" }],
  });
  recordSyncRun(db, {
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    portals: ["racexasia"],
    counts: { unique: 2 },
    errors: [],
  });
  db.close();
}

const server = createApp({ dbPath });
let base;

test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeDb?.();
  server.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const get = (p) => fetch(base + p);

test("GET /api/events returns shape with sources (AC-05)", async () => {
  const res = await get("/api/events");
  assert.equal(res.status, 200);
  const events = await res.json();
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.ok(e.id && e.title && e.start_date && e.state);
    assert.ok(Array.isArray(e.sources) && e.sources.length >= 1);
  }
});

test("GET /api/events includes categories and entitlements for list-view filtering (AC-11)", async () => {
  const events = await (await get("/api/events")).json();
  const race = events.find((e) => e.id === "api-race-2026");
  assert.equal(race.categories.length, 1);
  assert.equal(race.categories[0].distance_km, 21);
  assert.equal(race.entitlements[0].kind, "finisher_tee");
  assert.equal(race.categories[0].event_id, undefined, "internal key must not leak");
});

test("GET /api/events?state= filters (AC-06)", async () => {
  const events = await (await get("/api/events?state=Selangor")).json();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "api-race-2026");
});

test("GET /api/events/:id nests children (AC-07)", async () => {
  const ev = await (await get("/api/events/api-race-2026")).json();
  assert.equal(ev.categories.length, 1);
  assert.equal(ev.entitlements[0].kind, "finisher_tee");
  assert.equal(ev.sources.length, 2, "both buy links must be exposed");

  const missing = await get("/api/events/nope");
  assert.equal(missing.status, 404);
});

test("POST then GET /api/my-races (AC-08)", async () => {
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
});

test("GET /api/sync/status returns the latest run (AC-09)", async () => {
  const run = await (await get("/api/sync/status")).json();
  assert.equal(run.started_at, "2026-01-01T00:00:00Z");
  assert.equal(JSON.parse(run.counts).unique, 2);
});

test("unknown api route returns 404", async () => {
  assert.equal((await get("/api/nope")).status, 404);
});

test("GET /api/my-races joins the event so the planner can render", async () => {
  const rows = await (await get("/api/my-races")).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "API Race 2026");
  assert.ok(Array.isArray(rows[0].categories));
  assert.ok(rows[0].sources.length >= 1);
});

test("GET /api/sync/status exposes a running flag", async () => {
  const s = await (await get("/api/sync/status")).json();
  assert.equal(s.running, false);
});

test("malformed JSON body returns 400, not 500", async () => {
  const res = await fetch(`${base}/api/my-races`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("static path traversal is refused", async () => {
  for (const p of ["/../db.mjs", "/..%2fdb.mjs", "/%2e%2e/%2e%2e/package.json"]) {
    const res = await get(p);
    assert.notEqual(res.status, 200, `${p} must not be served`);
  }
});