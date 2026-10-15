/**
 * Text that someone outside the platform wrote, made safe for the two places it goes.
 *
 * Two reviews read depositor or contributor text with a model and show what comes back to people:
 * the dataset pull-request review (ADR 0092) and the publication review (ADR 0102). Both need the
 * same four tools, so they live here once and neither review owns them:
 *
 *  - {@link sanitizeNote}: a model's or an author's words on their way to a person (a check-run, a
 *    terminal, an email). Plain words only, cut short.
 *  - {@link tidy} and {@link tidyPath}: an author's text on its way INTO a prompt, with control
 *    characters removed and a length cap.
 *  - {@link fence}: that text wrapped in a block named by a per-run nonce, so it cannot close its
 *    own fence and pass itself off as the platform's facts.
 *
 * Moved here unchanged from `shared/pr-review.ts` and `scripts/ci/pr-review-prompt.ts`, which
 * import them back, so a caller of either keeps working.
 */

/** The default length of a note. Equal to the pull-request review's `NOTE_MAX`; a test pins it. */
export const DEFAULT_NOTE_MAX = 200;

/**
 * Free text from a model or a pull request, made safe to put in a check-run.
 *
 * Removes what could notify a person (`@name`, `GH-12`), cross-reference an issue (`#12`), link
 * somewhere (URLs, `[text](url)`, images, HTML entities that decode to `@` or `#`), inject markup
 * (HTML tags, emphasis, table pipes, backslash escapes), or hide itself (control, zero-width and
 * bidirectional-override characters). What is left is plain words, cut to `max` characters.
 *
 * The order matters, and it is the lesson of a real bug: deleting special characters AFTER finding
 * links rebuilt them (`ht@tp://x` became `http://x`). So the special characters go first, in a
 * loop until nothing changes (removing one can reveal another), and links are found LAST. The
 * replacement text contains none of the characters stripped, so the result is a fixed point:
 * `sanitizeNote(sanitizeNote(x))` equals `sanitizeNote(x)`, which a test pins.
 */
export function sanitizeNote(input: unknown, max: number = DEFAULT_NOTE_MAX): string {
  if (typeof input !== "string") return "";
  // The loop below is quadratic on input like "![![![...", and a callback body may be 256 KB.
  // Only the start of a note is ever shown, so cut it before the work begins. The cut may split a
  // surrogate pair; \p{Cs} removes a lone half.
  const bounded = input.length > max * 8 ? input.slice(0, max * 8) : input;
  let s = bounded.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ");
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/&#?\w+;/g, " ")
      .replace(/[@#`*_~|\\<>[\]{}]/g, "")
      .replace(/\bGH-\d+/gi, "");
    if (s === before) break;
  }
  s = s
    .replace(/\b(?:https?|ftp|file|data|javascript):\/*\S*/gi, "(link removed)")
    .replace(/\bwww\.\S+/gi, "(link removed)")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(s);
  return chars.length > max
    ? `${chars
        .slice(0, max - 3)
        .join("")
        .trimEnd()}...`
    : s;
}

/** Strip control characters and cut to length. Used on every attacker-controlled string. */
export function tidy(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  const s = input.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : " "));
  return s.length > max ? `${s.slice(0, max)}\n[cut]` : s;
}

/**
 * A file name or path for the prompt. Unlike {@link tidy} it keeps NO newline or tab: a name with
 * either could forge a row in the changed-files list (`added<TAB>recordings<TAB>sub-99/x.edf`).
 */
export function tidyPath(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  const s = input.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  return s.length > max ? `${s.slice(0, max)}[cut]` : s;
}

/**
 * Wrap attacker-controlled text so it cannot close its own fence. The fence name carries a
 * random per-run nonce; as a second line, any text that looks like a closing fence is broken.
 */
export function fence(kind: string, nonce: string, text: string): string {
  const safe = text.replace(/<\/?\s*untrusted/gi, "< untrusted").replaceAll(nonce, "[nonce]");
  return `<untrusted-${nonce} kind="${kind}">\n${safe}\n</untrusted-${nonce}>`;
}
