/**
 * The README of a dataset, as BIDS allows it to be named: one list, for every place that has to
 * pick which file is the README (ADR 0102, section 3).
 *
 * The submission gate reads the first present one for its ethics rule, the anonymity sweep puts
 * all four among the files it reads first, and the publication review shows the first present
 * one to its model. They used three different orders before this list existed, so a dataset with
 * two README forms could have one README for the gate and another for the review.
 *
 * The format makes no difference to any of them: a `.rst` or `.txt` README is read as text like
 * the others. Enrichment, the reindex and the webhook's trigger list keep their own lists for now
 * (#1754), and the orchestrator's `update_readme` step picks a badge source by its own rule.
 */

/** The README forms BIDS allows, in the order the first present one is chosen. */
export const README_CANDIDATES = ["README.md", "README", "README.rst", "README.txt"] as const;
export type ReadmeName = (typeof README_CANDIDATES)[number];

/**
 * The first of {@link README_CANDIDATES} present in `paths`, or null. `paths` are root paths
 * compared with their exact case, as git stores them: `readme.md` is not a README here.
 */
export function firstReadme(paths: Iterable<string>): ReadmeName | null {
  const present = new Set(paths);
  for (const name of README_CANDIDATES) if (present.has(name)) return name;
  return null;
}
