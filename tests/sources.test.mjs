import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseSources, loadSources, urlFor, cutoffDate, keepUpcoming } from "../scrapers/config.mjs";
import { pmap, settle } from "../scrapers/pool.mjs";
import { parseDescription, mapEvent } from "../scrapers/lesgo.mjs";
import { parseCalendar as howeiCalendar } from "../scrapers/howei.mjs";
import { buildScrapers, REGISTRY } from "../sync.mjs";

// ---------- sources.json ----------
test("the shipped sources.json parses and every enabled source has a known scraper", () => {
  const sources = loadSources();
  assert.ok(sources.length >= 6);
  for (const s of sources) {
    assert.ok(REGISTRY[s.type], `${s.name}: no scraper for type "${s.type}"`);
    assert.match(s.baseUrl, /^https:\/\//);
    assert.ok(!s.baseUrl.endsWith("/"), "trailing slash is trimmed");
  }
});

test("enabled:false sources are skipped; defaults are merged; type defaults to the key", () => {
  const out = parseSources({
    defaults: { concurrency: 9 },
    sources: {
      a: { baseUrl: "https://a.example/" },
      b: { enabled: false, baseUrl: "https://b.example" },
      c: { type: "jomrun", baseUrl: "https://c.example", concurrency: 2 },
    },
  });
  assert.deepEqual(out.map((s) => s.name), ["a", "c"]);
  assert.equal(out[0].concurrency, 9);
  assert.equal(out[0].type, "a");
  assert.equal(out[0].baseUrl, "https://a.example");
  assert.equal(out[1].concurrency, 2, "per-source value overrides the default");
  assert.equal(out[1].type, "jomrun");
});

test("sources.json rejects bad input loudly", () => {
  assert.throws(() => parseSources({}), /sources/);
  assert.throws(() => parseSources({ sources: { x: {} } }), /baseUrl/);
  assert.throws(() => parseSources({ sources: { x: { baseUrl: "not a url" } } }), /invalid baseUrl/);
  assert.throws(() => parseSources({ sources: { x: { baseUrl: "file:///etc/passwd" } } }), /http/);
  assert.throws(() => parseSources({ sources: { x: { baseUrl: "javascript:alert(1)" } } }), /http|invalid/);
});

test("an unknown source type becomes a reported failure, not a silent skip", async () => {
  const [[name, fn]] = buildScrapers([{ name: "mystery", type: "nope", baseUrl: "https://x.example" }]);
  assert.equal(name, "mystery");
  await assert.rejects(fn(), /unknown source type "nope"/);
});

test("urlFor resolves paths against the base url", () => {
  const cfg = { baseUrl: "https://lesgo.my" };
  assert.equal(urlFor(cfg, "/wp-json/wp/v2/event"), "https://lesgo.my/wp-json/wp/v2/event");
  assert.equal(urlFor(cfg, "events"), "https://lesgo.my/events");
});

test("cutoffDate / keepUpcoming drop past events but keep undated ones", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  assert.equal(cutoffDate({ upcomingOnly: true, graceDays: 3 }, now), "2026-11-07");
  assert.equal(cutoffDate({ upcomingOnly: false }, now), null);
  const kept = keepUpcoming(
    [{ start_date: "2026-11-01" }, { start_date: "2026-11-09" }, { start_date: null }],
    { upcomingOnly: true, graceDays: 3 },
    now
  ).map((e) => e.start_date);
  assert.deepEqual(kept, ["2026-11-09", null]);
});

// ---------- pool ----------
test("pmap bounds concurrency, preserves order and isolates failures", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const results = await pmap(
    items,
    async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 4) throw new Error("boom");
      return n * 10;
    },
    3
  );
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
  assert.deepEqual(results.filter((r) => r.ok).map((r) => r.value), [10, 20, 30, 50, 60, 70, 80]);
  assert.equal(results[3].ok, false);

  const errors = [];
  const out = settle(results, items, "x", errors);
  assert.equal(out.length, 7);
  assert.deepEqual(errors, ["x 4: boom"]);
});

test("pmap handles an empty list", async () => {
  assert.deepEqual(await pmap([], async () => 1, 4), []);
});

// ---------- lesgo ----------
test("lesgo: parseDescription reads date, venue and portal from the Yoast sentence", () => {
  const a = parseDescription("Join OUM Fun Run 2.0 on 31 Oct 2026 at Decathlon DPulze Cyberjaya, Putrajaya / Cyberjaya. Register today via JomRun.");
  assert.equal(a.date, "2026-10-31");
  assert.equal(a.venue, "Decathlon DPulze Cyberjaya, Putrajaya / Cyberjaya");
  assert.equal(a.portal, "JomRun");
  assert.equal(a.past, false);

  const past = parseDescription("Love Penang Run 2023 was held on 14 May 2023 in Penang. Distances: 5K. Results, photos and past editions on Lesgo.My.");
  assert.equal(past.date, "2023-05-14");
  assert.equal(past.past, true);

  assert.equal(parseDescription("Join Puchong Half Marathon Powered by JomRun® (EVENT CANCEL) on 24 Oct 2026 at AEON Big Puchong…").cancelled, true);
  assert.equal(parseDescription("no date here").date, null);
  assert.equal(parseDescription(null).date, null);
});

test("lesgo: mapEvent maps taxonomy ids to state and distances", () => {
  const terms = { state: { 22: "putrajaya" }, distance: { 10: "5k", 12: "half-marathon" }, type: { 21: "fun-run" } };
  const ev = mapEvent(
    {
      slug: "oum-fun-run-2-0",
      link: "https://lesgo.my/event/oum-fun-run-2-0/",
      title: { rendered: "OUM Fun Run 2.0 &#8211; Putrajaya" },
      race_state: [22],
      distance_category: [10, 12],
      event_type: [21],
      yoast_head_json: { description: "Join OUM Fun Run 2.0 on 31 Oct 2026 at Decathlon DPulze Cyberjaya. Register today via JomRun." },
    },
    terms
  );
  assert.equal(ev.id, "lesgo-oum-fun-run-2-0");
  assert.equal(ev.title, "OUM Fun Run 2.0 – Putrajaya", "entities are decoded");
  assert.equal(ev.start_date, "2026-10-31");
  assert.equal(ev.state, "putrajaya");
  assert.deepEqual(ev.categories.map((c) => c.distance_km), [5, 21.0975]);
  assert.match(ev.description, /fun-run/);
  assert.match(ev.description, /Registration via JomRun/);
  assert.equal(ev.sources[0].portal, "lesgo");
});

test("lesgo: mapEvent tolerates rows with no terms or description", () => {
  const ev = mapEvent({ slug: "x", link: "https://lesgo.my/event/x/", title: { rendered: "X Run" } });
  assert.equal(ev.start_date, null);
  assert.equal(ev.state, null);
  assert.deepEqual(ev.categories, []);
  assert.equal(mapEvent({ slug: "y", title: { rendered: "" } }), null);
});

// ---------- howei calendar ----------
test("howei: /calendar parser extracts date + slug pairs", () => {
  const html = `
    var events = [
      { id: '1', start: "2026-11-21T" + moment("7:00 AM","h:mm A").format("HH:mm"),
        title: "Ultra Jerai Geopark Trail 2026", url: 'https://howei.com/event_details/ultrajeraigeoparktrail2026', allDay: false },
      { id: '2', start: "2019-07-07T" + moment("1:00 AM","h:mm A").format("HH:mm"),
        title: "Sandakan Marathon 2019", url: 'https://howei.com/event_details/sandakanmarathon2019', allDay: false },
    ];`;
  const out = howeiCalendar(html);
  assert.deepEqual(out, [
    { slug: "ultrajeraigeoparktrail2026", date: "2026-11-21" },
    { slug: "sandakanmarathon2019", date: "2019-07-07" },
  ]);
  assert.deepEqual(howeiCalendar("<html>nothing</html>"), []);
});

test("decodeEntities handles numeric entities and rejects invalid code points", async () => {
  const { decodeEntities } = await import("../scrapers/html.mjs");
  assert.equal(decodeEntities("A &#8211; B &#038; C &#x2019;s"), "A – B & C ’s");
  assert.equal(decodeEntities("&#0;&#55357;&#1114112;"), "&#0;&#55357;&#1114112;", "invalid code points are left as-is");
  assert.equal(decodeEntities("Kellie&#039;s"), "Kellie's");
  assert.equal(decodeEntities(null), null);
});

// ---------- lesgo detail + dedupe by ticket URL ----------
import { parseDetail as lesgoDetail, portalForUrl } from "../scrapers/lesgo.mjs";
import { dedupe, normaliseUrl, normaliseTitle } from "../scrapers/normalizer.mjs";

test("lesgo: parseDetail reads the official ticket link from Event JSON-LD", () => {
  const d = lesgoDetail(readFileSync(new URL("./fixtures/lesgo-detail.html", import.meta.url), "utf8"));
  assert.equal(d.registerUrl, "https://checkpointspot.asia/event/new-year-resolution-charity-run-27");
  assert.ok(d.image === null || d.image.startsWith("https://"));
  assert.deepEqual(lesgoDetail("<html></html>"), { registerUrl: null, organizer: null, image: null });
});

test("lesgo: parseDetail strips one-off access tokens and refuses non-http links", () => {
  const wrap = (url) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Event", offers: { url } })}</script>`;
  assert.equal(
    lesgoDetail(wrap("https://register.racexasia.com/my/x/registrations/rxa_web?access_token=SECRET")).registerUrl,
    "https://register.racexasia.com/my/x/registrations/rxa_web"
  );
  assert.equal(lesgoDetail(wrap("javascript:alert(1)")).registerUrl, null);
  assert.equal(lesgoDetail(wrap("data:text/html,<script>")).registerUrl, null);
});

test("portalForUrl files a link under the right portal", () => {
  assert.equal(portalForUrl("https://www.jomrun.com/event/x"), "jomrun");
  assert.equal(portalForUrl("https://checkpointspot.asia/event/x"), "checkpointspot");
  assert.equal(portalForUrl("https://howei.com/event_details/x"), "howei");
  assert.equal(portalForUrl("https://flagoffasia.com/events/x"), "official");
  assert.equal(portalForUrl("not a url"), null);
});

test("normaliseUrl: www/case/trailing slash are ignored; a bare host is not an identity", () => {
  assert.equal(normaliseUrl("https://www.JomRun.com/event/Foo/"), normaliseUrl("https://jomrun.com/event/foo"));
  assert.equal(normaliseUrl("https://calendar.heyjom.com/"), null);
  assert.equal(normaliseUrl("garbage"), null);
});

const mk = (id, title, portal, url, over = {}) => ({
  id, title, start_date: "2027-01-24", state: "Sarawak",
  categories: [], entitlements: [], sources: [{ portal, source_url: url }], ...over,
});

test("dedupe merges the same race when titles differ but the ticket URL matches", () => {
  const out = dedupe([
    mk("a", "Bintulu Half Marathon 2027 Powered by JomRun®", "jomrun", "https://www.jomrun.com/event/Bintulu-HM"),
    mk("b", "Bintulu Half Marathon", "lesgo", "https://lesgo.my/event/bintulu-half-marathon/", {
      sources: [
        { portal: "jomrun", source_url: "https://jomrun.com/event/bintulu-hm/" },
        { portal: "lesgo", source_url: "https://lesgo.my/event/bintulu-half-marathon/" },
      ],
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sources.length, 3, "all three links are kept");
});

test("dedupe never merges on a shared bare-host URL or a shared lesgo listing link", () => {
  const out = dedupe([
    mk("a", "Alpha Run 2027", "heyjom", "https://calendar.heyjom.com/", { start_date: "2027-03-01", state: "Perak" }),
    mk("b", "Totally Different Marathon", "heyjom", "https://calendar.heyjom.com/", { start_date: "2027-09-09", state: "Sabah" }),
    mk("c", "Gamma Fun Run", "lesgo", "https://lesgo.my/event/shared/", { start_date: "2027-05-01", state: "Johor" }),
    mk("d", "Delta Trail", "lesgo", "https://lesgo.my/event/shared/", { start_date: "2027-06-01", state: "Kedah" }),
  ]);
  assert.equal(out.length, 4);
});

test("normaliseTitle strips sponsor tails, brackets and cancel markers", () => {
  assert.equal(normaliseTitle("Kulai Half Marathon 2026 Powered by JomRun®"), "kulai half marathon");
  assert.equal(normaliseTitle("Kulai Half Marathon"), "kulai half marathon");
  assert.equal(normaliseTitle("[Virtual Run] Tebrau City Half Marathon 2026"), "tebrau city half marathon");
  assert.equal(normaliseTitle("Puchong Half Marathon (EVENT CANCEL)"), "puchong half marathon");
  assert.equal(normaliseTitle("The Royal Klang Marathon 2026"), "royal klang marathon");
  assert.equal(normaliseTitle("Penang Forest Run 2026 (POWERED BY DECATHLON)"), "penang forest run");
});

// ---------- fetch retry ----------
import { createServer } from "node:http";
import { fetchWithRetry } from "../scrapers/fetch.mjs";

test("fetchWithRetry retries 5xx/429 with backoff but returns 404 immediately", async () => {
  const hits = { flaky: 0, gone: 0, dead: 0 };
  const srv = createServer((req, res) => {
    if (req.url === "/flaky") {
      hits.flaky++;
      res.writeHead(hits.flaky < 3 ? 500 : 200).end(hits.flaky < 3 ? "no" : "yes");
    } else if (req.url === "/gone") {
      hits.gone++;
      res.writeHead(404).end("nope");
    } else {
      hits.dead++;
      res.writeHead(503).end("down");
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await fetchWithRetry(`${base}/flaky`, 3, { backoffMs: 1 });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, "yes");
    assert.equal(hits.flaky, 3, "two failures then success");

    const nf = await fetchWithRetry(`${base}/gone`, 3, { backoffMs: 1 });
    assert.equal(nf.status, 404);
    assert.equal(hits.gone, 1, "404 is not retried");

    const dead = await fetchWithRetry(`${base}/dead`, 2, { backoffMs: 1 });
    assert.equal(dead.status, 503, "gives up after the retries and reports the status");
    assert.equal(hits.dead, 3);
  } finally {
    srv.close();
  }
});

// ---------- sold-out / closed events are kept ----------
import { statusFromText, isPastDate } from "../scrapers/status.mjs";
import { parseListStatus as rxListStatus } from "../scrapers/racexasia.mjs";
import { parseList as biibListFn } from "../scrapers/biib.mjs";
import { parseListing as t2uParse } from "../scrapers/ticket2u.mjs";
import { runSync } from "../sync.mjs";
import { openDb } from "../db.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("statusFromText recognises sold out / closed / cancelled in English and Malay", () => {
  assert.equal(statusFromText("SOLD OUT"), "sold_out");
  assert.equal(statusFromText("Sold-out! see you next year"), "sold_out");
  assert.equal(statusFromText("Fully subscribed"), "sold_out");
  assert.equal(statusFromText("Tiket habis dijual"), "sold_out");
  assert.equal(statusFromText("Registration is Closed"), "closed");
  assert.equal(statusFromText("Puchong Half Marathon (EVENT CANCEL)"), "cancelled");
  assert.equal(statusFromText("Run on 26 December 2026, 6.30am"), null);
  assert.equal(statusFromText(null), null);
});

test("isPastDate is about the calendar only, never about status", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  assert.equal(isPastDate("2026-11-09", now), true);
  assert.equal(isPastDate("2026-11-20", now), false);
  assert.equal(isPastDate(null, now), false);
});

test("racexasia: list-page ticket icon marks closed vs open per card", () => {
  const html = `
    <div class="event"><a href="/event/aaa-run" class="title">A</a>
      <i class="fa fa-ticket-alt status closed" title="Closed"></i></div>
    <div class="event"><a href="/event/bbb-run" class="title">B</a>
      <i class="fa fa-ticket-alt status open" title="Open"></i></div>`;
  const m = rxListStatus(html);
  assert.equal(m.get("aaa-run"), "closed");
  assert.equal(m.get("bbb-run"), "open");
});

test("biib: list card badge 'Registration is Closed' becomes status closed; ticket button stays open", () => {
  const card = (id, title, tail) =>
    `<div class="col-sm-6"><div class="card"><a href="/events/${id}"><img class="card-img-top" src="https://x/${id}.jpg" /></a><div class="card-body"><h4 class="card-title">${title}</h4><p class="card-text">blurb</p>${tail}</div></div></div>`;
  const html =
    card(1, "Open Run", '<a class="btn btn-primary" href="/events/1">Get Ticket</a>') +
    card(2, "Shut Run", '<div class="badge badge-danger">Registration is Closed</div>');
  const out = biibListFn(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].status, "open");
  assert.equal(out[1].status, "closed");
});

test("ticket2u: sale-ended upcoming event is closed but still emitted", () => {
  const mkRow = (over) => ({ row: { id: "1", name: "X Run", link: "/event/1/x-run", datefrom: "2027-01-01T07:00:00", status: "upcoming", issaleend: "0", ...over } });
  const out = t2uParse({ data: [mkRow({}), mkRow({ id: "2", issaleend: "1" }), mkRow({ id: "3", status: "expired" })] });
  assert.deepEqual(out.map((e) => e.status), ["open", "closed", "closed"]);
});

// The end-to-end "sold-out events survive a sync" case lives in tests/sync.test.mjs,
// which runs against Postgres (this file stays DB-free).
