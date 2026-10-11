/**
 * Username format, default, and collision rules (epic #1250, phase #1253).
 *
 * Two populations need a username and have no way to get one today:
 *   - web/ORCID sign-ups, whose `users.username` is NULL by design
 *     (migration 0026) and stays NULL forever -- 19 live rows;
 *   - anyone who wants to request upload access, since the request's admin
 *     review card and `nemar admin approve <username>` are both keyed on it.
 *
 * ADR 0042 fixes the default at FIRST INITIAL + FAMILY NAME (`alovelace`),
 * derived from the same `given_name`/`family_name` pair ADR 0041 made
 * canonical for DOI attribution. That keeps one name in play per account
 * rather than a handle invented at a form and a name read from ORCID.
 *
 * Everything here is pure so the rules are testable without a Worker (same
 * reasoning as profile.ts and orcid-auth.ts's decision helpers); the DB reads
 * that feed `taken` live at the call sites.
 */

/**
 * The username rule, matching `GET /auth/check-username` exactly (and the CLI
 * signup form's schema, which has since been removed, ADR 0097): 3-30
 * characters of letters, digits, underscore or hyphen.
 *
 * Spelled out here as bounds plus a character-class regex rather than one
 * combined pattern so `validateUsernameFormat` can say WHICH rule was broken,
 * which a single regex cannot.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_CHARSET_RE = /^[a-zA-Z0-9_-]+$/;

/** Why a submitted username was refused; `null` when it is well-formed. */
export type UsernameFormatError = "username_too_short" | "username_too_long" | "username_charset";

export function validateUsernameFormat(username: string): {
  error: UsernameFormatError;
  message: string;
} | null {
  if (username.length < USERNAME_MIN_LENGTH) {
    return {
      error: "username_too_short",
      message: `Username must be at least ${USERNAME_MIN_LENGTH} characters`,
    };
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return {
      error: "username_too_long",
      message: `Username must be at most ${USERNAME_MAX_LENGTH} characters`,
    };
  }
  if (!USERNAME_CHARSET_RE.test(username)) {
    return {
      error: "username_charset",
      message: "Username can only contain letters, numbers, underscores, and hyphens",
    };
  }
  return null;
}

/**
 * Fold a name to the ASCII subset a username may contain.
 *
 * `normalize("NFD")` is what makes this a FOLD rather than a strip, and it is
 * the whole trick: it splits a precomposed letter into base + combining mark
 * (é -> e + U+0301), so the `[^a-z0-9-]` pass below drops the mark and keeps
 * the `e`. Without the normalize, `Ekström` would come out `ekstrm` -- the
 * letter deleted rather than folded. (An explicit `\p{M}` removal between the
 * two would be redundant for exactly that reason: a combining mark is not in
 * `[a-z0-9-]` either.)
 *
 * Characters with no ASCII base at all (CJK, Cyrillic, an emoji) leave nothing
 * behind -- which is why `suggestUsername` can legitimately return null for a
 * real, well-formed name, and why nothing here ever invents a substitute from
 * the email address (ADR 0042).
 */
export function asciiFold(value: string): string {
  return value
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The default username for a name: first initial + family name, folded.
 *
 * Returns null when the result is unusable -- no family name, or a family name
 * that folds away to nothing (or to fewer than the minimum characters). A null
 * here is reported to the caller as "we cannot suggest one", never patched up:
 * the alternative is guessing from the email local part, which produces a
 * handle the person never chose and cannot recognise as theirs.
 *
 * The given name contributes at most its first FOLDED character, so `Émile
 * Durkheim` suggests `edurkheim` and not `Édurkheim`; a given name that folds
 * to nothing contributes nothing rather than blocking the suggestion.
 */
export function suggestUsername(
  givenName: string | null | undefined,
  familyName: string | null | undefined,
): string | null {
  const family = asciiFold((familyName ?? "").trim());
  if (!family) return null;
  const given = asciiFold((givenName ?? "").trim());
  const base = `${given.slice(0, 1)}${family}`;
  const trimmed = base.slice(0, USERNAME_MAX_LENGTH).replace(/-+$/, "");
  if (trimmed.length < USERNAME_MIN_LENGTH) return null;
  return trimmed;
}

/**
 * The first free variant of `base`: `base`, then `base-2`, `base-3`, ...
 *
 * `taken` is compared case-insensitively because `users.username` is UNIQUE
 * case-SENSITIVELY (migration 0001) while every check around it is
 * `COLLATE NOCASE` -- so `Alovelace` must count as taking `alovelace`.
 *
 * The suffix is appended after truncating the base far enough back to keep the
 * result inside {@link USERNAME_MAX_LENGTH}: a 30-character family name must
 * not silently produce a 32-character username that the format check then
 * rejects.
 *
 * Gives up after `limit` attempts and returns null rather than looping: a
 * caller that has genuinely exhausted 50 variants of one name has a problem no
 * suffix will solve, and an unbounded loop inside a Worker request is worse
 * than an honest "could not pick one".
 */
export const USERNAME_SUFFIX_LIMIT = 50;

export function pickAvailableUsername(
  base: string,
  taken: Iterable<string>,
  limit = USERNAME_SUFFIX_LIMIT,
): string | null {
  const used = new Set<string>();
  for (const t of taken) used.add(t.trim().toLowerCase());

  for (let n = 1; n <= limit; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const head = base.slice(0, USERNAME_MAX_LENGTH - suffix.length).replace(/-+$/, "");
    if (head.length < USERNAME_MIN_LENGTH) return null;
    const candidate = `${head}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

/**
 * True when `err` is SQLite/D1 refusing a duplicate `users.username`.
 *
 * The NOCASE pre-check in front of every username write is strictly stricter
 * than the column's own case-SENSITIVE UNIQUE constraint, so this only fires
 * in the TOCTOU window between that check and the write -- two concurrent
 * claims on the same free name. Without it the loser gets a 500 for what is
 * really "someone else just took it".
 *
 * A predicate rather than an inline `String(err).includes(...)` at each call
 * site so both writers (PATCH /auth/profile and the backfill sweep) classify
 * the same error the same way, and so a test can feed it a REAL constraint
 * error raised by a real duplicate insert.
 */
export function isUsernameUniqueViolation(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("UNIQUE constraint failed") && msg.includes("users.username");
}
