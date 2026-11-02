/**
 * Shared HTML text helpers. Portals ship entities and mojibake ("JomRunÂ®",
 * "Kellie&#039;s"), so every scraped string goes through here.
 */

const ENTITIES = {
  "&#039;": "'",
  "&#39;": "'",
  "&apos;": "'",
  "&quot;": '"',
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&zwj;": "",
  "Â®": "®",
  "Â©": "©",
  "Â·": "·",
  "â€“": "–",
  "â€”": "—",
  "â€™": "’",
  "â€œ": '"',
  "â€\u009d": '"',
};

export function decodeEntities(s) {
  if (typeof s !== "string") return s;
  return s.replace(/&#0?39;|&(?:apos|quot|nbsp|amp|lt|gt|zwj);|Â[®©·]|â€[“”\u009d–—’]/g, (m) => ENTITIES[m] ?? m);
}

/** Strip tags (newlines become spaces), decode entities, collapse whitespace. */
export function stripHtml(s) {
  if (typeof s !== "string") return s;
  return decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
