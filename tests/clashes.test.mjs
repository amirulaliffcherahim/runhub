import { test } from "node:test";
import assert from "node:assert/strict";

import { clashes, annotateClashes, RECOVERY_DAYS } from "../clashes.mjs";

const race = (over = {}) => ({
  id: "candidate",
  title: "Candidate Run 2099",
  start_date: "2099-05-10",
  categories: [{ distance_km: 21 }],
  ...over,
});

const mine = (id, title, start_date, over = {}) => ({ event_id: id, title, start_date, ...over });

test("same race day is always a clash", () => {
  const out = clashes(race(), [mine("a", "Twincity HM", "2099-05-10")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, "same race day");
  assert.equal(out[0].title, "Twincity HM");
});

test("a half marathon needs 3 recovery days, a 10k only 2", () => {
  const half = clashes(race({ categories: [{ distance_km: 21 }] }), [mine("a", "A", "2099-05-08")]);
  assert.equal(half.length, 1, "2 days before a half is too close");
  assert.match(half[0].reason, /2 days apart/);

  const tenK = clashes(race({ categories: [{ distance_km: 10 }] }), [mine("a", "A", "2099-05-08")]);
  assert.equal(tenK.length, 1);

  const farEnough = clashes(race({ categories: [{ distance_km: 10 }] }), [mine("a", "A", "2099-05-07")]);
  assert.equal(farEnough.length, 0, "3 days before a 10k is fine");
});

test("a marathon widens the window to 7 days for both races", () => {
  const out = clashes(race({ categories: [{ distance_km: 42.195 }] }), [mine("a", "A", "2099-05-04")]);
  assert.equal(out.length, 1, "6 days before a marathon is still too close");
  assert.equal(RECOVERY_DAYS.marathon, 7);

  const ok = clashes(race({ categories: [{ distance_km: 42.195 }] }), [mine("a", "A", "2099-05-02")]);
  assert.equal(ok.length, 0, "8 days is fine");
});

test("the window uses the longer of the two races", () => {
  // Candidate is a 5k, but the saved race is a marathon.
  const out = clashes(race({ categories: [{ distance_km: 5 }] }), [
    mine("a", "Saved Marathon", "2099-05-05", { categories: [{ distance_km: 42 }] }),
  ]);
  assert.equal(out.length, 1);
});

test("race-pack collection on another race day is flagged", () => {
  const out = clashes(
    race({ start_date: "2099-06-01", race_pack: [{ date: "2099-05-10", venue: "Mid Valley" }] }),
    [mine("a", "Twincity HM", "2099-05-10")]
  );
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /race-pack collection on Twincity HM's race day/);
});

test("no date, or no saved races, means no clashes", () => {
  assert.deepEqual(clashes(race({ start_date: null }), [mine("a", "A", "2099-05-10")]), []);
  assert.deepEqual(clashes(race(), []), []);
  assert.deepEqual(clashes(race(), [mine("a", "A", null)]), []);
});

test("an event already in My Season is not compared with itself", () => {
  assert.deepEqual(clashes(race({ id: "x" }), [mine("x", "Self", "2099-05-10")]), []);
});

test("annotateClashes skips events already saved and adds [] when clear", () => {
  const saved = race({ id: "saved" });
  const clear = race({ id: "clear", start_date: "2099-09-09" });
  const clashing = race({ id: "clash" });
  const out = annotateClashes([saved, clear, clashing], [mine("saved", "Saved", "2099-05-10"), mine("s2", "Other", "2099-12-01")]);

  assert.equal(out.find((e) => e.id === "saved").clashes, undefined, "saved events carry no badge");
  assert.deepEqual(out.find((e) => e.id === "clear").clashes, []);
  assert.equal(out.find((e) => e.id === "clash").clashes.length, 1);
});
