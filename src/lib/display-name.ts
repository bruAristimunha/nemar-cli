/**
 * Showing a file name to a person.
 *
 * A name is data from the user's directory, and printing it raw lets a newline split a
 * one-name-per-line list and an ESCAPE start a terminal control sequence. The messages of
 * the upload steps list names through {@link displayName}.
 */

/**
 * Characters that must not reach a terminal or break a one-name-per-line list: C0 and C1
 * controls (a newline, an ESCAPE that starts a terminal sequence), the Unicode line and
 * paragraph separators (U+2028, U+2029), and the bidirectional embeddings, overrides and
 * isolates (U+202A to U+202E, U+2066 to U+2069) that reorder what is displayed.
 */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A file name as it is shown to a person: each character above written out as an escape
 * (a newline as `\n`, an ESCAPE as `\x1b`, a right-to-left override as `\u202e`),
 * everything else as it is.
 */
export function displayName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARACTERS, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    const code = c.codePointAt(0) ?? 0;
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Names as shown, joined for one line of a message. */
export function displayNames(names: readonly string[], separator = ", "): string {
  return names.map(displayName).join(separator);
}

/**
 * Whether a name can be put in a command a person will copy and run. A character
 * {@link displayName} would escape would reach the terminal raw (an ESCAPE) or split the
 * command across lines (a newline), and no quoting that works in every shell fixes that,
 * so such a name is not printed in a command at all.
 */
export const isPrintableInCommand = (name: string): boolean => displayName(name) === name;
