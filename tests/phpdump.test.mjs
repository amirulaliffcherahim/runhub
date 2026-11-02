import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePhpDump } from "../scrapers/phpdump.mjs";

const fixture = readFileSync(
  new URL("./fixtures/racexasia-detail.html", import.meta.url),
  "utf8"
);

const extractDump = (html) => {
  const m = html.match(/<!--\s*<pre>([\s\S]*?)<\/pre>/);
  assert.ok(m, "fixture must contain an embedded var_dump");
  return m[1];
};

test("parsePhpDump: parses the RaceXasia fixture root keys", () => {
  const dump = parsePhpDump(extractDump(fixture));
  for (const key of ["Event", "EventDetail", "Info", "KeyDate", "Category", "Entitlement", "RacePack"]) {
    assert.ok(key in dump, `missing top-level key ${key}`);
  }
});

test("parsePhpDump: scalars keep their type", () => {
  const dump = parsePhpDump(extractDump(fixture));
  assert.equal(dump.Event.id, 121);
  assert.equal(typeof dump.EventDetail.long_name, "string");
  assert.equal(dump.EventDetail.venue.length > 0, true);
});

test("parsePhpDump: nested arrays are real arrays", () => {
  const dump = parsePhpDump(extractDump(fixture));
  assert.ok(Array.isArray(dump.Category));
  assert.ok(Array.isArray(dump.Entitlement));
  assert.ok(dump.Category.length > 0);
  assert.equal(dump.Category[0].prices[0].label, "Super Early Bird");
});

test("parsePhpDump: empty value on key line is an empty string", () => {
  const dump = parsePhpDump(extractDump(fixture));
  assert.equal(dump.EventDetail.address, "");
});

test("parsePhpDump: small hand-written sample", () => {
  const sample = `stdClass Object
(
    [a] => 1
    [b] => hello
    [c] => Array
        (
            [0] => x
            [1] => y
        )

    [d] => stdClass Object
        (
            [e] => 2.5
        )
)`;
  assert.deepEqual(parsePhpDump(sample), {
    a: 1,
    b: "hello",
    c: ["x", "y"],
    d: { e: 2.5 },
  });
});
