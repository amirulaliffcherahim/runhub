import { openDb } from "../db.mjs";

const db = openDb("data/runhub.db");
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);

console.log("events:      ", one("SELECT COUNT(*) c FROM events").c);
console.log("sources:     ", one("SELECT COUNT(*) c FROM event_sources").c);
console.log("categories:  ", one("SELECT COUNT(*) c FROM categories").c);
console.log("entitlements:", one("SELECT COUNT(*) c FROM entitlements").c);
console.log("with date:   ", one("SELECT COUNT(*) c FROM events WHERE start_date IS NOT NULL").c);
console.log("with state:  ", one("SELECT COUNT(*) c FROM events WHERE state IS NOT NULL").c);
console.log("multi-source:", one("SELECT COUNT(*) c FROM (SELECT event_id FROM event_sources GROUP BY event_id HAVING COUNT(*) > 1)").c);
console.log("\nportals:", all("SELECT portal, COUNT(*) n FROM event_sources GROUP BY portal ORDER BY n DESC"));
console.log("\nsample rows:");
for (const e of all("SELECT id,title,start_date,state FROM events WHERE start_date IS NOT NULL ORDER BY start_date LIMIT 8")) {
  console.log(" ", e.start_date, "|", e.state ?? "-", "|", e.title.slice(0, 52));
}
const tee = one("SELECT COUNT(*) c FROM entitlements WHERE image_url IS NOT NULL AND image_url != ''");
console.log("\nentitlement images:", tee.c);
console.log("categories with price:", one("SELECT COUNT(*) c FROM categories WHERE price_normal > 0").c);
console.log("\nlast sync:", one("SELECT started_at, finished_at, counts, errors FROM sync_runs ORDER BY id DESC LIMIT 1"));
db.close();
