import { openDb, dbStats } from "../db.mjs";

const db = await openDb();
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const all = async (sql, p) => (await db.query(sql, p)).rows;

console.log("stats:       ", await dbStats(db));
console.log("sources:     ", (await one("SELECT count(*)::int c FROM event_sources")).c);
console.log("categories:  ", (await one("SELECT count(*)::int c FROM categories")).c);
console.log("entitlements:", (await one("SELECT count(*)::int c FROM entitlements")).c);
console.log("with date:   ", (await one("SELECT count(*)::int c FROM events WHERE start_date IS NOT NULL")).c);
console.log("with state:  ", (await one("SELECT count(*)::int c FROM events WHERE state IS NOT NULL")).c);
console.log(
  "multi-source:",
  (await one("SELECT count(*)::int c FROM (SELECT event_id FROM event_sources GROUP BY event_id HAVING count(*) > 1) t")).c
);
console.log("\nby status:", await all("SELECT status, count(*)::int n FROM events GROUP BY status ORDER BY n DESC"));
console.log("archived: ", await all("SELECT archived_reason, count(*)::int n FROM events WHERE archived_at IS NOT NULL GROUP BY 1"));
console.log("\nportals:", await all("SELECT portal, count(*)::int n FROM event_sources GROUP BY portal ORDER BY n DESC"));
console.log("\nsample rows:");
for (const e of await all("SELECT id, title, start_date, state FROM events WHERE archived_at IS NULL ORDER BY start_date NULLS LAST LIMIT 8")) {
  console.log(" ", e.start_date ?? "   ?    ", "|", (e.state ?? "-").padEnd(15), "|", e.title.slice(0, 52));
}
console.log("\nentitlement images:", (await one("SELECT count(*)::int c FROM entitlements WHERE image_url IS NOT NULL AND image_url <> ''")).c);
console.log("categories with price:", (await one("SELECT count(*)::int c FROM categories WHERE price_normal > 0")).c);
console.log("\nlast sync:", await one("SELECT started_at, finished_at, counts, errors FROM sync_runs ORDER BY id DESC LIMIT 1"));
await db.close();
