import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../server.mjs";
import { saveEvent, recordSyncRun } from "../db.mjs";
import { tempDb, pgAvailable } from "./helpers.mjs";

// Playwright is a dev dependency; skip rather than fail when no browser is installed.
let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

const pgOk = await pgAvailable();
const skip = !pgOk ? "Postgres not reachable" : !chromium ? "playwright browser not installed" : false;

let ctx;
let server;
let base;
let browser;

before(async () => {
  if (skip) return;
  ctx = await tempDb();

  await saveEvent(ctx.db, {
    id: "klscm-2026",
    title: "Kuala Lumpur Standard Chartered Marathon 2026",
    organizer: "Dirigo",
    start_date: "2099-09-27",
    state: "Kuala Lumpur",
    venue: "Dataran Merdeka",
    status: "open",
    description: "ASICS race tee for all finishers",
    banner_url: null,
    categories: [
      { distance_km: 42, label: "Full Marathon", price_early: 120, price_normal: 160 },
      { distance_km: 21, label: "Half Marathon", price_early: 90, price_normal: 120 },
    ],
    entitlements: [
      { kind: "finisher_tee", title: "Finisher Tee", image_url: "https://example.test/tee.jpg" },
      { kind: "medal", title: "Finisher Medal", image_url: "https://example.test/medal.jpg" },
    ],
    race_pack: [{ date: "2099-09-24", time: "10:00", venue: "Mid Valley" }],
    sources: [
      { portal: "racexasia", source_url: "https://racexasia.com/event/klscm" },
      { portal: "howei", source_url: "https://howei.com/event_details/klscm" },
    ],
  });
  await saveEvent(ctx.db, {
    id: "penang-2026",
    title: "Penang Bridge Fun Run 2026",
    start_date: "2099-11-15",
    state: "Penang",
    venue: "Queensbay",
    status: "open",
    categories: [{ distance_km: 5, label: "5km Fun Run", price_normal: 40 }],
    entitlements: [],
    sources: [{ portal: "jomrun", source_url: "https://jomrun.com/event/penang" }],
  });
  // A sold-out upcoming race and an archived past race.
  await saveEvent(ctx.db, {
    id: "soldout-2026",
    title: "Sold Out Skyline Run 2026",
    start_date: "2099-12-01",
    state: "Selangor",
    status: "sold_out",
    categories: [{ distance_km: 10, label: "10km", price_normal: 60 }],
    entitlements: [],
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/soldout" }],
  });
  await saveEvent(ctx.db, {
    id: "archived-2020",
    title: "Archived Old Race 2020",
    start_date: "2020-01-01",
    state: "Perak",
    status: "closed",
    categories: [],
    entitlements: [],
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/archived" }],
  });
  await ctx.db.query("UPDATE events SET archived_at = '2026-01-01T00:00:00Z', archived_reason = 'date_passed' WHERE id = 'archived-2020'");

  await recordSyncRun(ctx.db, {
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: new Date().toISOString(),
    portals: ["racexasia"],
    counts: { unique: 3, categories: 4 },
    errors: [],
  });

  server = await createApp({ db: ctx.db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (server) server.close();
  await ctx?.cleanup();
});

test("TC-UI-01: grid renders from the API, filters change the count, drawer shows entitlements (AC-10..12)", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });

  // AC-10: cards come from /api/events, not a hardcoded array. Archived rows are hidden.
  await page.waitForSelector(".card");
  assert.equal(await page.locator(".card").count(), 3);
  assert.match(await page.locator("#count").textContent(), /3 of 3/);

  // AC-11: state filter narrows the result count.
  await page.selectOption("#stateSel", "Penang");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  assert.match(await page.locator("#count").textContent(), /1 of 3/);

  // Distance filter: 42K must exclude the 5km fun run.
  await page.selectOption("#stateSel", "ALL");
  await page.click('#distChips button[data-dist="42"]');
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  assert.match(await page.locator(".card h4").first().textContent(), /Standard Chartered/);

  // Availability filter surfaces the sold-out race.
  await page.click('#distChips button[data-dist="ALL"]');
  await page.click('#availChips button[data-avail="sold_out"]');
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  assert.match(await page.locator(".card h4").first().textContent(), /Sold Out Skyline/);
  assert.ok(await page.locator(".card .tag.soldout").count(), "sold-out badge is visible");
  await page.click('#availChips button[data-avail="ALL"]');

  // Search box.
  await page.fill("#q", "penang");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  await page.fill("#q", "");

  // AC-12: drawer shows price table, entitlement images and every buy link.
  await page.click('.card[data-id="klscm-2026"]');
  await page.waitForSelector("#drawer .sect");
  const drawer = page.locator("#drawer");
  assert.equal(await drawer.locator(".checkout").count(), 2, "both portals must be offered in the checkout bar");
  assert.match(await drawer.textContent(), /RM120/, "normal price for the 21km tier");
  assert.match(await drawer.textContent(), /RM160/, "normal price for the 42km tier");
  assert.equal(await drawer.locator(".shot img").count(), 2, "tee + medal images");
  assert.match(await drawer.textContent(), /Mid Valley/, "race pack collection");

  await page.close();
});

test("archive is hidden by default and shown on request (nothing is deleted)", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");
  assert.equal(await page.locator('.card[data-id="archived-2020"]').count(), 0);

  await page.check("#showArchived");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 4);
  assert.equal(await page.locator('.card[data-id="archived-2020"]').count(), 1);
  assert.ok(await page.locator('.card[data-id="archived-2020"] .tag.closed').count(), "Archived badge");

  await page.close();
});

test("TC-UI-02: sync status and My Season persist via the API (AC-13, AC-14)", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");

  // AC-13: the pill reflects the last sync, computed from /api/sync/status.
  assert.match(await page.locator("#syncText").textContent(), /Synced \d+s ago/);

  // AC-14: star -> saved server-side -> survives a reload.
  await page.click('.card[data-id="penang-2026"] .star');
  await page.waitForFunction(() => document.querySelector("#seasonBadge").textContent === "1");

  const saved = await (await fetch(`${base}/api/my-races`)).json();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].event_id, "penang-2026");

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".card");
  assert.equal(await page.locator("#seasonBadge").textContent(), "1", "season survives reload");
  assert.ok(await page.locator('.card[data-id="penang-2026"] .star.on').count());

  // Season planner renders the joined event data and computes pace.
  await page.click("#seasonBtn");
  await page.waitForSelector(".season-item");
  assert.match(await page.locator(".season-item").textContent(), /Penang Bridge Fun Run/);

  // Goal time is h:mm, so 0:25 over 5km is 5:00/km.
  await page.fill('.season-item input[data-field="target_time"]', "0:25");
  await page.locator('.season-item input[data-field="target_time"]').blur();
  await page.waitForSelector(".pace");
  assert.match(await page.locator(".pace").textContent(), /5:00 \/km/, "0:25 over 5km is 5:00/km");

  await page.click("#closeSeason");
  await page.click('.card[data-id="penang-2026"] .star');
  await page.waitForFunction(() => document.querySelector("#seasonBadge").textContent === "0");
  assert.equal((await (await fetch(`${base}/api/my-races`)).json()).length, 0);

  await page.close();
});

test("empty DB shows the empty state, not a crash (AC-10 boundary)", { skip }, async () => {
  const empty = await tempDb();
  const emptyServer = await createApp({ db: empty.db });
  await new Promise((r) => emptyServer.listen(0, "127.0.0.1", r));
  const emptyBase = `http://127.0.0.1:${emptyServer.address().port}`;

  const page = await browser.newPage();
  await page.goto(emptyBase, { waitUntil: "networkidle" });
  await page.waitForSelector("#emptyDb:not([hidden])");
  assert.equal(await page.locator(".card").count(), 0);

  await page.close();
  emptyServer.close();
  await empty.cleanup();
});

test("cards answer price and kit questions without opening the drawer (Z5)", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");

  // Distance chip carries the cheapest normal price for that distance.
  const klscm = page.locator('.card[data-id="klscm-2026"]');
  const chips = await klscm.locator(".dist").allTextContents();
  assert.ok(chips.some((c) => /21K/.test(c) && /RM120/.test(c)), `21K chip shows its price: ${chips.join(" | ")}`);
  assert.ok(chips.some((c) => /42K/.test(c) && /RM160/.test(c)), `42K chip shows its price: ${chips.join(" | ")}`);

  // Kit thumbnails render on the card (tee + medal seeded for this event).
  assert.equal(await klscm.locator(".kit img").count(), 2);

  await page.close();
});

test("early-bird badge appears only while the cut-off is in the future (Z5)", { skip }, async () => {
  // Seed one event with a future early-bird date and one in the past.
  const { saveEvent } = await import("../db.mjs");
  await saveEvent(ctx.db, {
    id: "eb-future", title: "Future Early Bird Run 2099", start_date: "2099-06-01", state: "Selangor", status: "open",
    categories: [{ distance_km: 10, label: "10km", price_early: 50, price_normal: 70, early_bird_ends: "2099-03-01" }],
    entitlements: [], sources: [{ portal: "howei", source_url: "https://howei.com/event_details/ebf" }],
  });
  await saveEvent(ctx.db, {
    id: "eb-past", title: "Past Early Bird Run 2099", start_date: "2099-08-01", state: "Selangor", status: "open",
    categories: [{ distance_km: 10, label: "10km", price_early: 50, price_normal: 70, early_bird_ends: "2020-01-01" }],
    entitlements: [], sources: [{ portal: "howei", source_url: "https://howei.com/event_details/ebp" }],
  });

  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector('.card[data-id="eb-future"]');

  const future = await page.locator('.card[data-id="eb-future"] .tag.eb').allTextContents();
  assert.equal(future.length, 1, "future cut-off shows a badge");
  assert.match(future[0], /Early bird ends in \d+d/);
  assert.equal(await page.locator('.card[data-id="eb-past"] .tag.eb').count(), 0, "expired cut-off shows nothing");

  await page.close();
});

test("drawer: categories matrix shows cut-off, needed pace, min age and finisher tee (Z6)", { skip }, async () => {
  const { saveEvent } = await import("../db.mjs");
  await saveEvent(ctx.db, {
    id: "matrix-2026", title: "Matrix Half Marathon 2099", start_date: "2099-07-01", state: "Selangor",
    status: "open", venue: "Dataran Merdeka",
    categories: [
      { distance_km: 21.1, label: "21.1KM Competitive", price_early: 90, price_normal: 120, flag_off_time: "4:00am", cutoff_time: "4 hours", min_age: 18, finisher_tee: true },
      { distance_km: 5, label: "5KM Fun Run", price_normal: 50, flag_off_time: "6:30am", cutoff_time: "1 hour", min_age: 7, finisher_tee: false },
    ],
    entitlements: [
      { kind: "event_tee", title: "Event Tee", image_url: "https://example.test/tee.jpg" },
      { kind: "size_chart", title: "Size Chart", image_url: "https://example.test/size.jpg" },
    ],
    race_pack: [{ date: "2099-06-28", time: "10:00am - 6:00pm", venue: "Mid Valley" }],
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/matrix" }],
  });

  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.click('.card[data-id="matrix-2026"]');
  await page.waitForSelector("#drawer .sect");
  const text = await page.locator("#drawer").textContent();

  assert.match(text, /4 hours/, "cut-off column");
  assert.match(text, /11:22\/km|11:23\/km/, "needed pace for 21.1km in 4h");
  assert.match(text, /18\+ yrs/, "min age");
  assert.match(text, /finisher tee/i, "finisher tee marker");
  assert.doesNotMatch(await page.locator("#drawer").textContent(), /finisher tee.*5KM/s, "5KM has no finisher tee");

  // Kit is grouped by kind.
  assert.ok(await page.locator("#drawer .kitgroup").count() >= 2, "tee and size chart groups");

  // Race pack has map deep links.
  assert.ok(await page.locator("#drawer .maplink").count() >= 2, "Maps + Waze");

  // Checkout bar offers the selling portal with a price.
  const checkout = await page.locator("#drawer .checkout").allTextContents();
  assert.ok(checkout.some((c) => /Checkout on howei/.test(c) && /RM50/.test(c)), `checkout bar: ${checkout.join(" | ")}`);

  await page.close();
});

test("drawer: kit image opens a lightbox and Escape closes it (Z6)", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.click('.card[data-id="matrix-2026"]');
  await page.waitForSelector("#drawer .shot a[data-zoom]");
  await page.click("#drawer .shot a[data-zoom]");
  await page.waitForSelector("#lightbox.open");
  assert.match(await page.locator("#lightboxImg").getAttribute("src"), /example\.test/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#lightbox").classList.contains("open"));
  assert.ok(await page.locator("#scrim.open").count(), "drawer stays open under the lightbox");
  await page.close();
});

test("a clashing race shows a warning badge on its card (Z8)", { skip }, async () => {
  const { saveEvent, saveMyRace } = await import("../db.mjs");
  await saveEvent(ctx.db, {
    id: "saved-race", title: "Saved Spring HM 2099", start_date: "2099-04-10", state: "Selangor", status: "open",
    categories: [{ distance_km: 21 }], entitlements: [],
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/saved" }],
  });
  await saveMyRace(ctx.db, { event_id: "saved-race", my_status: "registered" });
  await saveEvent(ctx.db, {
    id: "clashing-race", title: "Clashing Spring Run 2099", start_date: "2099-04-11", state: "Selangor", status: "open",
    categories: [{ distance_km: 10 }], entitlements: [],
    sources: [{ portal: "howei", source_url: "https://howei.com/event_details/clash" }],
  });

  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector('.card[data-id="clashing-race"]');
  const badge = await page.locator('.card[data-id="clashing-race"] .tag.clash').allTextContents();
  assert.equal(badge.length, 1);
  assert.match(badge[0], /Clashes with Saved Spring HM 2099/);
  await page.close();
});

test("drawer shows your projected finish against the cut-off (Z7)", { skip }, async () => {
  await fetch(`${base}/api/profile`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shirt_size: "M", chest_cm: 96, paces: { "21": "6:00" } }),
  });

  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });
  await page.click('.card[data-id="matrix-2026"]');
  await page.waitForSelector("#drawer .sect");
  const text = await page.locator("#drawer").textContent();

  // 21.1km at 6:00/km = 2:07 -> inside the 4 hour cut-off.
  assert.match(text, /~2:07/, "projected finish for the half");
  assert.match(text, /Your saved size/, "profile size shown next to the kit");
  assert.match(text, /M/, "the saved size value");
  await page.close();
});
