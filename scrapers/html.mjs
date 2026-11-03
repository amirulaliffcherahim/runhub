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
  return s
    .replace(/&#0?39;|&(?:apos|quot|nbsp|amp|lt|gt|zwj);|Â[®©·]|â€[“”\u009d–—’]/g, (m) => ENTITIES[m] ?? m)
    // Numeric entities (WordPress emits &#8211; &#038; &#8217; ...), decimal and hex.
    .replace(/&#(\d{1,6});/g, (m, n) => safeCodePoint(Number(n)) ?? m)
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeCodePoint(parseInt(h, 16)) ?? m);
}

function safeCodePoint(n) {
  // Reject NUL, surrogates and out-of-range values rather than throwing.
  if (!Number.isInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  return String.fromCodePoint(n);
}

/** Strip tags (newlines become spaces), decode entities, collapse whitespace. */
export function stripHtml(s) {
  if (typeof s !== "string") return s;
  return decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
