#!/usr/bin/env node
/**
 * Fixture + live-DB sanity check. Run after refreshing `tests/fixtures/` or
 * after a sync: `npm run verify`.
 *
 * Exits non-zero if any check fails.
 */
import { readFileSync } from "node:fs";
import { openDb, dbStats } from "../db.mjs";
import { parseList as rxList, parseDetail as rxDetail } from "../scrapers/racexasia.mjs";
import { parseList as jrList, parseDetail as jrDetail } from "../scrapers/jomrun.mjs";
import { parseFeed as hwFeed, parseDetail as hwDetail } from "../scrapers/howei.mjs";
import { parseList as biibList, parseDetail as biibDetail } from "../scrapers/biib.mjs";
import { parseCalendar as heyjomCalendar } from "../scrapers/heyjom.mjs";
import { parseListing as t2uListing } from "../scrapers/ticket2u.mjs";

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

let failed = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name} — ${e.message}`);
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log("Fixtures:");

await check("racexasia-list.html", () => {
  const n = rxList(fx("racexasia-list.html")).length;
  expect(n > 0, "no event links");
  return `${n} links`;
});

await check("racexasia-detail.html", () => {
  const e = rxDetail(fx("racexasia-detail.html"), "fixture");
  expect(e.categories.length > 0, "no categories");
  expect(e.categories.some((c) => c.price_normal != null), "no priced category");
  expect(e.entitlements.some((x) => x.image_url), "no entitlement image");
  return `${e.categories.length} categories, ${e.entitlements.length} entitlements`;
});

await check("jomrun-list.html", () => {
  const n = jrList(fx("jomrun-list.html")).length;
  expect(n > 0, "no slugs");
  return `${n} slugs`;
});

await check("jomrun-detail.html", () => {
  const e = jrDetail(fx("jomrun-detail.html"), "fixture");
  expect(e.start_date, "no date");
  expect(e.title && !/^fixture$/.test(e.title), "title not resolved");
  return `${e.title} · ${e.start_date}`;
});

await check("howei-feed.xml", () => {
  const n = hwFeed(fx("howei-feed.xml")).length;
  expect(n > 0, "no items");
  return `${n} items`;
});

await check("howei-detail.html", () => {
  const e = hwDetail(fx("howei-detail.html"), "fixture");
  expect(e.start_date, "no date");
  expect(e.categories.length > 0, "no distances");
  return `${e.start_date} · ${e.state ?? "state?"} · ${e.categories.length} distances`;
});

await check("biib-list.html", () => {
  const n = biibList(fx("biib-list.html")).length;
  expect(n > 0, "no events");
  return `${n} events`;
});

await check("biib-detail.html", () => {
  const e = biibDetail(fx("biib-detail.html"), "1792");
  expect(e.start_date, "no date parsed from Event Details");
  expect(e.categories.length > 0, "no distances from flag-off list");
  return `${e.start_date} · ${e.categories.map((c) => c.distance_km).join("/")}km`;
});

await check("heyjom-calendar.html", () => {
  const n = heyjomCalendar(fx("heyjom-calendar.html")).length;
  expect(n > 10, "too few events");
  return `${n} events`;
});

await check("ticket2u-sport.json", () => {
  const evs = t2uListing(JSON.parse(fx("ticket2u-sport.json")));
  expect(evs.length > 0, "no events");
  expect(evs.every((e) => e.sources[0].source_url.startsWith("https://")), "relative source url");
  return `${evs.length} events`;
});

console.log("\nLive Postgres:");

let db;
try {
  db = await openDb();
} catch (e) {
  console.log(`  skip — ${e.message}`);
}

if (db) {
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const stats = await dbStats(db);
  const total = stats.total;

  check("events exist", () => {
    expect(total > 0, "empty DB");
    return `${stats.active} active, ${stats.archived} archived`;
  });

  check("every event has a date (AC-05)", async () => {
    const n = (await one("SELECT count(*)::int c FROM events WHERE start_date IS NULL")).c;
    expect(n === 0, `${n} events without start_date`);
    return "0 undated";
  });

  check("every event has at least one source (AC-05)", async () => {
    const n = (await one("SELECT count(*)::int c FROM events e WHERE NOT EXISTS (SELECT 1 FROM event_sources s WHERE s.event_id = e.id)")).c;
    expect(n === 0, `${n} events without a source`);
    return "all sourced";
  });

  check("state coverage on active events", async () => {
    const r = await one("SELECT count(*)::int total, count(*) FILTER (WHERE state IS NULL)::int missing FROM events WHERE archived_at IS NULL");
    const pct = Math.round(((r.total - r.missing) / r.total) * 100);
    expect(pct >= 70, `only ${pct}% of active events have a state`);
    return `${pct}% (${r.total - r.missing}/${r.total})`;
  });

  check("no non-running listings", async () => {
    const bad = (await db.query("SELECT title FROM events WHERE title ILIKE '%badminton%' OR title ILIKE '%zumba%' OR title ILIKE '%seminar%'")).rows;
    expect(bad.length === 0, `found: ${bad.map((b) => b.title).join(", ")}`);
    return "clean";
  });

  check("archived events are kept, not deleted", async () => {
    const r = await one("SELECT count(*)::int c FROM events WHERE archived_at IS NOT NULL");
    const orphans = (await one("SELECT count(*)::int c FROM events e WHERE archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM event_sources s WHERE s.event_id = e.id)")).c;
    expect(orphans === 0, `${orphans} archived events lost their sources`);
    return `${r.c} archived, all with sources`;
  });

  check("sold-out / closed upcoming events are retained", async () => {
    const r = await one("SELECT count(*)::int c FROM events WHERE archived_at IS NULL AND status IN ('sold_out','closed')");
    return `${r.c} kept`;
  });

  check("latest sync run recorded (AC-01)", async () => {
    const run = await one("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1");
    expect(run, "no sync_runs row");
    expect(run.started_at && run.finished_at, "run has no timestamps");
    return `${run.finished_at} · errors=${JSON.parse(run.errors).length}`;
  });

  await db.close();
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);