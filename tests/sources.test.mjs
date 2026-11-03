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
  const hits = { flaky: 0, gone: 0, dead: 0, robots: 0 };
  const srv = createServer((req, res) => {
    // Every request now checks robots.txt first; answer it explicitly so it does not
    // land in the catch-all branch and inflate the counters.
    if (req.url === "/robots.txt") {
      hits.robots++;
      res.writeHead(404).end("");
      return;
    }
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

// ---------- AI crawler: validation is the safety boundary ----------
import { extractJson, normaliseDate, validateExtraction, scrapeAi } from "../scrapers/ai.mjs";

const PAGE = "Penang Forest Run 2026 (POWERED BY DECATHLON) 14 Nov 2026 Bukit Mertajam Forest Park, Penang. 5KM 10KM 15KM. SOLD OUT";

test("ai: extractJson copes with prose, fences and trailing text", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":2}\n```\n'), { a: 2 });
  assert.deepEqual(extractJson('here you go {"a":3} hope that helps'), { a: 3 });
  assert.equal(extractJson("no json at all"), null);
  assert.equal(extractJson(null), null);
});

test("ai: normaliseDate only accepts real dates", () => {
  assert.equal(normaliseDate("2026-11-14"), "2026-11-14");
  assert.equal(normaliseDate("2027-02-31"), null, "impossible date");
  assert.equal(normaliseDate("14 Nov 2026"), "2026-11-14");
  assert.equal(normaliseDate("soon"), null);
  assert.equal(normaliseDate(null), null);
});

test("ai: validateExtraction accepts a faithful extraction", () => {
  const { event } = validateExtraction(
    { name: "Penang Forest Run 2026", date: "2026-11-14", venue: "Bukit Mertajam Forest Park, Penang", state: "Penang", distances: [5, 10, 15], sold_out: true },
    { pageUrl: "https://emas.example/event/penang", pageText: PAGE }
  );
  assert.equal(event.start_date, "2026-11-14");
  assert.equal(event.state, "Penang");
  assert.equal(event.status, "sold_out");
  assert.deepEqual(event.categories.map((c) => c.distance_km), [5, 10, 15]);
  assert.equal(event.origin, "ai");
  assert.equal(event.sources[0].portal, "ai");
});

test("ai: a hallucinated name or a missing date is rejected", () => {
  const base = { date: "2026-11-14", venue: "x", state: "Penang", distances: [5] };
  assert.equal(validateExtraction({ ...base, name: "Totally Invented Ultra 2030" }, { pageUrl: "u", pageText: PAGE }).reject, "name not in page");
  assert.equal(validateExtraction({ ...base, name: "Penang Forest Run 2026", date: null }, { pageUrl: "u", pageText: PAGE }).reject, "no valid date");
  assert.equal(validateExtraction(null, { pageUrl: "u", pageText: PAGE }).reject, "no json");
});

test("ai: the venue wins over a wrong model state", () => {
  // Regression: the model labelled a Bukit Mertajam race "Selangor".
  const { event } = validateExtraction(
    { name: "Penang Forest Run 2026", date: "2026-11-14", venue: "Bukit Mertajam Forest Park, Penang", state: "Selangor", distances: [5] },
    { pageUrl: "u", pageText: PAGE }
  );
  assert.equal(event.state, "Penang", "derived from the venue, not the model");
});

test("ai: without a usable venue, a state the page never mentions is dropped", () => {
  const { event } = validateExtraction(
    { name: "Penang Forest Run 2026", date: "2026-11-14", venue: "Somewhere", state: "Sabah", distances: [5] },
    { pageUrl: "u", pageText: PAGE }
  );
  assert.equal(event.state, null, "Sabah is not in the page text");
});

test("ai: distances are clamped to sane values and deduped", () => {
  const { event } = validateExtraction(
    { name: "Penang Forest Run 2026", date: "2026-11-14", distances: [5, "5km", 9999, -3, 0, 21.1] },
    { pageUrl: "u", pageText: PAGE }
  );
  assert.deepEqual(event.categories.map((c) => c.distance_km), [5, 21.1]);
});

test("ai: scrapeAi only follows links on the configured host and reports model failures", async () => {
  const pages = {
    "https://emas.example/portal": '<a href="/event/a">A</a><a href="https://evil.example/event/b">B</a>',
    "https://emas.example/event/a": "<h1>Alpha Trail Run 2026</h1> 1 May 2027 Selangor 10km",
  };
  const fetchImpl = async (url) => ({ status: pages[url] ? 200 : 404, text: pages[url] ?? "" });
  const asked = [];
  const res = await scrapeAi(
    { name: "emas", baseUrl: "https://emas.example", listUrls: ["/portal"], linkPattern: 'href="([^"]+)"', maxEvents: 5 },
    {
      fetchImpl,
      ask: async ({ text }) => {
        asked.push(text);
        return JSON.stringify({ name: "Alpha Trail Run 2026", date: "2027-05-01", state: "Selangor", distances: [10] });
      },
    }
  );
  assert.equal(asked.length, 1, "the off-host link must not be fetched");
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].start_date, "2027-05-01");
});

test("ai: a model that returns junk yields a rejection, not an event", async () => {
  const fetchImpl = async (url) => ({ status: 200, text: url.endsWith("/portal") ? '<a href="/event/a">A</a>' : "Alpha Trail Run 2026 1 May 2027" });
  const res = await scrapeAi(
    { name: "emas", baseUrl: "https://emas.example", listUrls: ["/portal"], linkPattern: 'href="([^"]+)"' },
    { fetchImpl, ask: async () => "I could not find any event, sorry." }
  );
  assert.equal(res.events.length, 0);
  assert.equal(res.rejected.length, 1);
});

// ---------- robots.txt + politeness ----------
import { parseRobots, isAllowed, aiUseAllowed } from "../scrapers/robots.mjs";
import { schedule, configureThrottle, throttleReport, resetThrottle } from "../scrapers/throttle.mjs";

test("robots: longest match wins, ties go to Allow", () => {
  const { rules } = parseRobots("User-agent: *\nDisallow: /admin\nAllow: /admin/public\nDisallow: /private\n");
  assert.equal(isAllowed(rules, "/"), true);
  assert.equal(isAllowed(rules, "/events"), true);
  assert.equal(isAllowed(rules, "/admin"), false);
  assert.equal(isAllowed(rules, "/admin/public/x"), true, "more specific Allow wins");
  assert.equal(isAllowed(rules, "/private/page"), false);
});

test("robots: only the * group counts, and a bare Disallow means allow-all", () => {
  const p = parseRobots("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n");
  assert.deepEqual(p.rules, []);
  assert.equal(isAllowed(p.rules, "/anything"), true);
});

test("robots: crawl-delay takes the strictest declared value", () => {
  // Howei really does this: bingbot 10s, * 5s.
  const p = parseRobots("User-agent: bingbot\nCrawl-delay: 10\n\nUser-agent: *\nCrawl-delay: 5\n");
  assert.equal(p.crawlDelayMs, 5000, "the * group is what applies to us");
  const multi = parseRobots("User-agent: *\nCrawl-delay: 2\nCrawl-delay: 7\n");
  assert.equal(multi.crawlDelayMs, 7000, "strictest wins");
});

test("robots: content signals gate model use", () => {
  const p = parseRobots("User-agent: *\nContent-Signal: search=yes,ai-train=no,use=reference\nAllow: /\n");
  assert.equal(p.contentSignals["ai-train"], "no");
  assert.equal(aiUseAllowed(p).allowed, false);
  assert.match(aiUseAllowed(p).reason, /ai-train=no/);

  const ok = parseRobots("User-agent: *\nContent-Signal: search=yes,ai-input=yes\nAllow: /\n");
  assert.equal(aiUseAllowed(ok).allowed, true);
  assert.equal(aiUseAllowed({}).allowed, true, "no signals means no restriction");
});

test("throttle: serialises per host and enforces the gap", async () => {
  resetThrottle();
  configureThrottle({ maxRequests: 100 });
  const t0 = Date.now();
  const order = [];
  await Promise.all([
    schedule("https://a.example/1", 120, async () => { order.push(1); }),
    schedule("https://a.example/2", 120, async () => { order.push(2); }),
    schedule("https://b.example/1", 120, async () => { order.push(3); }),
  ]);
  const elapsed = Date.now() - t0;
  // b.example is a different host, so it may run immediately; only same-host order is fixed.
  assert.ok(order.indexOf(1) < order.indexOf(2), "same-host requests keep their order");
  assert.ok(elapsed >= 110, `second same-host request waited (${elapsed}ms)`);
  assert.equal(throttleReport().requests, 3);
});

test("throttle: refuses once the request budget is spent", async () => {
  resetThrottle();
  configureThrottle({ maxRequests: 2 });
  await schedule("https://a.example/1", 0, async () => {});
  await schedule("https://a.example/2", 0, async () => {});
  await assert.rejects(schedule("https://a.example/3", 0, async () => {}), /budget exhausted/);
  resetThrottle();
});

// ---------- Z1: field-level merge across portals ----------
import { mergeCategories, mergeEntitlements, mergeRacePack, mergeKeyDates } from "../scrapers/normalizer.mjs";

const cat = (over = {}) => ({
  distance_km: 21, label: "21km", price_early: null, price_normal: null,
  price_note: null, cutoff_time: null, flag_off_time: null, status: "open", ...over,
});

test("mergeCategories matches the same tier across portal spellings (21.0975 == 21.1)", () => {
  const out = mergeCategories(
    [cat({ distance_km: 21.0975, label: "Half Marathon", price_normal: 120 })],
    [cat({ distance_km: 21.1, label: "21.1KM Competitive Run", flag_off_time: "4:00am" })]
  );
  assert.equal(out.length, 1, "one row, not two");
  assert.equal(out[0].price_normal, 120, "price kept from the first portal");
  assert.equal(out[0].flag_off_time, "4:00am", "flag-off filled from the second");
  assert.equal(out[0].label, "21.1KM Competitive Run", "the more informative label wins");
});

test("mergeCategories keeps tiers that only one portal lists", () => {
  const out = mergeCategories(
    [cat({ distance_km: 42, label: "Full" }), cat({ distance_km: 21 })],
    [cat({ distance_km: 5, label: "5km Fun Run" })]
  );
  assert.deepEqual(out.map((c) => c.distance_km), [5, 21, 42], "sorted, no duplicates, nothing dropped");
});

test("mergeCategories never overwrites a value with null, and fills every spec field", () => {
  const out = mergeCategories(
    [cat({ price_early: 90, price_normal: 120, cutoff_time: "6 hours", min_age: 18 })],
    [cat({ price_early: null, price_normal: null, cutoff_time: null, flag_off_time: "5:00am", finisher_tee: true, min_age: null })]
  );
  assert.equal(out[0].price_early, 90);
  assert.equal(out[0].price_normal, 120);
  assert.equal(out[0].cutoff_time, "6 hours");
  assert.equal(out[0].min_age, 18);
  assert.equal(out[0].flag_off_time, "5:00am");
  assert.equal(out[0].finisher_tee, true);
});

test("mergeCategories records a conflicting price instead of silently dropping it", () => {
  const out = mergeCategories([cat({ price_normal: 120 })], [cat({ price_normal: 135 })]);
  assert.equal(out[0].price_normal, 120, "richer portal's price wins");
  assert.match(out[0].price_note, /other portal lists normal RM135/);
});

test("mergeCategories falls back to the label when a portal gives no distance", () => {
  const out = mergeCategories(
    [cat({ distance_km: null, label: "Fun Run", price_normal: 40 })],
    [cat({ distance_km: null, label: "Fun Run", flag_off_time: "7:00am" })]
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].flag_off_time, "7:00am");
});

test("mergeEntitlements unions by image so prices and kit photos both survive", () => {
  const out = mergeEntitlements(
    [
      { kind: "fee_table", title: "Registration Fee", image_url: "https://rx/fee.jpg" },
      { kind: "event_tee", title: "Event Tee", image_url: "https://rx/tee.jpg" },
    ],
    [
      { kind: "event_tee", title: "Drifit Tee - Black", image_url: "https://howei/tee.jpg" },
      { kind: "medal", title: "Finisher Medal", image_url: "https://howei/medal.jpg" },
      { kind: "size_chart", title: "Size Chart", image_url: "https://howei/size.jpg" },
    ]
  );
  assert.equal(out.length, 5, "nothing dropped");
  assert.deepEqual(out.map((e) => e.kind).sort(), ["event_tee", "event_tee", "fee_table", "medal", "size_chart"]);
});

test("mergeEntitlements dedupes the same asset with a cache-busting query string", () => {
  const out = mergeEntitlements(
    [{ kind: "medal", title: "Medal", image_url: "https://x/medal.jpg" }],
    [{ kind: "medal", title: "Finisher Medal", image_url: "https://x/medal.jpg?v=2" }]
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Finisher Medal", "the richer title wins");
});

test("mergeEntitlements keeps a titled image over an untitled duplicate", () => {
  const out = mergeEntitlements(
    [{ kind: "event_tee", title: null, image_url: "https://x/a.jpg" }],
    [{ kind: "event_tee", title: "Collared Shirt - White", image_url: "https://x/a.jpg" }]
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Collared Shirt - White");
});

test("mergeRacePack and mergeKeyDates union by venue/title", () => {
  const pack = mergeRacePack(
    [{ date: "2026-07-30", time: null, venue: "Mid Valley" }],
    [{ date: null, time: "10:00", venue: "Mid Valley" }, { date: "2026-07-31", time: null, venue: "Penang" }]
  );
  assert.equal(pack.length, 2);
  assert.equal(pack[0].time, "10:00", "time filled from the other portal");
  assert.equal(pack[1].venue, "Penang");

  const keys = mergeKeyDates(
    [{ date: null, title: "Early Bird" }],
    [{ date: "2026-03-01", title: "Early Bird" }, { date: "2026-06-01", title: "Normal" }]
  );
  assert.equal(keys.length, 2);
  assert.equal(keys[0].date, "2026-03-01");
});

test("dedupe: a real two-portal race ends up with the union of both records", () => {
  const racexasia = mk("rx", "Kuala Kangsar Half Marathon 2027", "racexasia", "https://racexasia.com/event/kkhm", {
    start_date: "2027-05-02", state: "Perak",
    categories: [cat({ distance_km: 21, label: "21km", price_early: 80, price_normal: 95 })],
    entitlements: [{ kind: "fee_table", title: "Registration Fee", image_url: "https://rx/fee.jpg" }],
    race_pack: [{ date: "2027-04-30", venue: "Ipoh" }],
  });
  const howei = mk("hw", "Kuala Kangsar Half Marathon 2027", "howei", "https://howei.com/event_details/kkhm", {
    start_date: "2027-05-02", state: "Perak",
    categories: [cat({ distance_km: 21, label: "21km", flag_off_time: "5:00am", cutoff_time: "6 hours" })],
    entitlements: [
      { kind: "event_tee", title: "Drifit Tee - Black", image_url: "https://howei/tee.jpg" },
      { kind: "size_chart", title: "Size Chart", image_url: "https://howei/size.jpg" },
    ],
    race_pack: [{ date: null, time: "10:00", venue: "Ipoh" }],
  });

  const out = dedupe([racexasia, howei]);
  assert.equal(out.length, 1);
  const merged = out[0];
  assert.equal(merged.categories.length, 1, "one 21km row");
  assert.equal(merged.categories[0].price_normal, 95, "RaceXasia price");
  assert.equal(merged.categories[0].flag_off_time, "5:00am", "Howei flag-off");
  assert.equal(merged.categories[0].cutoff_time, "6 hours", "Howei cut-off");
  assert.equal(merged.entitlements.length, 3, "fee table + tee + size chart");
  assert.equal(merged.race_pack[0].time, "10:00", "RPC time filled in");
  assert.equal(merged.sources.length, 2);
});
