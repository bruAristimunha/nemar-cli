/**
 * Entry point for `nemar __complete -- <words...>` (epic #1144 phase 5b,
 * issue #1149, D1). `program` is passed in by src/index.ts's `main()` rather
 * than imported from a module that imports index.ts, so this file never
 * creates an import cycle back to the module that builds the Command tree.
 *
 * Two guarantees this function makes that nothing else in the CLI has to:
 * it never performs network I/O (D1 -- not even a fetch with a short
 * timeout, since a timeout still pays DNS and connect on exactly the
 * captive-portal networks where this matters), and CANDIDATE RESOLUTION
 * never throws. The scope of that second one is deliberate: the try/catch
 * covers getCandidates(), not the stdout writes after it, so an EPIPE from
 * a closed stdout is still unhandled. Every shell script here invokes this
 * via command substitution and reads to EOF, so that path is not reachable
 * from the supported callers -- but it is not a whole-function guarantee
 * and the earlier wording implied it was (#1173 review). A
 * completion request that crashes mid-TAB is worse than one that silently
 * offers nothing, so any failure in candidate resolution is swallowed here
 * and degrades to zero candidates -- the same "no stack trace at the
 * prompt" policy D3 applies to the cache, extended to this whole path.
 */

import type { Command } from "commander";
import { CompletionDirective, getCandidates } from "./candidates.js";

/**
 * Matches a newline, carriage return, or any other C0/DEL control character
 * (#1173 review). The wire format every shell script here parses is one
 * candidate per line, terminated by a final `:<directive>` line -- a
 * candidate that itself contains "\n" splits into an extra line that every
 * consumer (bash's `read` loop, zsh's `${(@f)...}`, fish's newline-split
 * `$lines`) reads as its own, unrelated candidate. Worse, a value shaped
 * like `"rest\n:4"` produces a line that is indistinguishable from the real
 * trailing directive.
 *
 * `facetVocabularyEntrySchema.value` (shared/contract/dataset.ts) is an
 * unconstrained `z.string()` sourced from live dataset metadata, so this is
 * attacker-influenceable in the weak sense: whatever ends up in a dataset's
 * metadata reaches every user's shell through this path.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control chars is the point
const UNSAFE_CANDIDATE_PATTERN = /[\u0000-\u001f\u007f]/;

export async function runComplete(program: Command, argv: string[]): Promise<void> {
  // The shell scripts (D4) always invoke `nemar __complete -- <words...>`;
  // drop the literal `--` separator if the caller passed it through.
  const words = argv[0] === "--" ? argv.slice(1) : argv;

  let candidates: string[] = [];
  try {
    candidates = getCandidates(program, words);
  } catch (err) {
    if (process.env.VERBOSE) {
      process.stderr.write(
        `[completion] candidate lookup failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    candidates = [];
  }

  for (const candidate of candidates) {
    // Drop rather than mangle: a dropped candidate is merely invisible at
    // the prompt, while rewriting/escaping it risks silently offering some
    // OTHER real value instead of the one the user typed toward.
    if (UNSAFE_CANDIDATE_PATTERN.test(candidate)) continue;
    process.stdout.write(`${candidate}\n`);
  }
  process.stdout.write(`:${CompletionDirective.NoFileComp}\n`);
}
