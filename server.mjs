import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  openDb,
  getEvents,
  getEvent,
  getMyRaces,
  saveMyRace,
  lastSyncRun,
} from "./db.mjs";
import { runSync } from "./sync.mjs";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT ?? 3300);
// Single-user local app: never expose the API beyond this machine.
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

export function createApp({ dbPath } = {}) {
  const db = openDb(dbPath);
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

  return createServer(async (req, res) => {    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      // ---- API ----
      if (path === "/api/events" && req.method === "GET") {
        return json(res, 200, getEvents(db, { state: url.searchParams.get("state") || undefined }));
      }

      if (path.startsWith("/api/events/") && req.method === "GET") {
        const ev = getEvent(db, decodeURIComponent(path.slice("/api/events/".length)));
        return ev ? json(res, 200, ev) : json(res, 404, { error: "not found" });
      }

      if (path === "/api/my-races" && req.method === "GET") {
        // Join the event so the Season planner renders without a second round-trip.
        const rows = getMyRaces(db).map((r) => {
          const ev = getEvent(db, r.event_id);
          return {
            ...r,
            title: ev?.title ?? null,
            start_date: ev?.start_date ?? null,
            state: ev?.state ?? null,
            categories: ev?.categories ?? [],
            sources: ev?.sources ?? [],
          };
        });
        return json(res, 200, rows);
      }

      if (path === "/api/my-races" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.event_id) return json(res, 400, { error: "event_id required" });
        saveMyRace(db, body);
        return json(res, 201, { ok: true });
      }

      if (path === "/api/my-races" && req.method === "DELETE") {
        const id = url.searchParams.get("event_id");
        if (!id) return json(res, 400, { error: "event_id required" });
        db.prepare("DELETE FROM my_races WHERE event_id = ?").run(id);
        return json(res, 200, { ok: true });
      }

      if (path === "/api/sync/status" && req.method === "GET") {
        return json(res, 200, { ...(lastSyncRun(db) ?? {}), running: Boolean(syncing) });
      }

      if (path === "/api/sync/run" && req.method === "POST") {
        if (syncing) return json(res, 409, { error: "sync already running" });
        syncing = runSync({ dbPath, log: () => {} })
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
  }).on("listening", function () {
    // Expose the handle so tests/callers can close the SQLite file cleanly.
    this.closeDb = () => db.close();
  });
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  createApp().listen(PORT, HOST, () => {
    console.log(`RunHub on http://${HOST}:${PORT}`);
  });
}
