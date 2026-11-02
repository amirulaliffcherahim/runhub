const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n) => String(n).padStart(2, "0");

/**
 * Best-effort ISO date from the shapes Malaysian portals actually use:
 *   "2nd May 2027", "24 October 2026", "2026-06-16", "29 November, 2026",
 *   "24 - 25 October 2026", "17 – 18 January 2026".
 * Returns "YYYY-MM-DD" or null. Never throws.
 */
export function toIso(input) {
  if (!input) return null;
  const s = String(input).trim();

  // Already ISO (take the first date if it is a range).
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "24 - 25 October 2026" / "17 – 18 January 2026" -> use the last day.
  const ranged = s.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
  if (ranged) {
    const m = MONTHS[ranged[3].slice(0, 3).toLowerCase()];
    if (m) return `${ranged[4]}-${pad(m)}-${pad(Number(ranged[2]))}`;
  }

  // "2nd May 2027" / "29 November, 2026"
  const single = s.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
  if (single) {
    const m = MONTHS[single[2].slice(0, 3).toLowerCase()];
    if (m) return `${single[3]}-${pad(m)}-${pad(Number(single[1]))}`;
  }

  // "May 2, 2027"
  const usStyle = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (usStyle) {
    const m = MONTHS[usStyle[1].slice(0, 3).toLowerCase()];
    if (m) return `${usStyle[3]}-${pad(m)}-${pad(Number(usStyle[2]))}`;
  }

  return null;
}
