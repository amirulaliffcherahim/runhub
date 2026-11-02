#!/usr/bin/env node
/**
 * Daily sync: run every enabled scraper, dedupe, persist, record the run.
 *
 * Design rule: one portal failing never aborts the run. Failures land in
 * `sync_runs.errors` and every other portal still commits.
 */
import { openDb, saveEvent, recordSyncRun, pruneStale } from "./db.mjs";
import { pathToFileURL } from "node:url";
import { dedupe } from "./scrapers/normalizer.mjs";
import { resolveState, isRunning } from "./scrapers/states.mjs";
import { scrapeRaceXasia } from "./scrapers/racexasia.mjs";
import { scrapeJomRun } from "./scrapers/jomrun.mjs";
import { scrapeHowei } from "./scrapers/howei.mjs";
import { scrapeBiib } from "./scrapers/biib.mjs";
import { scrapeHeyJom } from "./scrapers/heyjom.mjs";
import { scrapeTicket2U } from "./scrapers/ticket2u.mjs";

export const SCRAPERS = [
  ["racexasia", scrapeRaceXasia],
  ["jomrun", scrapeJomRun],
  ["howei", scrapeHowei],
  ["biib", scrapeBiib],
  ["heyjom", scrapeHeyJom],
  ["ticket2u", scrapeTicket2U],
];

export async function runSync({ dbPath, log = console.log, scrapers = SCRAPERS } = {}) {
  const db = openDb(dbPath);
  const startedAt = new Date().toISOString();

  const errors = [];
  const portalsRun = [];
  const collected = [];

  for (const [name, fn] of scrapers) {
    const t0 = Date.now();
    try {
      const res = await fn();
      collected.push(...res.events);
      errors.push(...(res.errors ?? []));
      portalsRun.push(name);
      log(`  ${name}: ${res.events.length} events (${Date.now() - t0}ms)`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      log(`  ${name}: FAILED - ${e.message}`);
    }
  }

  // Quality gate (BUILD_PLAN 7 boundary rules): canonical state first (dedupe uses it),
  // drop non-running listings and undated events, but count what was dropped.
  let skippedNotRunning = 0;
  let skippedUndated = 0;
  const usable = [];
  for (const ev of collected) {
    if (!isRunning(ev)) { skippedNotRunning++; continue; }
    if (!ev.start_date) { skippedUndated++; continue; }
    ev.state = resolveState(ev);
    usable.push(ev);
  }

  const merged = dedupe(usable);
  const savedIds = [];
  for (const ev of merged) {
    try {
      saveEvent(db, ev);
      savedIds.push(ev.id);
    } catch (e) {
      errors.push(`save ${ev.id}: ${e.message}`);
    }
  }

  // Remove events that vanished from the portals (e.g. a listing that is no
  // longer a running event). Portals that failed this run are exempt.
  let pruned = 0;
  try {
    pruned = pruneStale(db, { seenIds: savedIds, portalsRun });
  } catch (e) {
    errors.push(`prune: ${e.message}`);
  }

  const counts = {
    scraped: collected.length,
    unique: merged.length,
    pruned,
    skipped_undated: skippedUndated,
    skipped_not_running: skippedNotRunning,
    categories: merged.reduce((n, e) => n + (e.categories?.length ?? 0), 0),
    entitlements: merged.reduce((n, e) => n + (e.entitlements?.length ?? 0), 0),
  };

  const finishedAt = new Date().toISOString();
  recordSyncRun(db, { startedAt, finishedAt, portals: portalsRun, counts, errors });
  db.close();

  log(
    `sync done: ${counts.scraped} scraped -> ${counts.unique} unique, ` +
      `${counts.categories} categories, ${counts.entitlements} entitlements, ${errors.length} errors`
  );

  return { counts, errors, portals: portalsRun, startedAt, finishedAt, failedPortals: scrapers.length - portalsRun.length };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  console.log(`[${new Date().toISOString()}] RunHub sync starting`);
  runSync()
    .then(({ portals }) => {
      // Partial success is normal (per-detail 404s land in sync_runs.errors).
      // Exit non-zero only if no portal succeeded at all.
      process.exit(portals.length === 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error("sync failed:", e);
      process.exit(1);
    });
}
