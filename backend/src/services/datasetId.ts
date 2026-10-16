/**
 * Dataset ID generation service
 *
 * Generates IDs that reuse gaps from deleted datasets:
 * - nm000XXX for regular datasets (starting at 108)
 * - xx000XXX for sandbox datasets (starting at 1)
 * - on000XXX for OpenNeuro-sourced datasets (assigned by import, not auto-generated)
 *
 * Allocation runs UPWARD from each prefix's start and stops below the reserved
 * fixture band at the top of the range (ADR 0068). Standing test fixtures live
 * in that band and are assigned by name, never by this service.
 */

// First allocatable number for each prefix
const START_NUMBER: Record<string, number> = { nm: 108, xx: 1, on: 1 };

// Highest valid number (6-digit zero-padded IDs: 000001-099999).
// IDs above this (e.g. nm100000) break the expected nm000XXX convention.
// This is the validity cap, not the allocation cap: see RESERVED_FIXTURE_FLOOR.
const MAX_NUMBER = 99999;

// ADR 0068: the top of every allocatable band belongs to curated test fixtures,
// which are named rather than allocated. Real datasets grow UPWARD from the
// prefix's START_NUMBER; fixtures are assigned DOWNWARD from MAX_NUMBER, so a
// fixture's id is predictable without a registry and the two populations cannot
// meet until the band is 99.9% full.
//
// This replaces `EXCLUDED_IDS = new Set(["nm099999"])`, which reserved exactly
// one id and did so by accident: its comment explained it as a candidate-pool
// artifact ("nm099999 would otherwise contribute candidate 100000") rather than
// as a reservation, so nothing stopped the next fixture from being minted to a
// real depositor.
//
// The floor is NOT environment-fenced. The nemarDatasets GitHub org is shared
// between production and dev, so a production-minted nm099998 would collide
// with the dev fixture's repository even though the two D1 databases never see
// each other.
export const RESERVED_FIXTURE_FLOOR = 99900;

// Prefixes whose top band is reserved. `on` is absent deliberately: OpenNeuro
// ids are mirrored from upstream, never allocated here (generateDatasetId only
// ever emits nm or xx), so a reservation would describe a decision nothing
// makes.
const RESERVES_FIXTURE_BAND = new Set(["nm", "xx"]);

/**
 * Build a dataset id from a prefix and a number.
 *
 * Ids are fixed-width zero-padded. The dev band boundaries in this file are
 * compared as STRINGS (`id >= DEV_EPHEMERAL_BAND_START`); the reserved-band
 * check compares numbers. An unpadded id is therefore not merely ugly:
 * "xx99900" sorts above "xx099999" and silently inverts the string
 * comparisons. Nothing here interpolates a number into an id directly.
 */
export function formatDatasetId(prefix: string, n: number): string {
  return `${prefix}${n.toString().padStart(6, "0")}`;
}

/**
 * True when an id falls in its prefix's reserved fixture band.
 *
 * Reserved means NOT ALLOCATABLE, not invalid: `isValidDatasetId` still accepts
 * these ids and every route must still serve them. In use today: nm099999 (the
 * end-to-end dataset, with its own reset endpoint), nm099998 (the standing
 * anonymous deposit, built in #1434) and xx099900-xx099906 (the exemplar
 * fleet). xx099907 held the anonymous deposit before #1434 and is retired: no
 * dev D1 row and no GitHub repository, both verified 404 on 2026-09-17.
 *
 * The reservation itself is enforced by `resolveRange`; this predicate is the
 * inverse rule, and it IS a production gate: `explicitDatasetIdGate`
 * (services/upload-gate.ts) calls it on every named-id create, so changing it
 * moves what `POST /datasets` will accept. It is also cross-checked against
 * `EXEMPLAR_ID_RE`, which declares the same band separately, by a drift test.
 */
export function isReservedFixtureId(id: string): boolean {
  if (!isValidDatasetId(id)) return false;
  if (!RESERVES_FIXTURE_BAND.has(id.slice(0, 2))) return false;
  return Number.parseInt(id.slice(2), 10) >= RESERVED_FIXTURE_FLOOR;
}

// Dev/test staging (epic #923) partitions the sandbox (xx) space so the shared
// nemarDatasets GitHub org never has repo-name collisions between prod-created
// and dev/test-created sandbox datasets: prod allocates xx000001-xx089999
// (SANDBOX_ID_CEILING="89999"), dev/test allocates xx090001-xx099899
// (SANDBOX_ID_FLOOR="90001", with the top 100 reserved by ADR 0068; it was
// xx090001-xx099999 before that). The partition lives INSIDE the 6-digit/<=99999
// cap on purpose so isValidDatasetId and every prod webhook/data/zarr gate keep
// their exact semantics (xx900001 would fail validation everywhere).
//
// DEV_SANDBOX_RANGE_RE identifies a dev/test-range repo by id shape alone.
// NOTE (#1440): the webhook receiver and the deletion fence now ask
// isDevOwnedDatasetId instead, because ownership is not a function of id shape
// once a reserved `nm` fixture exists. This regex keeps its own meaning -- "is
// this a dev SANDBOX id" -- and its other callers.
// (env-independent): xx09NNNN == xx090000-xx099999, which covers the whole dev
// band (floor 90001) and the exemplar sub-band (xx099900+). The prod webhook
// receiver uses it to refuse dispatching enrichment/zarr/DOI runs against
// staging repos, whose callbacks would 404 on prod (see routes/webhooks/github).
export const DEV_SANDBOX_RANGE_RE = /^xx09\d{4}$/;

/** True when a dataset id belongs to the dev/test sandbox partition (xx09NNNN). */
export function isDevRangeDatasetId(id: string): boolean {
  return DEV_SANDBOX_RANGE_RE.test(id);
}

// The dev partition splits again: xx090001-xx099899 is the EPHEMERAL band that
// the dev cleanup cron may delete, and xx099900-xx099999 is the curated
// exemplar fleet, which is never auto-deleted. Bounds are half-open
// [START, END) and safe to compare as strings because ids are fixed-width
// zero-padded (epic #923 Phase 7).
export const DEV_EPHEMERAL_BAND_START = "xx090001";
// Derived from RESERVED_FIXTURE_FLOOR rather than written out, because the two
// said the same thing in two places and only one of them was enforced: the
// cleanup cron honored this boundary while the allocator ran straight through
// it (ADR 0068).
export const DEV_EPHEMERAL_BAND_END = formatDatasetId("xx", RESERVED_FIXTURE_FLOOR);

// Reserved ids the NON-PRODUCTION worker owns outright (#1440).
//
// `isDevRangeDatasetId` (xx09NNNN) was quietly answering two different
// questions: "is this a dev SANDBOX dataset" and "does the dev worker own
// this". They were the same set until the standing anonymous deposit moved to
// a reserved `nm` id (ADR 0068), which is the second and not the first.
//
// A declared list rather than a rule, deliberately, and ADR 0068 rejected
// exactly that shape for the ALLOCATOR. The allocator needed a rule, because
// "which id does the next fixture get" has to be answerable without consulting
// a list. This is a different question: which environment owns a given standing
// fixture is a FACT about that fixture, not something derivable from its id.
// Ownership is not a function of position either, which rules out splitting the
// reserved band by owner: nm099999 and nm099998 are adjacent and differ.
//
// **nm099997 is declared before it exists.** It is the standing fixture the publication
// review (ADR 0102) is exercised against on the dev worker: a native, named, private deposit.
// An undeclared fixture is invisible to the dev worker and claimed by the production one, so the
// release that ships the review must already carry this line, or production would dispatch
// enrichment for a repository it has no row for from the day the fixture is created.
//
// **nm099999 is deliberately absent.** It exists in BOTH production and dev D1
// (production holds it among its 203 nm rows), and it is maintained through
// `POST /admin/datasets/nm099999/reset` rather than a delete-and-recreate
// cycle. Adding it here would let a non-production worker cascade-delete a
// GitHub repository production also uses.
export const DEV_OWNED_FIXTURE_IDS: ReadonlySet<string> = Object.freeze(
  new Set(["nm099998", "nm099997"]),
) as ReadonlySet<string>;

/**
 * Ids the non-production worker must NEVER own, however the set is edited.
 *
 * `nm099999` is reserved AND a fixture AND still production's: it exists in
 * both catalogs and is maintained through `POST /admin/datasets/nm099999/reset`
 * rather than a delete-and-recreate cycle. It is named here rather than left to
 * a reviewer's memory, because the cost of it drifting into the set is a
 * non-production worker cascade-deleting a repository production also uses.
 *
 * Note the reset endpoint itself is not environment-fenced and already deletes
 * and recreates that repository from whichever worker serves the request, which
 * is how `nemar admin e2e-test` works against staging. The cascade fence still
 * prevents the unrecoverable variant, row plus S3 plus repo with no recreate,
 * so keeping `nm099999` out of the set remains right; it just protects less
 * than "dev can never touch it".
 *
 * Membership decides THREE things, not only deletion: webhook ownership and the
 * blocked-BIDS sweep's scope read it too. So excluding `nm099999` also means
 * the dev worker answers `prod_range_repo_on_dev_worker` for pushes to its
 * repository while production claims them, even though dev D1 holds a row for
 * it. That is pre-existing (`isDevRangeDatasetId("nm099999")` was false too)
 * and harmless in practice, because `src/lib/e2e-test.ts` does not depend on
 * enrichment running. It is recorded because it is the same symptom the
 * declared set exists to cure, and someone comparing the two will otherwise
 * read it as an oversight.
 */
export const NEVER_DEV_OWNED_IDS: ReadonlySet<string> = Object.freeze(
  new Set(["nm099999"]),
) as ReadonlySet<string>;

/**
 * The id a test may rely on being ABSENT, forever.
 *
 * Four live tests picked `nm099998` for this, each commented "valid format
 * within the cap, but unlikely to be allocated". Unlikely is a guess, and this
 * epic then designated that exact id as the standing anonymous deposit, so
 * building the fixture turned four passing tests red at once. A test that needs
 * a 404 needs an id that CANNOT become real, not one that probably will not.
 *
 * `nm099900` is the FLOOR of the reserved band, and both halves of that matter.
 * Reserved means `generateDatasetId` can never return it (ADR 0068), so no
 * upload will ever claim it. The floor specifically, because fixtures are
 * assigned DOWNWARD from `nm099999`, so it is the last id in the band a fixture
 * would ever reach -- and naming it here is what stops one from reaching it,
 * since `explicitDatasetIdGate` also requires membership in
 * `DEV_OWNED_FIXTURE_IDS`, which this must never join.
 *
 * Exported so the tests import the declaration rather than re-guessing. A
 * future fixture that wants this id has to delete this constant and find the
 * four tests, which is the point.
 */
export const ABSENT_DATASET_ID = formatDatasetId("nm", RESERVED_FIXTURE_FLOOR);

/**
 * True when the non-production worker OWNS this dataset: it may delete it, its
 * webhook deliveries belong to dev, and production must not act on them.
 *
 * Distinct from `isDevRangeDatasetId`, which answers "is this a dev sandbox
 * id". Every dev sandbox id is dev-owned, but not every dev-owned id is a
 * sandbox id. Keep the two separate: conflating them is what made a reserved
 * `nm` fixture invisible to dev and visible to production at the same time.
 */
export function isDevOwnedDatasetId(id: string): boolean {
  return isDevRangeDatasetId(id) || DEV_OWNED_FIXTURE_IDS.has(id);
}

/**
 * True when a dataset id is in the dev EPHEMERAL sandbox band, i.e. the only
 * ids the non-production cleanup cron is allowed to delete. Excludes the
 * exemplar fleet (xx099900+) and prod's sandbox band (<= xx089999).
 */
export function isDevEphemeralSandboxId(id: string): boolean {
  return (
    DEV_SANDBOX_RANGE_RE.test(id) && id >= DEV_EPHEMERAL_BAND_START && id < DEV_EPHEMERAL_BAND_END
  );
}

/**
 * Resolve the effective [start, max] allocation window for a prefix.
 *
 * An explicit floor never drops below the prefix's natural start; an explicit
 * ceiling never exceeds the prefix's allocatable cap. A non-finite bound
 * (NaN/Infinity/missing) is treated as absent, so the invariant "a bad bound
 * can only narrow within [start, cap], never mint an out-of-convention id"
 * holds at this layer regardless of caller discipline. Single source of truth
 * for both the allocator loop and the exhaustion error message.
 *
 * The cap is the reserved fixture floor minus one where the prefix has one
 * (ADR 0068), not MAX_NUMBER. Enforcing it HERE rather than as a filter in the
 * candidate loop is what makes the exhaustion error honest: a caller that runs
 * out of ids is told the ceiling it actually hit, instead of being told 99999
 * while the allocator silently stopped at 99899.
 */
function resolveRange(
  prefix: string,
  opts?: { start?: number; max?: number },
): { start: number; max: number } {
  const natural = START_NUMBER[prefix] ?? 1;
  const cap = RESERVES_FIXTURE_BAND.has(prefix) ? RESERVED_FIXTURE_FLOOR - 1 : MAX_NUMBER;
  const s = opts?.start;
  const m = opts?.max;
  // Rounded INWARD (ceil the floor, floor the ceiling) so a non-integer bound
  // narrows like every other bad bound. Without this a fractional floor is
  // carried through the candidate loop into formatDatasetId, where
  // (90001.5).toString() is already 7 characters and padStart(6) is a no-op:
  // the allocator returns "xx90001.5", which is not a dataset id at all.
  // isValidDatasetId, isDevRangeDatasetId and isDevEphemeralSandboxId all
  // answer false for it, so the prod webhook's staging guard never fires and
  // the dev cleanup cron can never delete it. Escaping the id space is worse
  // than entering the reserved band, and the upload route is one
  // Number.parseInt -> Number edit away from reaching it.
  const start =
    typeof s === "number" && Number.isFinite(s) ? Math.max(natural, Math.ceil(s)) : natural;
  const max = typeof m === "number" && Number.isFinite(m) ? Math.min(cap, Math.floor(m)) : cap;
  return { start, max };
}

/**
 * Find the lowest unused number for a given prefix.
 *
 * Generates candidate numbers (start, plus each existing_number+1) and picks
 * the smallest one not already taken. No recursion, so no SQLite depth limit.
 */
async function findLowestUnusedNumber(
  db: D1Database,
  prefix: string,
  opts?: { start?: number; max?: number },
): Promise<number | null> {
  const { start, max } = resolveRange(prefix, opts);
  const likePattern = `${prefix}%`;

  // Two-step approach to avoid D1 parameter binding issues with complex queries
  // Step 1: Get all candidate numbers
  const candidatesResult = await db
    .prepare(
      `SELECT CAST(SUBSTR(dataset_id, 3) AS INTEGER) + 1 AS candidate
       FROM datasets WHERE dataset_id LIKE ?`,
    )
    .bind(likePattern)
    .all<{ candidate: number }>();

  const existingIds = new Set(
    (
      await db
        .prepare("SELECT dataset_id FROM datasets WHERE dataset_id LIKE ?")
        .bind(likePattern)
        .all<{ dataset_id: string }>()
    ).results.map((r) => r.dataset_id),
  );

  // Step 2: Find the lowest unused candidate in JS
  const candidates = new Set([start, ...candidatesResult.results.map((r) => r.candidate)]);
  let minUnused: number | null = null;

  for (const candidate of candidates) {
    if (candidate < start || candidate > max) continue;
    const id = formatDatasetId(prefix, candidate);
    if (!existingIds.has(id)) {
      if (minUnused === null || candidate < minUnused) {
        minUnused = candidate;
      }
    }
  }

  return minUnused;
}

/**
 * Generate the next dataset ID by finding the lowest unused number.
 *
 * Queries existing datasets to find gaps from deletions, reusing freed IDs
 * before allocating new ones.
 *
 * Never returns an id in the reserved fixture band (ADR 0068). Dev is the case
 * that needed this: it sets SANDBOX_ID_FLOOR=90001 and NO ceiling, so before
 * the reservation its window was [90001, 99999] and ran straight through the
 * exemplar fleet at xx099900+ that DEV_EPHEMERAL_BAND_END already declared
 * off-limits to the cleanup cron. The fleet was protected only by its ids
 * happening to be taken already.
 *
 * @param db - D1 database instance
 * @param sandbox - If true, generates xx000XXX sandbox ID instead of nm000XXX
 * @param opts - Optional sandbox range partition (epic #923). `sandboxIdFloor`
 *   raises the lowest allocatable xx number (dev/test set 90001); `sandboxIdCeiling`
 *   lowers the highest (prod sets 89999). Ignored for the nm prefix. Both clamp to
 *   the natural [start, cap] bounds, so a bad value only narrows the range.
 */
export async function generateDatasetId(
  db: D1Database,
  sandbox = false,
  opts?: { sandboxIdFloor?: number; sandboxIdCeiling?: number },
): Promise<string> {
  const prefix = sandbox ? "xx" : "nm";
  const range = sandbox ? { start: opts?.sandboxIdFloor, max: opts?.sandboxIdCeiling } : undefined;
  const n = await findLowestUnusedNumber(db, prefix, range);

  if (n === null) {
    const { start: lo, max: hi } = resolveRange(prefix, range);
    // Only when the reservation is what the caller actually hit. For prod xx the
    // binding constraint is SANDBOX_ID_CEILING=89999, and blaming the reserved
    // band there would send an operator to the wrong place.
    const reserved =
      RESERVES_FIXTURE_BAND.has(prefix) && hi === RESERVED_FIXTURE_FLOOR - 1
        ? `; ${formatDatasetId(prefix, RESERVED_FIXTURE_FLOOR)}-${formatDatasetId(prefix, MAX_NUMBER)} is the reserved fixture band and is never allocated (ADR 0068)`
        : "";
    throw new Error(
      `Failed to generate dataset ID for prefix '${prefix}': all IDs from ${lo} to ${hi} are allocated${reserved}`,
    );
  }

  return formatDatasetId(prefix, n);
}

/**
 * Get the next number that would be allocated (without allocating it)
 */
export async function getCurrentSequence(db: D1Database): Promise<number> {
  return (await findLowestUnusedNumber(db, "nm")) ?? 108;
}

/**
 * Check if a dataset ID is valid format
 * Accepts nm000XXX (regular), xx000XXX (sandbox), and on000XXX (OpenNeuro) formats
 */
export function isValidDatasetId(id: string): boolean {
  if (!/^(nm|xx|on)\d{6}$/.test(id)) return false;
  // Enforce upper bound: numeric part must be <= 99999 (i.e. 0-padded to 6 digits)
  const num = Number.parseInt(id.slice(2), 10);
  return num <= MAX_NUMBER;
}

/**
 * Check if a dataset ID is a sandbox dataset
 */
export function isSandboxDatasetId(id: string): boolean {
  return id.startsWith("xx");
}
