import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server.mjs";
import { openDb, saveEvent, recordSyncRun } from "../db.mjs";

// Playwright is a dev dependency; skip the suite rather than fail when the
// browser binary has not been installed on this machine.
let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

const dir = mkdtempSync(join(tmpdir(), "runhub-ui-"));
const dbPath = join(dir, "ui.db");

{
  const db = openDb(dbPath);
  saveEvent(db, {
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
  saveEvent(db, {
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
  recordSyncRun(db, {
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: new Date().toISOString(),
    portals: ["racexasia"],
    counts: { unique: 2, categories: 3 },
    errors: [],
  });
  db.close();
}

const server = createApp({ dbPath });
let base;
let browser;

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  if (chromium) browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server.closeDb?.();
  server.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const skip = () => (chromium ? false : "playwright browser not installed");

test("TC-UI-01: grid renders from the API, filters change the count, drawer shows entitlements (AC-10..12)", { skip: skip() }, async () => {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });

  // AC-10: cards come from /api/events, not a hardcoded array.
  await page.waitForSelector(".card");
  assert.equal(await page.locator(".card").count(), 2);
  assert.match(await page.locator("#count").textContent(), /2 of 2/);

  // AC-11: state filter narrows the result count.
  await page.selectOption("#stateSel", "Penang");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  assert.match(await page.locator("#count").textContent(), /1 of 2/);

  // Distance filter: 42K must exclude the 5km fun run.
  await page.selectOption("#stateSel", "ALL");
  await page.click('#distChips button[data-dist="42"]');
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  assert.match(await page.locator(".card h4").first().textContent(), /Standard Chartered/);

  // Search box.
  await page.click('#distChips button[data-dist="ALL"]');
  await page.fill("#q", "penang");
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 1);
  await page.fill("#q", "");

  // AC-12: drawer shows price table, entitlement images and every buy link.
  await page.click('.card[data-id="klscm-2026"]');
  await page.waitForSelector("#drawer .sect");
  const drawer = page.locator("#drawer");

  assert.equal(await drawer.locator(".buy").count(), 2, "both portals must be offered");
  assert.match(await drawer.textContent(), /RM120/, "normal price for the 21km tier");
  assert.match(await drawer.textContent(), /RM160/, "normal price for the 42km tier");
  assert.equal(await drawer.locator(".shot img").count(), 2, "tee + medal images");
  assert.match(await drawer.textContent(), /Mid Valley/, "race pack collection");

  await page.click("#closeDrawer");
  await page.waitForSelector("#scrim.open", { state: "detached" }).catch(() => {});
  await page.close();
});

test("TC-UI-02: Sync now shows progress, My Season persists via the API (AC-13, AC-14)", { skip: skip() }, async () => {
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

  // Unstar removes it server-side too.
  await page.click("#closeSeason");
  await page.click('.card[data-id="penang-2026"] .star');
  await page.waitForFunction(() => document.querySelector("#seasonBadge").textContent === "0");
  assert.equal((await (await fetch(`${base}/api/my-races`)).json()).length, 0);

  await page.close();
});

test("empty DB shows the empty state, not a crash (AC-10 boundary)", { skip: skip() }, async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "runhub-empty-"));
  const emptyServer = createApp({ dbPath: join(emptyDir, "e.db") });
  await new Promise((r) => emptyServer.listen(0, "127.0.0.1", r));
  const emptyBase = `http://127.0.0.1:${emptyServer.address().port}`;

  const page = await browser.newPage();
  await page.goto(emptyBase, { waitUntil: "networkidle" });
  await page.waitForSelector("#emptyDb:not([hidden])");
  assert.equal(await page.locator(".card").count(), 0);

  await page.close();
  emptyServer.closeDb?.();
  emptyServer.close();
  rmSync(emptyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
