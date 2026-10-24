/**
 * A plain-text alternative for one of NEMAR's own HTML mails (epic #1893).
 *
 * Small and dependency-free on purpose: the inputs are the fixed templates in services/email.ts
 * and services/broadcast.ts, whose variable parts are already escaped, so this is a reader for
 * that markup and not a general HTML parser. A sign-in code and every link survive: a link is
 * written as "label (url)" when the two differ.
 *
 * Two properties are kept deliberately. Every piece of text is entity-decoded exactly once, and
 * never re-scanned for tags afterwards, so an escaped `&lt;b&gt;` stays text. And no step is
 * quadratic on unclosed tags: blocks and links are found by scanning forward once and stopping
 * at the first missing closer, and tag patterns cannot run past the next `<`. Input beyond
 * MAX_HTML_LENGTH is cut before conversion.
 */

/** Characters of HTML converted; the longest template is a few KiB, so this is never reached. */
export const MAX_HTML_LENGTH = 256 * 1024;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["mdash", "—"],
  ["ndash", "–"],
  ["hellip", "…"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["middot", "·"],
  ["bull", "•"],
  ["copy", "©"],
  ["rarr", "→"],
]);

// Private-use markers that wrap a finished link while the rest of the text is decoded. Any in the
// input are removed first, and decoding never produces them, so a marker is always ours.
const OPEN = "";
const CLOSE = "";

/** Decode named and numeric entities in one pass, so `&amp;lt;` becomes `&lt;` and no further. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (whole, dec, hex, name) => {
      if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? whole;
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      if (code === 0xe000 || code === 0xe001) return whole;
      return String.fromCodePoint(code);
    },
  );
}

/** Remove tags. A tag cannot contain `<`, so an unclosed one ends where the next begins. */
const stripTags = (html: string): string => html.replace(/<\/?[a-zA-Z][^<>]*>/g, "");

/**
 * Remove every `open ... close` block, scanning forward once. A block with no closer ends the
 * scan, so unclosed openers cost one pass rather than one pass each.
 */
function removeBlocks(text: string, openSource: string, closeSource: string): string {
  const open = new RegExp(openSource, "gi");
  const close = new RegExp(closeSource, "gi");
  let out = "";
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const start = open.exec(text);
    if (!start) break;
    close.lastIndex = start.index + start[0].length;
    const end = close.exec(text);
    if (!end) break;
    out += text.slice(pos, start.index);
    pos = end.index + end[0].length;
  }
  return out + text.slice(pos);
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Replace each `<a href=...>label</a>` with a marker standing for its finished text, "label (url)"
 * unless the label is the url, and collect that text in `done`. Label and url are each decoded
 * here, once; the marker keeps them out of the decoding pass that follows.
 */
function takeLinks(text: string, done: string[]): string {
  const open = /<a(?=[\s>])/gi;
  const close = /<\/a\s*>/gi;
  let out = "";
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const start = open.exec(text);
    if (!start) break;
    const tagEnd = text.indexOf(">", start.index);
    if (tagEnd < 0) break;
    close.lastIndex = tagEnd + 1;
    const end = close.exec(text);
    if (!end) break;

    const attrs = text.slice(start.index + 2, tagEnd);
    const href = HREF.exec(attrs);
    const url = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    const label = decodeEntities(stripTags(text.slice(tagEnd + 1, end.index)))
      .replace(/\s+/g, " ")
      .trim();

    let rendered: string;
    if (!url || url.startsWith("#") || label === url) rendered = label || url;
    else rendered = label ? `${label} (${url})` : url;

    out += text.slice(pos, start.index) + OPEN + done.length + CLOSE;
    done.push(rendered);
    pos = end.index + end[0].length;
  }
  return out + text.slice(pos);
}

/** The plain-text rendering of `html`, with blank lines collapsed and no trailing space. */
export function htmlToText(html: string): string {
  let text = html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html;
  text = text.replaceAll(OPEN, "").replaceAll(CLOSE, "");
  text = removeBlocks(text, "<!--", "-->");
  text = removeBlocks(text, "<head\\b", "<\\/head\\s*>");
  text = removeBlocks(text, "<style\\b", "<\\/style\\s*>");
  text = removeBlocks(text, "<script\\b", "<\\/script\\s*>");
  // Source line breaks are whitespace, as in a browser; only the tags below make new lines.
  text = text.replace(/\s+/g, " ");

  const links: string[] = [];
  text = takeLinks(text, links);

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^<>]*>/gi, "\n- ")
    .replace(/<\/(?:p|h[1-6]|table|ul|ol|blockquote|pre)\s*>/gi, "\n\n")
    .replace(/<\/(?:div|tr)\s*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ");

  text = decodeEntities(stripTags(text)).replace(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
    (_whole, index) => links[Number(index)] ?? "",
  );

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
