/**
 * Deterministic submission minimums for native publication requests
 * (#1087, ADR 0026; policy: docs.nemar.org/policies/submission-standards/).
 *
 * Owner decision 2026-08-18: a descriptive Name of at least 25 characters,
 * named non-placeholder Authors, and an ethics approval statement are hard
 * requirements for native submissions. These are the mechanically checkable
 * checks; adequacy beyond them (is the name meaningful, is the README about
 * THIS dataset) stays LLM-judged and advisory per ADR 0014's surviving half.
 *
 * Pure evaluation over file contents so the decision is unit-testable without
 * GitHub; the route fetches the two files and passes them in. OpenNeuro
 * imports and exemplars are exempted by the caller, not here.
 */

export const SUBMISSION_POLICY_URL = "https://docs.nemar.org/policies/submission-standards/";

export const MIN_NAME_LENGTH = 25;

/**
 * Author entries that read as "nobody": empty, n/a-style sentinels, anonymous,
 * bracketed placeholders like "[Unspecified1]" (the MOABB failure mode from
 * #817), or strings containing "unspecified"/"placeholder".
 *
 * "anonymous" is matched as a LEADING WORD rather than as the whole string
 * (#1408). The bare-word form was written when this rule only ever rejected
 * placeholders; now that an anonymous release requires them, the exact
 * spelling matters in the opposite direction, and the anchored form refused
 * the very label NEMAR itself publishes in place of an author list
 * (`ANONYMOUS_AUTHORS_LABEL`, "Anonymous (withheld until publication)"). A
 * depositor who copied the string from their own dataset page was told their
 * blinded file "still names Anonymous (withheld until publication)". The same
 * applies to the natural variants -- "Anonymous (blinded for review)",
 * "Anonymous Authors". An entry that opens with the word is asserting
 * anonymity, not naming a person.
 */
const PLACEHOLDER_AUTHOR =
  /^(n\/?a|none|tbd|todo|unknown|-+)$|^anonymous\b|^\[.*\]$|unspecified|placeholder/i;

/**
 * Ethics statement detection in a README: any of the conventional phrasings.
 * Deliberately generous — the requirement is that SOME ethics statement
 * exists, not that it follows a template; false negatives here send a human
 * to docs, false positives are caught by admin review.
 */
const ETHICS_IN_README =
  /\b(ethic(s|al)?\s+(approval|committee|board|review|statement|clearance|exemption)|IRB|REB|HREC|institutional\s+review\s+board|informed\s+consent|research\s+ethics)\b/i;

/** Which submission this is, which changes what the Authors rule demands. */
export interface SubmissionMinimumsOptions {
  /**
   * This submission is an ANONYMOUS RELEASE (#1408), so the Authors rule
   * INVERTS rather than relaxes.
   *
   * A publication requires named authors. An anonymous release requires the
   * opposite: `Authors` must NOT name anybody. `dataset_description.json` is
   * part of the dataset -- git-tracked, and served publicly from the data
   * plane -- so a real name there defeats the blind no matter what NEMAR
   * withholds elsewhere. The depositor blinds their own file, exactly as they
   * would blind a manuscript for a double-blind venue, and NEMAR refuses the
   * release if they have not.
   *
   * Permitting rather than requiring was the first draft, and it was wrong: it
   * let a depositor ask for an anonymous release, pass every gate, and be
   * named by their own file on a public dataset page.
   *
   * NEMAR enforces this for `Authors` because the field is structured. It
   * cannot for README, `participants.tsv`, or identifiers inside signal
   * headers -- those are REPORTED by phase 4's blind check, never enforced
   * here, and no copy anywhere may imply otherwise.
   *
   * Every other minimum still applies unchanged: a blinded deposit needs a
   * descriptive Name and an ethics statement like any other.
   */
  anonymousRelease?: boolean;
}

/**
 * Does this Authors-style entry name nobody?
 *
 * Exported so the anonymity sweep (#1409) asks the SAME question this gate
 * asks. The two run at different moments -- the gate once, at the publication
 * request; the sweep on a schedule, over a deposit whose files keep changing
 * while its repository is private -- and they must not be able to disagree
 * about what counts as a placeholder.
 */
export function isPlaceholderAuthor(entry: string): boolean {
  return PLACEHOLDER_AUTHOR.test(entry.trim());
}

/** Does `EthicsApprovals` list at least one non-empty approval? */
function listsEthicsApproval(desc: Record<string, unknown>): boolean {
  return (
    Array.isArray(desc.EthicsApprovals) &&
    desc.EthicsApprovals.some((e) => typeof e === "string" && e.trim().length > 0)
  );
}

/**
 * Does this `dataset_description.json` text list an ethics approval itself?
 * When it does, the README cannot change the ethics verdict and need not be
 * read; a missing, unparseable or non-object description lists none.
 */
export function describesEthicsApproval(descriptionJson: string | null): boolean {
  if (descriptionJson === null) return false;
  try {
    const parsed: unknown = JSON.parse(descriptionJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    return listsEthicsApproval(parsed as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** Reasons are user-facing: each states the failure AND the fix. */
export function evaluateSubmissionMinimums(
  descriptionJson: string | null,
  readme: string | null,
  options: SubmissionMinimumsOptions = {},
): string[] {
  if (descriptionJson === null) {
    return ["dataset_description.json was not found at the dataset root."];
  }

  let desc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(descriptionJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return ["dataset_description.json is not a JSON object."];
    }
    desc = parsed as Record<string, unknown>;
  } catch {
    return ["dataset_description.json is not valid JSON."];
  }

  const reasons: string[] = [];

  const name = typeof desc.Name === "string" ? desc.Name.trim() : "";
  if (name.length < MIN_NAME_LENGTH) {
    reasons.push(
      `Dataset Name must be a descriptive title of at least ${MIN_NAME_LENGTH} characters (currently ${name.length}). If the study is known by a short acronym, expand it with a subtitle, e.g. "ACRO: auditory cortex recordings during natural speech".`,
    );
  }

  const authors = Array.isArray(desc.Authors)
    ? desc.Authors.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map(
        (a) => a.trim(),
      )
    : [];
  const realAuthors = authors.filter((a) => !isPlaceholderAuthor(a));
  // The two rules are exact COMPLEMENTS, not a relaxation: a publication needs
  // at least one real name, a blinded release needs none. Both need a
  // non-empty field, because an empty Authors is an incomplete file rather
  // than a blinded one.
  if (options.anonymousRelease) {
    if (authors.length === 0) {
      reasons.push(
        "Authors in dataset_description.json must not be empty, even for an anonymous " +
          'release: set it to a placeholder such as "Anonymous" so the field states that ' +
          "attribution is withheld rather than missing.",
      );
    } else if (realAuthors.length > 0) {
      reasons.push(
        `This is an anonymous release, but Authors in dataset_description.json still names ${realAuthors.join(", ")}. That file is part of the dataset and is served publicly, so NEMAR cannot conceal what it says. Replace the entries with a placeholder such as "Anonymous", commit, and request the release again. Restore the real names when you publish after acceptance.`,
      );
    }
  } else if (realAuthors.length === 0) {
    reasons.push(
      "Authors in dataset_description.json must name the people responsible for the " +
        "dataset; anonymous submissions and placeholder entries are not accepted.",
    );
  }

  const ethicsInReadme = readme !== null && ETHICS_IN_README.test(readme);
  if (!listsEthicsApproval(desc) && !ethicsInReadme) {
    reasons.push(
      "An ethics approval statement is required: fill the EthicsApprovals field of " +
        "dataset_description.json, or add an ethics/IRB statement to the README.",
    );
  }

  return reasons;
}
