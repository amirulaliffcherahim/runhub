import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseList as rxList, parseDetail as rxDetail } from "../scrapers/racexasia.mjs";
import { parseList as jrList, parseDetail as jrDetail } from "../scrapers/jomrun.mjs";
import {
  parseList as hwList,
  parseFeed as hwFeed,
  parseDetail as hwDetail,
} from "../scrapers/howei.mjs";
import { parseList as biibList, parseDetail as biibDetail } from "../scrapers/biib.mjs";
import { parseCalendar as heyjomCalendar } from "../scrapers/heyjom.mjs";
import { parseListing as t2uListing } from "../scrapers/ticket2u.mjs";
import { toIso } from "../scrapers/dates.mjs";

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// ---------- dates ----------
test("toIso handles Malaysian portal date shapes", () => {
  assert.equal(toIso("2nd May 2027"), "2027-05-02");
  assert.equal(toIso("24 October 2026"), "2026-10-24");
  assert.equal(toIso("2026-06-16"), "2026-06-16");
  assert.equal(toIso("29 November, 2026"), "2026-11-29");
  assert.equal(toIso("24 - 25 October 2026"), "2026-10-25");
  assert.equal(toIso("17 – 18 January 2026"), "2026-01-18");
  assert.equal(toIso("garbage"), null);
  assert.equal(toIso(null), null);
});

// ---------- RaceXasia (AC-03) ----------
test("racexasia: list yields unique slugs", () => {
  const slugs = rxList(fx("racexasia-list.html"));
  assert.ok(slugs.length >= 10, `expected >=10 slugs, got ${slugs.length}`);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("racexasia: detail has 21km category with a price (AC-03)", () => {
  const ev = rxDetail(fx("racexasia-detail.html"), "sharp-hsnkl-half-marathon-2026-hsnm26");
  const half = ev.categories.find((c) => c.distance_km === 21);
  assert.ok(half, "expected a 21km category");
  assert.equal(typeof half.price_normal, "number");
  assert.ok(half.price_normal > 0);
  assert.ok(half.price_early > 0);
  assert.ok(half.label.length > 0);
});

test("racexasia: detail has finisher_tee entitlement with an image URL (AC-03)", () => {
  const ev = rxDetail(fx("racexasia-detail.html"), "sharp-hsnkl-half-marathon-2026-hsnm26");
  const tee = ev.entitlements.find((e) => /tee/i.test(e.title));
  assert.ok(tee, `expected a tee entitlement, got ${ev.entitlements.map((e) => e.title)}`);
  assert.match(tee.image_url, /^https:\/\//);
});

test("racexasia: detail records key dates and a source URL", () => {
  const ev = rxDetail(fx("racexasia-detail.html"), "sharp-hsnkl-half-marathon-2026-hsnm26");
  assert.equal(ev.start_date, "2026-10-25");
  assert.ok(ev.key_dates.length >= 3);
  assert.equal(ev.sources[0].portal, "racexasia");
  assert.match(ev.sources[0].source_url, /^https:\/\//);
});

// ---------- JomRun ----------
test("jomrun: list yields unique slugs", () => {
  const slugs = jrList(fx("jomrun-list.html"));
  assert.ok(slugs.length >= 10, `expected >=10 slugs, got ${slugs.length}`);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("jomrun: detail extracts date, venue and distances", () => {
  const ev = jrDetail(fx("jomrun-detail.html"), "IIB20-Medini-Run-2026");
  assert.equal(ev.start_date, "2026-11-29");
  assert.ok(ev.venue && ev.venue.length > 0);
  assert.deepEqual(
    ev.categories.map((c) => c.distance_km),
    [5, 10]
  );
  assert.ok(ev.description.includes("Ultron"), "entitlement text should mention the jersey brand");
});

test("jomrun: detail captures fee image and named entitlements", () => {
  const ev = jrDetail(fx("jomrun-detail.html"), "IIB20-Medini-Run-2026");
  const fee = ev.entitlements.find((e) => e.kind === "fee_table");
  assert.ok(fee, "expected a fee_table entitlement");
  assert.match(fee.image_url, /jomrun-images-new\/fee\//);
  assert.ok(
    ev.entitlements.some((e) => e.kind === "event_tee"),
    "expected the jersey to be classified as event_tee"
  );
  assert.ok(ev.entitlements.some((e) => e.kind === "medal"), "expected the medal");
});

// ---------- Howei ----------
test("howei: list + feed yield clean slugs (no full URLs)", () => {
  const fromList = hwList(fx("howei-detail.html").replace(/^/, "")); // detail page also links related events
  const fromFeed = hwFeed(fx("howei-feed.xml"));
  assert.ok(fromFeed.length >= 10, `feed should yield >=10 slugs, got ${fromFeed.length}`);
  for (const s of [...fromList, ...fromFeed]) {
    assert.doesNotMatch(s, /https?:|\//, `slug must be bare, got ${s}`);
  }
});

test("howei: detail extracts date, state, distances and price range", () => {
  const ev = hwDetail(fx("howei-detail.html"), "kualakangsarhalfmarathon2027");
  assert.equal(ev.start_date, "2027-05-02");
  assert.equal(ev.state, "Perak");
  assert.deepEqual(
    ev.categories.map((c) => c.distance_km),
    [5, 10, 21]
  );
  assert.equal(ev.categories[0].price_early, 35);
  assert.equal(ev.categories[0].price_normal, 95);
  assert.ok(ev.venue && ev.venue.includes("Kangsar"));
});

test("howei: detail captures t-shirt images", () => {
  const ev = hwDetail(fx("howei-detail.html"), "kualakangsarhalfmarathon2027");
  assert.ok(ev.entitlements.length > 0, "expected t-shirt/medal images");
  for (const e of ev.entitlements) assert.match(e.image_url, /^https:\/\//);
});

// ---------- BiiB ----------
test("biib: list yields events with ids and banners", () => {
  const list = biibList(fx("biib-list.html"));
  assert.ok(list.length >= 10, `expected >=10 events, got ${list.length}`);
  for (const e of list) {
    assert.match(e.id, /^biib-\d+$/);
    assert.ok(e.title.length > 0);
    assert.match(e.banner_url, /^https:\/\//);
  }
});

test("biib: detail uses og tags", () => {
  const ev = biibDetail(fx("biib-detail.html"), "1792");
  assert.equal(ev.title, "Kuching Half Marathon Heritage Run 2027");
  assert.ok(ev.banner_url.includes("Heritage"));
  assert.equal(ev.sources[0].source_url, "https://getbiib.com/events/1792");
});

// ---------- HeyJom ----------
test("heyjom: calendar JSON yields many events with state + date", () => {
  const events = heyjomCalendar(fx("heyjom-calendar.html"));
  assert.ok(events.length >= 30, `expected >=30 events, got ${events.length}`);
  const withState = events.filter((e) => e.state);
  assert.ok(withState.length > 10);
  const withDate = events.filter((e) => e.start_date);
  assert.ok(withDate.length > 10);
  for (const e of events) {
    assert.ok(e.id.startsWith("heyjom-"));
    assert.ok(e.title.length > 0);
  }
});

test("biib: detail extracts date, venue and distances from Event Details", () => {
  const e = biibDetail(fx("biib-detail.html"), "1792");
  assert.equal(e.start_date, "2027-04-18");
  assert.match(e.venue, /Padungan/);
  assert.deepEqual(e.categories.map((c) => c.distance_km), [5, 10, 21.1]);
});

test("jomrun: title comes from og:title, not the slug", () => {
  assert.equal(jrDetail(fx("jomrun-detail.html"), "iib20-medini-run-2026").title, "IIB20 Medini Run 2026");
});


test("ticket2u: listing JSON maps to events with date, state and price", () => {
  const events = t2uListing(JSON.parse(fx("ticket2u-sport.json")));
  assert.ok(events.length >= 10);
  const run = events.find((e) => /RUN TO SAVE LIVES/i.test(e.title));
  assert.ok(run, "expected a running event in the sport listing");
  assert.match(run.start_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(run.state);
  assert.ok(run.sources[0].source_url.startsWith("https://www.ticket2u.com.my/event/"));
  const priced = events.filter((e) => e.categories.length > 0);
  assert.ok(priced.length > 0 && priced[0].categories[0].price_normal > 0);
});

