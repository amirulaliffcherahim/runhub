#!/usr/bin/env node
/**
 * Daily sync: run every enabled scraper, dedupe, persist, archive, record the run.
 *
 * Design rules:
 *  - One portal failing never aborts the run. Failures land in `sync_runs.errors`.
 *  - Nothing is ever deleted. Events that pass their date (+ grace days) or vanish
 *    from a portal are archived: still in Postgres, hidden from the API/UI.
 *  - An event is only archived as "delisted" when *every* portal that listed it ran
 *    successfully this sync. A source that is disabled or failed therefore protects its
 *    own events (e.g. AI-crawler events carry portal "ai"; if that source is off, they are
 *    left alone). `events.origin` records who found an event first and is informational.
 */
import { pathToFileURL } from "node:url";
import {
  openDb, saveEvent, archiveExpired, archiveStale,
  startSyncRun, recordPortalRun, finishSyncRun,
} from "./db.mjs";
import { dedupe } from "./scrapers/normalizer.mjs";
import { resolveState, isRunning } from "./scrapers/states.mjs";
import { scrapeRaceXasia } from "./scrapers/racexasia.mjs";
import { scrapeJomRun } from "./scrapers/jomrun.mjs";
import { scrapeHowei } from "./scrapers/howei.mjs";
import { scrapeBiib } from "./scrapers/biib.mjs";
import { scrapeHeyJom } from "./scrapers/heyjom.mjs";
import { scrapeTicket2U } from "./scrapers/ticket2u.mjs";
import { scrapeLesgo } from "./scrapers/lesgo.mjs";
import { scrapeAi } from "./scrapers/ai.mjs";
import { loadSources, loadPoliteness } from "./scrapers/config.mjs";
import { configurePoliteness, POLITENESS } from "./scrapers/fetch.mjs";
import { configureThrottle, throttleReport } from "./scrapers/throttle.mjs";

/** `type` in sources.json -> scraper. An unknown type is reported, never ignored. */
export const REGISTRY = {
  racexasia: scrapeRaceXasia,
  jomrun: scrapeJomRun,
  howei: scrapeHowei,
  biib: scrapeBiib,
  heyjom: scrapeHeyJom,
  ticket2u: scrapeTicket2U,
  lesgo: scrapeLesgo,
  ai: scrapeAi,
};

/** Build `[name, fn]` pairs from sources.json; each scraper gets its own config. */
export function buildScrapers(sources = loadSources()) {
  return sources.map((cfg) => {
    const fn = REGISTRY[cfg.type];
    if (!fn) {
      return [cfg.name, async () => { throw new Error(`unknown source type "${cfg.type}" (see sources.json)`); }];
    }
    return [cfg.name, () => fn(cfg)];
  });
}

export async function runSync({ db, dbPath, log = console.log, quiet = false, scrapers = buildScrapers(), skipArchive = false } = {}) {
  const ownDb = !db;
  const conn = db ?? (await openDb({ connectionString: dbPath }));
  const startedAt = new Date().toISOString();
  const say = quiet ? () => {} : log;
  // A run row is opened immediately, so a silent run is inspectable while it happens.
  const runId = await startSyncRun(conn, { startedAt, portals: scrapers.map(([n]) => n) });

  // Be a good citizen: robots.txt + per-host rate limits, configured in sources.json.
  const politeness = loadPoliteness();
  configurePoliteness(politeness);
  configureThrottle({ maxRequests: politeness.maxRequestsPerSync ?? POLITENESS.maxRequestsPerSync });

  const errors = [];
  const portalsRun = [];
  const collected = [];

  try {
    for (const [name, fn] of scrapers) {
      const t0 = Date.now();
      const portalStarted = new Date().toISOString();
      try {
        const res = await fn();
        collected.push(...res.events);
        errors.push(...(res.errors ?? []));
        portalsRun.push(name);
        say(`  ${name}: ${res.events.length} events (${Date.now() - t0}ms)`);
        await recordPortalRun(conn, runId, name, {
          startedAt: portalStarted,
          finishedAt: new Date().toISOString(),
          events: res.events.length,
          errors: res.errors ?? [],
          status: (res.errors ?? []).length ? "partial" : "ok",
        });
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
        say(`  ${name}: FAILED - ${e.message}`);
        await recordPortalRun(conn, runId, name, {
          startedAt: portalStarted,
          finishedAt: new Date().toISOString(),
          events: 0,
          errors: [e.message],
          status: "failed",
        });
      }
    }

    const perPortal = {};
    for (const ev of collected) {
      const p = ev.sources?.[0]?.portal ?? "?";
      perPortal[p] = (perPortal[p] ?? 0) + 1;
    }

    // Quality gate: canonical state first (dedupe uses it), drop non-running listings
    // and undated events, but count what was dropped.
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
        savedIds.push(await saveEvent(conn, ev));
      } catch (e) {
        errors.push(`save ${ev.id}: ${e.message}`);
      }
    }

    // Nothing is deleted: stale rows are archived (kept in Postgres, hidden from the UI).
    let archivedDate = 0;
    let archivedStale = 0;
    if (!skipArchive) {
      try {
        archivedDate = await archiveExpired(conn);
      } catch (e) {
        errors.push(`archive date: ${e.message}`);
      }
      try {
        archivedStale = await archiveStale(conn, { seenIds: savedIds, portalsRun });
      } catch (e) {
        errors.push(`archive stale: ${e.message}`);
      }
    }

    const http = throttleReport();
    say(`  http: ${http.requests} requests across ${http.hosts} hosts in ${http.seconds}s`);

    const counts = {
      http_requests: http.requests,
      scraped: collected.length,
      per_portal: perPortal,
      unique: merged.length,
      archived_date: archivedDate,
      archived_stale: archivedStale,
      skipped_undated: skippedUndated,
      skipped_not_running: skippedNotRunning,
      categories: merged.reduce((n, e) => n + (e.categories?.length ?? 0), 0),
      entitlements: merged.reduce((n, e) => n + (e.entitlements?.length ?? 0), 0),
    };

    const finishedAt = new Date().toISOString();
    const status = portalsRun.length === 0 ? "failed" : errors.length ? "partial" : "ok";
    await finishSyncRun(conn, runId, { finishedAt, portals: portalsRun, counts, errors, status });

    say(
      `sync done: ${counts.scraped} scraped -> ${counts.unique} unique, ` +
        `${counts.categories} categories, ${counts.entitlements} entitlements, ` +
        `${archivedDate} archived (date), ${archivedStale} archived (delisted), ${errors.length} errors`
    );

    return { runId, status, counts, errors, portals: portalsRun, startedAt, finishedAt };
  } catch (e) {
    // Never leave a run stuck on "running": record the crash, then rethrow.
    await finishSyncRun(conn, runId, {
      portals: portalsRun,
      counts: {},
      errors: [...errors, e.message],
      status: "failed",
    }).catch(() => {});
    throw e;
  } finally {
    if (ownDb) await conn.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  // --quiet: no console output; the run is recorded in Postgres (sync_runs + sync_portal_runs).
  const quiet = process.argv.includes("--quiet");
  if (!quiet) console.log(`[${new Date().toISOString()}] RunHub sync starting`);
  runSync({ quiet })
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
