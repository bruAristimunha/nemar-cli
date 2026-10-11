/**
 * Which subcommands a command group leads with in plain `--help`.
 *
 * `nemar admin` carries 43 subcommands and `nemar dataset` 21, and most of
 * them are not what anyone came for: a one-off backfill, a sweep that runs
 * from cron and is invoked by hand about once a year, a git-level escape
 * hatch. Listing all of them flat makes the three or four commands people
 * actually type as hard to find as the rest.
 *
 * So plain `--help` renders the names below, in the order they appear here,
 * and folds everything else into a single comma-separated "More commands"
 * line. `--help-all` renders the full list with descriptions, as before.
 *
 * Two properties this table deliberately has:
 *
 * - **It is presentation only.** Nothing here calls Commander's `hidden`,
 *   so a folded command is still dispatched, still completes on TAB
 *   (lib/completion/candidates.ts walks `cmd.commands`), and still has its
 *   own `--help`. The only thing that changes is which names carry a
 *   description in the parent's listing.
 * - **It fails open.** A command missing from this table lands in "More
 *   commands", never nowhere. Adding a subcommand and forgetting this file
 *   costs it a line of prominence, not its visibility.
 *
 * Keyed by the command path below the program name, space-separated
 * (`"dataset"`, `"admin"`, and `"dataset publish"` if a nested group ever
 * needs it). `test/help-tiers.unit.test.ts` fails if a key names a group
 * that does not exist or an entry names a subcommand that does not.
 */
export const COMMON_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  // The deposit-then-consume arc, in the order a depositor meets it, with the
  // two commands a consumer types (search, download) kept adjacent.
  dataset: ["search", "download", "upload", "validate", "status", "list"],

  // Day-to-day operator work: the user queue, the publication queue, the pull-request queue, DOIs,
  // and the two destructive-but-routine dataset actions. Everything under
  // `import*`, every `*-sweep`, every `backfill-*`, and the fleet/exemplar/
  // zarr/s3/repo groups are deliberately absent -- they are run from cron or
  // a handful of times a year.
  admin: [
    "users",
    "approve",
    "revoke",
    "publish",
    "pr-reviews",
    "doi",
    "make-public",
    "delete-dataset",
    "notify",
    "doctor",
  ],
};
