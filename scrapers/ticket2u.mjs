import { toIso } from "./dates.mjs";

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

export async function scrapeTicket2U() {
  // The shared fetchWithRetry is GET-only; the listing needs a POST.
  const body = JSON.stringify({ method: "eventlisting", data: { cc: "sport", stateid: "" } });
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`ticket2u api: ${res.status}`);
      const json = await res.json();
      if (json.haserror) throw new Error(`ticket2u api: ${json.message ?? "error"}`);
      return { portal: "ticket2u", events: parseListing(json), errors: [] };
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(lastError?.message ?? "ticket2u: unknown error");
}
