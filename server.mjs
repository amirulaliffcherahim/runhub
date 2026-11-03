import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  openDb,
  getEvents,
  getEvent,
  getMyRaces,
  saveMyRace,
  deleteMyRace,
  lastSyncRun,
  recentSyncRuns,
  dbStats,
} from "./db.mjs";
import { runSync } from "./sync.mjs";

const PORT = Number(process.env.PORT ?? 3300);
// Single-user app: never expose the API beyond this machine / Tailscale.
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC = resolve(new URL("./public/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

export async function createApp({ dbPath, db: existing } = {}) {
  const db = existing ?? (await openDb({ connectionString: dbPath }));
  let syncing = null;

  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error("invalid JSON body");
      err.status = 400;
      throw err;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      // ---- API ----
      if (path === "/api/events" && req.method === "GET") {
        const events = await getEvents(db, {
          state: url.searchParams.get("state") || undefined,
          includeArchived: url.searchParams.get("archived") === "1",
        });
        return json(res, 200, events);
      }

      if (path.startsWith("/api/events/") && req.method === "GET") {
        const ev = await getEvent(db, decodeURIComponent(path.slice("/api/events/".length)));
        return ev ? json(res, 200, ev) : json(res, 404, { error: "not found" });
      }

      if (path === "/api/my-races" && req.method === "GET") {
        // Join the event so the Season planner renders without a second round-trip.
        const rows = await getMyRaces(db);
        const out = [];
        for (const r of rows) {
          const ev = await getEvent(db, r.event_id);
          out.push({
            ...r,
            title: ev?.title ?? null,
            start_date: ev?.start_date ?? null,
            state: ev?.state ?? null,
            archived: Boolean(ev?.archived_at),
            categories: ev?.categories ?? [],
            sources: ev?.sources ?? [],
          });
        }
        return json(res, 200, out);
      }

      if (path === "/api/my-races" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.event_id) return json(res, 400, { error: "event_id required" });
        if (!(await getEvent(db, body.event_id))) return json(res, 400, { error: "unknown event_id" });
        await saveMyRace(db, body);
        return json(res, 201, { ok: true });
      }

      if (path === "/api/my-races" && req.method === "DELETE") {
        const id = url.searchParams.get("event_id");
        if (!id) return json(res, 400, { error: "event_id required" });
        await deleteMyRace(db, id);
        return json(res, 200, { ok: true });
      }

      if (path === "/api/sync/status" && req.method === "GET") {
        const [run, stats] = await Promise.all([lastSyncRun(db), dbStats(db)]);
        return json(res, 200, { ...(run ?? {}), running: Boolean(syncing), stats });
      }

      // Recent runs with per-portal results: the "check on the backend" endpoint.
      if (path === "/api/sync/runs" && req.method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 50);
        return json(res, 200, await recentSyncRuns(db, limit));
      }

      if (path === "/api/sync/run" && req.method === "POST") {
        if (syncing) return json(res, 409, { error: "sync already running" });
        syncing = runSync({ db, log: () => {} })
          .then((r) => ({ ok: true, ...r }))
          .catch((e) => ({ ok: false, error: e.message }))
          .finally(() => {
            syncing = null;
          });
        return json(res, 202, { started: true });
      }

      // ---- static ----
      if (req.method === "GET") {
        const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
        const file = resolve(join(PUBLIC, rel));
        // Reject anything that escapes public/ (path traversal).
        if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) {
          return json(res, 404, { error: "not found" });
        }
        try {
          const buf = await readFile(file);
          res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
          return res.end(buf);
        } catch {
          return json(res, 404, { error: "not found" });
        }
      }

      json(res, 405, { error: "method not allowed" });
    } catch (e) {
      json(res, e.status ?? 500, { error: e.message });
    }
  });

  server.closeDb = () => db.close();
  return server;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  createApp().then((app) => {
    app.listen(PORT, HOST, () => {
      console.log(`RunHub on http://${HOST}:${PORT}`);
    });
  });
}
