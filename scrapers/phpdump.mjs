/**
 * Parser for PHP `var_dump()` / `print_r()` output embedded in racexasia.com
 * event pages (inside an HTML comment).
 *
 * Format:
 *   stdClass Object
 *   (
 *       [key] => value
 *       [nested] => stdClass Object
 *           (
 *               [k] => v
 *           )
 *       [list] => Array
 *           (
 *               [0] => 110.00
 *           )
 *   )
 *
 * Containers always name themselves on the key line, so an empty value on the
 * key line is an empty string, never a following block.
 */

const CONTAINER = /^(stdClass Object|Array|\w+ Object)$/;

const coerce = (raw) => {
  const s = String(raw).trim();
  if (s === "NULL") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
};

export function parsePhpDump(text) {
  // Strip HTML comment wrappers / <pre> tags if present.
  const body = text
    .replace(/^\s*<!--\s*<pre>\s*/i, "")
    .replace(/<\/pre>\s*-->\s*$/i, "")
    .replace(/<[^>]+>/g, "");

  const lines = body.split(/\r?\n/);
  let pos = 0;

  const peek = () => {
    while (pos < lines.length && lines[pos].trim() === "") pos++;
    return pos < lines.length ? lines[pos] : null;
  };
  const next = () => {
    const line = peek();
    if (line === null) throw new Error("parsePhpDump: unexpected end of input");
    pos++;
    return line;
  };

  function parseBlock(isArray) {
    const out = isArray ? [] : {};
    for (;;) {
      const line = peek();
      if (line === null) throw new Error("parsePhpDump: unterminated block");
      const trimmed = line.trim();
      if (trimmed === ")") {
        pos++;
        return out;
      }

      const m = trimmed.match(/^\[([^\]]*)\]\s*=>\s?([\s\S]*)$/);
      if (!m) throw new Error(`parsePhpDump: unexpected line ${JSON.stringify(trimmed)}`);
      pos++;

      const key = m[1];
      const rest = m[2].trim();

      let value;
      if (rest === "") {
        value = "";
      } else if (CONTAINER.test(rest)) {
        const open = next().trim();
        if (open !== "(") {
          throw new Error(
            `parsePhpDump: expected "(" after ${rest}, got ${JSON.stringify(open)}`
          );
        }
        value = parseBlock(rest === "Array");
      } else {
        // Scalars can span several lines (descriptions, addresses).
        // Keep consuming until the next key line or the closing paren.
        let text = rest;
        for (;;) {
          const nxt = peek();
          if (nxt === null) break;
          const t = nxt.trim();
          if (t === ")" || /^\[[^\]]*\]\s*=>/.test(t)) break;
          text += "\n" + nxt;
          pos++;
        }
        value = coerce(text);
      }

      if (isArray) out.push(value);
      else out[key] = value;
    }
  }

  const head = next().trim();
  if (head === "(") return parseBlock(false);
  if (!CONTAINER.test(head)) {
    throw new Error(`parsePhpDump: expected container header, got ${JSON.stringify(head)}`);
  }
  const open = next().trim();
  if (open !== "(") {
    throw new Error(`parsePhpDump: expected "(" after ${head}, got ${JSON.stringify(open)}`);
  }
  return parseBlock(head === "Array");
}
