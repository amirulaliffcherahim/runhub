/**
 * Registration availability. Stored in `events.status`:
 *   open | upcoming | sold_out | closed (registration ended) | cancelled
 * Sold-out and closed events are kept and shown - the user wants to see every race, and a
 * sold-out race may still have a waitlist, transfers, or next-edition news.
 */
export function statusFromText(text) {
  const t = String(text ?? "").toLowerCase();
  if (/cancel/.test(t)) return "cancelled";
  if (/sold[\s-]?out|fully[\s-]?(subscribed|booked)|slots? (are )?full|registration (is )?full|habis dijual|\bpenuh\b/.test(t)) return "sold_out";
  if (/registration (is )?closed|registration (has )?ended|sales? (has )?ended|ticket sales closed/.test(t)) return "closed";
  return null;
}

/** An event is "live" (worth showing as upcoming) unless its DATE has passed. Status never hides it. */
export const isPastDate = (isoDate, now = new Date(), graceDays = 0) => {
  if (!isoDate) return false;
  const d = new Date(now);
  d.setDate(d.getDate() - graceDays);
  return isoDate < d.toISOString().slice(0, 10);
};
