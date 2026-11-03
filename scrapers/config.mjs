import { readFileSync } from "node:fs";

const DEFAULTS = { concurrency: 4, timeoutMs: 20000, retries: 1, upcomingOnly: true, graceDays: 3 };
const DEFAULT_PATH = new URL("../sources.json", import.meta.url);

/**
 * Load and validate `sources.json`.
 * Returns `[{ name, type, ...merged settings }]` for every *enabled* source.
 * Throws on a malformed file so a typo is loud instead of silently dropping portals.
 */
export function loadSources(path = DEFAULT_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`sources.json: ${e.message}`);
  }
  return parseSources(raw);
}

export function parseSources(raw) {
  const defaults = { ...DEFAULTS, ...(raw.defaults ?? {}) };
  const sources = raw.sources;
  if (!sources || typeof sources !== "object") throw new Error('sources.json: missing "sources" object');

  const out = [];
  for (const [name, cfg] of Object.entries(sources)) {
    if (!cfg || typeof cfg !== "object") throw new Error(`sources.json: "${name}" must be an object`);
    if (cfg.enabled === false) continue;
    if (!cfg.baseUrl) throw new Error(`sources.json: "${name}" needs a baseUrl`);
    try {
      new URL(cfg.baseUrl);
    } catch {
      throw new Error(`sources.json: "${name}" has an invalid baseUrl "${cfg.baseUrl}"`);
    }
    // Only http(s): this file drives outbound requests.
    if (!/^https?:$/.test(new URL(cfg.baseUrl).protocol)) {
      throw new Error(`sources.json: "${name}" baseUrl must be http(s)`);
    }
    out.push({ ...defaults, ...cfg, name, type: cfg.type ?? name, baseUrl: cfg.baseUrl.replace(/\/+$/, "") });
  }
  return out;
}

/** Resolve a config path against the source's base URL. */
export const urlFor = (cfg, path) => new URL(path, cfg.baseUrl + "/").href;

/** "Upcoming" cut-off: events older than `graceDays` are skipped when `upcomingOnly` is set. */
export function cutoffDate(cfg, now = new Date()) {
  if (!cfg.upcomingOnly) return null;
  const d = new Date(now);
  d.setDate(d.getDate() - (cfg.graceDays ?? 1));
  return d.toISOString().slice(0, 10);
}

/** Drop events dated before the cut-off. Undated events pass (the sync gate handles them). */
export function keepUpcoming(events, cfg, now = new Date()) {
  const cutoff = cutoffDate(cfg, now);
  if (!cutoff) return events;
  return events.filter((e) => !e.start_date || e.start_date >= cutoff);
}
