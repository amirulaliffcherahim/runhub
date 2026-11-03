/**
 * One vocabulary for entitlement kinds, so the drawer can group images reliably
 * instead of guessing from portal-specific strings.
 *
 * Canonical kinds:
 *   event_tee | finisher_tee | medal | size_chart | route_map | goodies |
 *   fee_table | prize_table | timing | other
 */

export const KINDS = [
  "event_tee",
  "finisher_tee",
  "medal",
  "size_chart",
  "route_map",
  "goodies",
  "fee_table",
  "prize_table",
  "timing",
  "other",
];

/** Portal strings seen in the wild -> canonical kind. */
const ALIASES = {
  // RaceXasia Entitlement[].type values
  entitlement_table: "goodies",
  drawstring_bag: "goodies",
  timing_chip: "timing",
  timing: "timing",
  flag_off: "timing",
  cut_off: "timing",
  sizing_chart: "size_chart",
  size_chart: "size_chart",
  route_map: "route_map",
  // JomRun / Howei / generic
  section: "other",
  poster: "other",
  event_tee: "event_tee",
  finisher_tee: "finisher_tee",
  medal: "medal",
  fee_table: "fee_table",
  prize_table: "prize_table",
  goodies: "goodies",
  other: "other",
};

/**
 * Map a portal's kind string to a canonical kind.
 * Falls back to reading the title, because several portals only label images with text.
 */
export function normaliseKind(kind, title = "") {
  const k = String(kind ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  // A specific alias wins. Generic ones ("section", "poster", "other") must fall
  // through to the title, which is often the only place the real kind is stated.
  const mapped = ALIASES[k];
  if (mapped && mapped !== "other") return mapped;

  const t = String(title ?? "").toLowerCase();
  if (/size\s*chart|sizing|ukuran/.test(t)) return "size_chart";
  if (/route|course map|peta/.test(t)) return "route_map";
  if (/finisher (tee|shirt|jersey)|finisher tee/.test(t)) return "finisher_tee";
  if (/tee|t-shirt|tshirt|jersey|singlet|shirt/.test(t)) return "event_tee";
  if (/medal/.test(t)) return "medal";
  if (/fee|price|harga/.test(t)) return "fee_table";
  if (/prize|hadiah/.test(t)) return "prize_table";
  if (/flag ?off|cut ?off|timing/.test(t)) return "timing";
  if (/goodie|entitle|pack|collect|bag/.test(t)) return "goodies";
  return "other";
}
