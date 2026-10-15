/**
 * What a web page must not print: the words only a terminal can act on, and the words that point
 * at one (ADR 0102, section 8; Phase 4 of epic #1726). One list, so the tests that pin the
 * Worker's sentences and the page's own copy hold the same line.
 *
 * `nemar` is case-sensitive: the platform is written NEMAR in a reason's sentence and in the
 * identifier screen's date warning, and neither names a command. The lowercase word is the
 * command's name whatever follows it ("nemar admin", "Run nemar.", "the nemar-cli tool"), so only
 * a domain (`nemar.org`) and a longer word are spared.
 */

/** Tier 1: what only a terminal can act on. Applies to every string a page prints. */
const TIER1: ReadonlyArray<[string, RegExp]> = [
  ["a nemar command", /(?<![A-Za-z0-9@./-])nemar(?![A-Za-z0-9]|\.[a-z])/],
  // A long flag anywhere, or a short one that starts a token ("pass -f to it", "(-v)").
  ["a flag", /--[A-Za-z]|(^|[\s(])-[A-Za-z]\b/],
  // Any `<name>`: a placeholder is a lowercase word, a hyphenated one, a capitalized one, a phrase.
  ["a placeholder", /<[A-Za-z][\w -]*>/],
  ["a backtick", /`/],
];

/**
 * Tier 2: words that point at a terminal. Applies to reason sentences, cures, statements,
 * headlines, screen lines and the start refusals; not to a sentence that only names "the command
 * line tool", which describes it and tells nobody to type anything.
 */
const TIER2: ReadonlyArray<[string, RegExp]> = [
  ["the word terminal", /\bterminals?\b/i],
  ["the word shell", /\bshell\b/i],
  ["the word command", /\bcommand\b/i],
  ["the word CLI", /\bCLI\b/],
];

/** The names of the rules `text` breaks: tier 1 alone, or tiers 1 and 2 (the default). */
export function terminalFlaws(text: string, tier: 1 | 2 = 2): string[] {
  const rules = tier === 1 ? TIER1 : [...TIER1, ...TIER2];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
