import { toIso } from "./dates.mjs";
import { fetchJson } from "./fetch.mjs";
import { urlFor } from "./config.mjs";

const BASE = "https://www.ticket2u.com.my";
const API = `${BASE}/api/api2.ashx`;

/**
 * Ticket2U's listing is a Vue SPA, but the data behind it is a plain JSON POST
 * (`{"method":"eventlisting","data":{"cc":"sport","stateid":""}}`). No browser
 * needed. Each row carries link, name, datefrom, statename, locname, pricefrom.
 */
export function parseListing(json) {
  const rows = json?.data ?? [];
  const events = [];

  for (const { row } of rows) {
    if (!row?.name || !row?.link) continue;
    const price = Number.parseFloat(row.pricefrom);
    events.push({
      id: `t2u-${row.id}`.toLowerCase(),
      title: row.name,
      organizer: null,
      start_date: toIso(row.datefrom) ?? toIso(row.datefrom106),
      end_date: toIso(row.dateto) ?? null,
      state: row.statename || null,
      venue: row.locname || null,
      description: row.excerpt || null,
      status: row.status === "expired" ? "closed" : "open",
      banner_url: row.avatar || null,
      categories:
        Number.isFinite(price) && price > 0
          ? [
              {
                distance_km: null,
                label: row.eventsubcat || "Entry",
                price_early: null,
                price_normal: price,
                price_note: `from RM${price.toFixed(2)}`,
                cutoff_time: null,
                flag_off_time: row.time || null,
                status: "open",
              },
            ]
          : [],
      entitlements: [],
      // `link` is absolute in the browser but relative over plain HTTP.
      sources: [{ portal: "ticket2u", source_url: new URL(row.link, BASE + "/").href }],
    });
  }
  return events;
}

export async function scrapeTicket2U(cfg = {}) {
  const c = {
    baseUrl: BASE,
    apiPath: "/api/api2.ashx",
    categories: [{ cc: "sport", scc: "running" }, { cc: "sport", scc: "marathon" }],
    maxPages: 70,
    stopAfterExpiredPages: 3,
    timeoutMs: 15000,
    retries: 1,
    ...cfg,
  };
  const errors = [];
  const byId = new Map();
  const api = urlFor(c, c.apiPath);

  // Each category list is ordered newest-first with `status` upcoming|expired.
  // Page until `stopAfterExpiredPages` consecutive pages hold no upcoming event.
  for (const cat of c.categories) {
    let expiredRun = 0;
    for (let page = 1; page <= c.maxPages; page++) {
      const res = await fetchJson(api, c.retries, {
        timeoutMs: c.timeoutMs,
        body: { method: "eventlisting", data: { ...cat, stateid: "", currentpage: page } },
      });
      if (res.status !== 200 || !res.json) {
        if (page === 1 && byId.size === 0) throw new Error(`ticket2u api: ${res.status}`);
        errors.push(`ticket2u ${cat.scc ?? cat.cc} page ${page}: ${res.status}`);
        break;
      }
      if (res.json.haserror) throw new Error(`ticket2u api: ${res.json.message ?? "error"}`);

      const rows = res.json.data ?? [];
      if (!rows.length) break;

      const upcoming = rows.filter(({ row }) => row?.status !== "expired").length;
      for (const ev of parseListing(res.json)) if (!byId.has(ev.id)) byId.set(ev.id, ev);

      expiredRun = upcoming === 0 ? expiredRun + 1 : 0;
      if (expiredRun >= c.stopAfterExpiredPages) break;
    }
  }

  return { portal: "ticket2u", events: [...byId.values()], errors };
}