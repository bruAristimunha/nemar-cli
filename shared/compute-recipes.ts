/**
 * NEMAR's own processing recipes, as the compute gateway's pipeline dispatch knows them (epic #2005
 * phase A6, #2011; ADR 0118; design section 10). Pure and import-free, like `./compute-state.ts`, so
 * the Worker, the command-line interface and the tests read one table.
 *
 * WHAT A RECIPE ENTRY IS. The Worker's side of a recipe that lives in `nemarOrg/nemar-process`: its
 * name, the version and the engine the Worker EXPECTS it to report, the Tapis application that runs
 * it, the partition and resources one job asks for, and the files a finished run must have written.
 * The recipe's code, the images and the application definitions are that repository's. Every number
 * here is initial: the owner adjusts it with the pilot, and the application id and version follow
 * whatever `nemar-process` publishes. A test pins only that every entry is a valid job under
 * `JobSpecSchema` and inside the partition table.
 *
 * `version` AND `engine` ARE EXPECTATIONS, NOT FACTS. The stamp a run leaves (`compute_pipeline_stamps`)
 * is claimed with these values and, when the run succeeds, rewritten from the recipe's own record
 * (`readRecipeRecord`), so it says what actually ran. A recipe whose record disagrees with this table
 * is a registry out of date, and the daily dispatcher stops dispatching it until the table is fixed
 * (`registry_drift`).
 *
 * HOW A RECIPE IS RUN (nemar-process `docs/recipes.md`). The launcher runs an argument vector, so no
 * shell ever expands a variable: the paths below are absolute. The dataset is bound read-only at
 * `/data/<id>` and the job's outputs directory is `/work/outputs`. The launch specification's
 * environment allowlist is closed to six names and has none for an image digest, so the digest travels
 * as the ARGUMENT `--image-digest`. The recipe cannot check that value against the image it runs in; it
 * is the caller's claim, and the Worker compares it with the launcher's `provenance.json` before it
 * accepts a result (`recipeImageDigestArg`).
 *
 * TWO INPUTS, TWO EXECUTORS (portable compute, ADR 0121, plan D12). A recipe lists the `inputs` it reads:
 * `bids` (the dataset the launcher stages and binds read-only, the arguments above) or `zarr` (nothing
 * staged: the recipe streams the dataset's Zarr serving copy from `--zarr-base`, the one origin it may open,
 * and the Worker passes the commit that copy was built from, the version's tag commit and how they are
 * equivalent as `--source-commit`, `--tag-commit`, `--commit-equivalence` and `--commit-delta-path`;
 * `recipeZarrArguments`). The input is chosen in the COMMAND (`nemar-recipe run nemar-floor --input zarr`,
 * `recipeCommand`), not in the arguments: a Zarr job's arguments are the fixed ones and the delta paths,
 * which fill the 64 a job may carry (`ZARR_SOURCE_MAX_DELTA_PATHS`), so a BIDS run, whose command and
 * arguments are what they always were, and a Zarr run differ only in the two words after the recipe's name.
 * `executors` lists where a recipe may be dispatched: `tapis` (an allocation, a hold) or `runner` (a
 * registered runner pulls it, no hold). A dispatch to an executor a recipe does not list is refused. ONE
 * recipe, ONE registry entry, both inputs: `nemar-floor` is `bids` on Tapis and `zarr` on a runner, and
 * {@link RECIPE_INPUT_EXECUTOR} says which input runs where. A dispatch names its input or takes the
 * executor's ({@link defaultInput}); an input the recipe does not list, or one the executor does not run, is
 * refused before anything is claimed ({@link recipeRunsInput}). The input is part of the stamp's claimed
 * tuple, so a `bids` and a `zarr` run of one dataset version coexist.
 */

/** The states of a stamp, declared once; the migration's CHECK is held to this list by a test. */
export const PIPELINE_STAMP_STATES = ["dispatched", "succeeded", "failed", "refused"] as const;

export type PipelineStampState = (typeof PIPELINE_STAMP_STATES)[number];

/** The states in which a stamp holds its tuple: nothing else may claim it. */
export const PIPELINE_LIVE_STAMP_STATES = ["dispatched", "succeeded"] as const;

/**
 * Where a dataset is bound inside the container, and where a recipe writes its product. Absolute: the
 * command is an argument vector and a variable would not be expanded. The product directory is under
 * the launcher's outputs directory (`work/outputs` on the node, `/work/outputs` in the container).
 */
export const RECIPE_DATASET_ROOT = "/data";
export const RECIPE_PRODUCT_DIR = "/work/outputs/product";

/** The product directory as the result's output paths name it: relative to the outputs directory. */
export const RECIPE_PRODUCT_OUTPUT_PREFIX = "product/";

/** The one flag that carries the image digest, and the shape of its value. */
export const RECIPE_IMAGE_DIGEST_FLAG = "--image-digest";

const IMAGE_DIGEST_VALUE_RE = /^sha256:[0-9a-f]{64}$/;

/** What a recipe's dispatch is eligible on: today only electroencephalography (EEG) datasets. */
export type RecipeEligibility = "eeg";

/**
 * What a recipe reads: `bids`, the dataset's own files bound read-only at `/data/<id>` (the launcher
 * stages them), or `zarr`, the dataset's Zarr serving copy streamed over HTTPS from `--zarr-base`, with
 * no dataset staged (portable compute, plan D12). The words of the stamp's `input` column (migration 0141),
 * which a test holds to this list.
 */
export const RECIPE_INPUTS = ["bids", "zarr"] as const;

export type RecipeInput = (typeof RECIPE_INPUTS)[number];

/**
 * Who may run a recipe: Tapis on an allocation, or a runner that polls NEMAR (ADR 0121). These are the
 * words of `COMPUTE_EXECUTORS` in `./compute-state.ts`, repeated here because this module imports
 * nothing; a test holds the two lists together.
 */
export type RecipeExecutor = "tapis" | "runner";

/**
 * Which executors run which input, the one table of the pairing: `bids` runs on Tapis (the launcher stages
 * the dataset) and `zarr` on a runner (nothing is staged and the recipe reads over HTTPS). Exactly these
 * pairs; no other combination is run, whatever a recipe lists.
 */
export const RECIPE_INPUT_EXECUTOR: Readonly<Record<RecipeInput, readonly RecipeExecutor[]>> =
  Object.freeze({
    bids: Object.freeze(["tapis"] as const),
    zarr: Object.freeze(["runner"] as const),
  });

/** The input an executor runs when a dispatch names none: `bids` for Tapis, `zarr` for a runner. */
export function defaultInput(executor: RecipeExecutor): RecipeInput {
  return RECIPE_INPUTS.find((i) => RECIPE_INPUT_EXECUTOR[i].includes(executor)) ?? "bids";
}

/**
 * Whether the recipe reads this input and the executor runs it: the one decision a dispatch, a dry run
 * and the route take before anything is claimed or written. False for an input the recipe does not list
 * and for a pair {@link RECIPE_INPUT_EXECUTOR} does not name (`bids` on a runner, `zarr` on Tapis).
 */
export function recipeRunsInput(
  recipe: Pick<ComputeRecipe, "inputs">,
  input: RecipeInput,
  executor: RecipeExecutor,
): boolean {
  return recipe.inputs.includes(input) && RECIPE_INPUT_EXECUTOR[input].includes(executor);
}

export interface ComputeRecipe {
  /** The recipe's name, as `nemar-recipe run <name>` takes it. */
  name: string;
  /** The version the Worker expects the recipe to report in its own record. */
  version: string;
  /** The Tapis application that runs a recipe job, and its version. */
  appId: string;
  appVersion: string;
  /** The engine the Worker expects the record to name, as `<package>@<version>`. */
  engine: string;
  partition: string;
  nodes: number;
  cores: number;
  memoryMb?: number;
  gpus: number;
  minutes: number;
  /**
   * What the recipe reads, one or more of {@link RECIPE_INPUTS}; a `zarr` run is dispatched with no dataset
   * staged and a source commit. The stamp's tuple names the one input a run read.
   */
  inputs: readonly RecipeInput[];
  /** The executors the recipe may be dispatched to; a dispatch to another is refused. */
  executors: readonly RecipeExecutor[];
  /** The daily dispatcher dispatches a recipe only while this is true. */
  autoDispatch: boolean;
  /**
   * The entry stands for a recipe that does not exist yet, or whose numbers nobody has verified. No
   * path dispatches a placeholder (`recipe_placeholder`): the entry is here so the registry's shape is
   * held, and the flag is removed in the change that makes the recipe real.
   */
  placeholder?: boolean;
  eligibility: RecipeEligibility;
}

/**
 * The recipes. `nemar-floor` annotates every EEG recording of a dataset and runs on a CPU partition: on
 * Tapis over the dataset's files (`bids`) and on a runner over its Zarr serving copy (`zarr`), one entry for
 * both (plan D12). On a runner the partition is a SIZING LABEL only (ADR 0121, decision 6): `shared`'s
 * ceilings apply, nothing is submitted to it and no service unit is estimated. `nemar-ica` needs a GPU and
 * stays out of the daily dispatcher until the 20-dataset pilot has run.
 */
export const COMPUTE_RECIPES: readonly ComputeRecipe[] = Object.freeze([
  Object.freeze({
    name: "nemar-floor",
    version: "1.0.0",
    appId: "nemar-launch",
    appVersion: "1.0.0",
    engine: "eegprep@0.5.0",
    partition: "shared",
    nodes: 1,
    cores: 4,
    memoryMb: 16384,
    gpus: 0,
    minutes: 360,
    inputs: Object.freeze(["bids", "zarr"] as const),
    executors: Object.freeze(["tapis", "runner"] as const),
    autoDispatch: true,
    eligibility: "eeg",
  }),
  Object.freeze({
    name: "nemar-ica",
    version: "1.0.0",
    appId: "nemar-launch",
    appVersion: "1.0.0",
    engine: "eegprep@0.5.0",
    partition: "gpu-shared",
    nodes: 1,
    cores: 10,
    gpus: 1,
    minutes: 720,
    inputs: Object.freeze(["bids"] as const),
    executors: Object.freeze(["tapis"] as const),
    autoDispatch: false,
    placeholder: true,
    eligibility: "eeg",
  }),
]) as readonly ComputeRecipe[];

/** The recipe of a name, or null. Exact: no case fold, no trim. */
export function findRecipe(name: unknown): ComputeRecipe | null {
  if (typeof name !== "string") return null;
  return COMPUTE_RECIPES.find((r) => r.name === name) ?? null;
}

/** The label a recipe puts in its product file names: its name without hyphens (`nemarfloor`). */
export function recipeLabel(recipe: Pick<ComputeRecipe, "name">): string {
  return recipe.name.replaceAll("-", "");
}

/**
 * The files a finished run of the recipe must have written, relative to the job's outputs directory:
 * the dataset record, which is the recipe's own record, and the complete recordings table. The table
 * holds the recordings that failed or were skipped, which the dataset record lists only up to a cap.
 */
export function recipeRequiredOutputs(recipe: Pick<ComputeRecipe, "name">): {
  record: string;
  table: string;
} {
  const label = recipeLabel(recipe);
  return {
    record: `${RECIPE_PRODUCT_OUTPUT_PREFIX}desc-${label}_signalJourney.json`,
    table: `${RECIPE_PRODUCT_OUTPUT_PREFIX}desc-${label}_recordings.tsv`,
  };
}

/**
 * The command a recipe job runs; the arguments follow it. A BIDS run, the recipe's default input, is
 * `nemar-recipe run <name>`, byte for byte what it was before a recipe had two inputs; any other input adds
 * `--input <input>` after the name (`nemar-recipe run nemar-floor --input zarr`). The input is in the command
 * and not in the arguments on purpose: see the header.
 */
export function recipeCommand(
  recipe: Pick<ComputeRecipe, "name">,
  input: RecipeInput = "bids",
): string[] {
  return [
    "nemar-recipe",
    "run",
    recipe.name,
    ...(input === "bids" ? [] : [RECIPE_INPUT_FLAG, input]),
  ];
}

/**
 * The arguments of a recipe job over the whole of one dataset version: where the dataset is, where the
 * product goes, the identity the recipe must not guess, and the image digest. A whole-dataset run
 * names no `--recording`, so it selects every recording the recipe discovers.
 */
export function recipeArguments(input: {
  datasetId: string;
  /** The data-plane tag of the version (`v1.0.2` or `latest`). */
  tag: string;
  /** The image digest, `sha256:<64 hex>`. */
  imageDigest: string;
}): string[] {
  return [
    "--dataset-dir",
    `${RECIPE_DATASET_ROOT}/${input.datasetId}`,
    "--out",
    RECIPE_PRODUCT_DIR,
    "--dataset-id",
    input.datasetId,
    "--dataset-version",
    input.tag,
    RECIPE_IMAGE_DIGEST_FLAG,
    input.imageDigest,
  ];
}

/** The flag of the command that names the input a recipe reads (`bids`, the default, passes none). */
export const RECIPE_INPUT_FLAG = "--input";

/** The origin a Zarr-input recipe reads, and the one network origin it may open (plan D12). */
export const RECIPE_ZARR_BASE = "https://zarr.nemar.org";

/**
 * A bare, lower-case host name: letters, digits, dots and hyphens, starting and ending with a letter or a
 * digit. No scheme, port, path, query, user, space or upper-case letter, so `https://` plus a value that
 * matches is an origin and nothing else.
 */
export const RECIPE_ZARR_HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * The origin a Zarr-input recipe job is told to read (portable compute, plan S1 and D12). Production, and any
 * configured host that is not a bare lower-case host name (or none at all), is {@link RECIPE_ZARR_BASE};
 * outside production it is the environment's OWN serving host, `https://` plus the Worker's `ZARR_HOSTNAME`,
 * so a staging fixture is read from the staging copy. The host comes from the Worker's configuration only,
 * never from a request, a dataset row or an index. `nonProduction` is the Worker's own decision
 * (`isNonProductionEnv`: only `development`, `staging` and `test`; anything else, unset included, is
 * production): this file is import-free, so the decision is handed in, never re-derived here.
 */
export function recipeZarrBase(input: {
  nonProduction: boolean;
  zarrHostname?: string | null;
}): string {
  const host = input.zarrHostname;
  if (!input.nonProduction || typeof host !== "string" || !RECIPE_ZARR_HOSTNAME_RE.test(host)) {
    return RECIPE_ZARR_BASE;
  }
  return `https://${host}`;
}

/** Is this an origin {@link recipeZarrBase} can give: the production origin, or `https://` and a bare host name. */
export const isRecipeZarrBase = (value: unknown): value is string =>
  value === RECIPE_ZARR_BASE ||
  (typeof value === "string" &&
    value.startsWith("https://") &&
    RECIPE_ZARR_HOSTNAME_RE.test(value.slice("https://".length)));

/** The flag that carries the commit of the dataset repository the Zarr serving copy was built from. */
export const RECIPE_SOURCE_COMMIT_FLAG = "--source-commit";
/** The flag that carries the commit of the version's tag. */
export const RECIPE_TAG_COMMIT_FLAG = "--tag-commit";
/** The flag that carries how the two commits are equivalent: `exact` or `metadata_only`. */
export const RECIPE_COMMIT_EQUIVALENCE_FLAG = "--commit-equivalence";
/** The repeatable flag that carries one path changed between the tag commit and the source commit. */
export const RECIPE_COMMIT_DELTA_PATH_FLAG = "--commit-delta-path";

const SOURCE_COMMIT_RE = /^[0-9a-f]{40}$/;

/** Is this a full commit id: 40 lowercase hex digits. */
export const isSourceCommit = (value: unknown): value is string =>
  typeof value === "string" && SOURCE_COMMIT_RE.test(value);

/**
 * What the Worker attests of the commit a Zarr serving copy was built from (`checkZarrSource` decides it):
 * `exact` (the source commit is the tag commit, no path) or `metadata_only` (they differ, and every path
 * between them is named and lies under `.nemar/` or `.github/`). The recipe validates the same agreement and
 * exits 2 on a contradiction, so a vector that disagrees with itself is a programming error here.
 */
export interface ZarrCommitAttestation {
  /** The commit the serving index was built from: 40 lowercase hex digits. */
  sourceCommit: string;
  /** The commit of the version's tag: 40 lowercase hex digits. */
  tagCommit: string;
  equivalence: "exact" | "metadata_only";
  /** The changed paths in the compare's order; empty for `exact`, at least one for `metadata_only`. */
  deltaPaths: readonly string[];
}

/**
 * The arguments of a Zarr-input recipe job over one dataset version: no dataset directory (nothing is
 * staged), the product directory, the identity the recipe must not guess, the commit attestation (the source
 * commit, the tag commit, the equivalence and one `--commit-delta-path` per changed path), the image digest,
 * and the one origin the recipe may read (`zarrBase`, from {@link recipeZarrBase}: the environment's own host,
 * never a constant here). The order is part of the contract (the job's `spec.json` records
 * it). A commit that is not 40 lowercase hex digits, an attestation that contradicts itself, or an origin
 * that is not one `recipeZarrBase` can give is a programming error, never passed on.
 */
export function recipeZarrArguments(input: {
  datasetId: string;
  /** The data-plane tag of the version (`v1.0.2` or `latest`). */
  tag: string;
  attestation: ZarrCommitAttestation;
  /** The image digest, `sha256:<64 hex>`. */
  imageDigest: string;
  /** The origin the recipe reads: {@link recipeZarrBase}'s answer. */
  zarrBase: string;
}): string[] {
  const { sourceCommit, tagCommit, equivalence, deltaPaths } = input.attestation;
  if (!isRecipeZarrBase(input.zarrBase)) {
    throw new RangeError("the Zarr base is the production origin or https:// and a bare host name");
  }
  if (!isSourceCommit(sourceCommit) || !isSourceCommit(tagCommit)) {
    throw new RangeError("a source commit and a tag commit are 40 lowercase hex digits");
  }
  if (equivalence === "exact" && (tagCommit !== sourceCommit || deltaPaths.length > 0)) {
    throw new RangeError("an exact attestation has one commit and no delta path");
  }
  if (equivalence === "metadata_only" && (tagCommit === sourceCommit || deltaPaths.length === 0)) {
    throw new RangeError("a metadata_only attestation has two commits and names the changed paths");
  }
  if (equivalence !== "exact" && equivalence !== "metadata_only") {
    throw new RangeError("the commit equivalence is exact or metadata_only");
  }
  return [
    "--out",
    RECIPE_PRODUCT_DIR,
    "--dataset-id",
    input.datasetId,
    "--dataset-version",
    input.tag,
    RECIPE_SOURCE_COMMIT_FLAG,
    sourceCommit,
    RECIPE_TAG_COMMIT_FLAG,
    tagCommit,
    RECIPE_COMMIT_EQUIVALENCE_FLAG,
    equivalence,
    ...deltaPaths.flatMap((path) => [RECIPE_COMMIT_DELTA_PATH_FLAG, path]),
    RECIPE_IMAGE_DIGEST_FLAG,
    input.imageDigest,
    "--zarr-base",
    input.zarrBase,
  ];
}

/**
 * The image digest a recipe job's arguments pass, or null when there is not exactly one well-formed
 * value for the flag (none, two, or a value that is not `sha256:` and 64 lowercase hex digits). Exactly
 * one: a second flag would let the recipe and the Worker read different values.
 */
export function recipeImageDigestArg(args: readonly string[]): string | null {
  let found: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== RECIPE_IMAGE_DIGEST_FLAG) continue;
    const value = args[i + 1];
    if (found !== null || value === undefined || !IMAGE_DIGEST_VALUE_RE.test(value)) return null;
    found = value;
    i++;
  }
  return found;
}

// --- The recipe's own record ------------------------------------------------------------------------

/** The most characters of `<package>@<version>`: the stamp's engine column. */
const RECORD_ENGINE_MAX = 64;

const RECORD_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** What the Worker takes from the recipe's dataset record, and nothing more. */
export interface RecipeRecord {
  recipe: string;
  /** The recipe's version as it reports it. */
  version: string;
  /** `<package>@<version>` of the engine as it reports it. */
  engine: string;
  /** The recordings that succeeded. */
  succeeded: number;
  /**
   * What the record says it read: `extensions.nemar.input.kind`, or `bids` when the record states none (a BIDS
   * record has no input block). A plain word; compared with the stamp's `input` (a difference is a tuple mismatch).
   */
  inputKind: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The identity a recipe's dataset record states, or null when the record does not state it in the shape
 * the recipe writes (`extensions.nemar.recipe`, `.engine` and `.counts`, and, when present, a plain word for
 * `extensions.nemar.input.kind`). Nothing else is read, and every word must be a short plain word, so a
 * record can put nothing else into a stamp. The record is written by the job, so this is the recipe's
 * statement of what it is and never an accounting figure. What the record says it read (the reader, the Zarr
 * engine, the input digest) is read by {@link stampInputFields}, which checks each value against its column.
 */
export function readRecipeRecord(value: unknown): RecipeRecord | null {
  const nemar = object(object(object(value)?.extensions)?.nemar);
  const recipe = object(nemar?.recipe);
  const engine = object(nemar?.engine);
  const counts = object(nemar?.counts);
  if (recipe === null || engine === null || counts === null) return null;
  // The input block is absent from a BIDS record. A block that is there is an object, and the kind it names
  // (absent means bids) is a plain word; anything else is not the shape the recipe writes.
  let inputKind = "bids";
  if (nemar?.input !== undefined) {
    const block = object(nemar.input);
    if (block === null) return null;
    const kind = block.kind;
    if (kind !== undefined) {
      if (typeof kind !== "string" || !RECORD_WORD_RE.test(kind)) return null;
      inputKind = kind;
    }
  }
  const { id, version } = recipe;
  const pkg = engine.package;
  const engineVersion = engine.version;
  const succeeded = counts.succeeded;
  if (
    typeof id !== "string" ||
    typeof version !== "string" ||
    typeof pkg !== "string" ||
    typeof engineVersion !== "string" ||
    !RECORD_WORD_RE.test(id) ||
    !RECORD_WORD_RE.test(version) ||
    !RECORD_WORD_RE.test(pkg) ||
    !RECORD_WORD_RE.test(engineVersion) ||
    typeof succeeded !== "number" ||
    !Number.isSafeInteger(succeeded) ||
    succeeded < 0
  ) {
    return null;
  }
  // The stamp's engine column holds 64 characters (migration 0117): a longer value could never be
  // written, so the record is not read rather than left to throw at the update.
  const engineText = `${pkg}@${engineVersion}`;
  if (engineText.length > RECORD_ENGINE_MAX) return null;
  return { recipe: id, version, engine: engineText, succeeded, inputKind };
}

// --- What a run read, for the stamp ----------------------------------------------------------------------

/**
 * The stamp columns a finished run's record fills besides the tuple (migration 0141), by the name its log
 * line and its refusals use.
 */
export const STAMP_INPUT_FIELDS = ["reader", "input_engine", "input_digest"] as const;

export type StampInputField = (typeof STAMP_INPUT_FIELDS)[number];

/**
 * A reader or a Zarr engine as the stamp stores it: 1 to 128 plain characters (letters, digits and
 * `. _ + @ -`), the rule of the columns `reader` and `input_engine`. `eegprep-lean@<version>+<commit>` fits.
 */
export const STAMP_WORD_RE = /^[0-9A-Za-z._+@-]{1,128}$/;

/** The input digest of a Zarr run: `sha256:` and 64 lowercase hexadecimal digits (card V1's digest). */
export const STAMP_ZARR_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The input digest of a BIDS run: `git:` and the 40 lowercase hexadecimal digits of the source commit. */
export const STAMP_GIT_DIGEST_RE = /^git:[0-9a-f]{40}$/;

/**
 * Why a value the record states was not stored, a fixed word for the log: `bad_shape` (it is not in the shape of
 * its column), and, for a Zarr input digest that is well formed, the three ways the record does not show that
 * the digest covers everything the run was given: `stores_unread` (the record's `stores_unread` is not an empty
 * list), `no_stores_content` (`stores_content` is not a non-empty list of rows with a path) and `stores_differ`
 * (the paths of its rows are not exactly `input.stores`).
 */
export const STAMP_REFUSAL_REASONS = [
  "bad_shape",
  "stores_unread",
  "no_stores_content",
  "stores_differ",
] as const;

export type StampRefusalReason = (typeof STAMP_REFUSAL_REASONS)[number];

/** What a record says it read, each value as the stamp may store it, or null. */
export interface StampInputFields {
  reader: string | null;
  input_engine: string | null;
  input_digest: string | null;
  /** The fields the record states but the stamp does not take: left null, never stored, and logged by name and reason. */
  refused: StampInputField[];
  /** The reason word of each refused field. */
  reasons: Partial<Record<StampInputField, StampRefusalReason>>;
  /** The fields a Zarr record does not state at all (an image from before they existed): null, and logged. */
  absent: StampInputField[];
}

/**
 * Whether a Zarr dataset record shows that its input digest covers every store the run was given, or the word
 * of what it does not show. The digest names only the stores whose content was read in full
 * (`stores_content`); it is the key of a derivative (plan D14), so it is stored only when nothing the run was
 * given is missing from it: `stores_unread` is an empty list (a run that left stores unread, or that does not
 * say, has a digest of less than its input), `stores_content` is a non-empty list, and the paths of its rows
 * are exactly the stores the run named (`input.stores`), each once.
 *
 * What this does NOT check is that the stated digest is the digest of those rows: that recomputation belongs
 * to the derivative store (card V1b), which holds the one shared definition of the input digest
 * (`nemar.store-content.v1`); this file does not carry a second copy of it.
 */
function zarrCoverageRefusal(block: Record<string, unknown> | null): StampRefusalReason | null {
  const unread = block?.stores_unread;
  if (!Array.isArray(unread) || unread.length !== 0) return "stores_unread";
  const rows = block?.stores_content;
  if (!Array.isArray(rows) || rows.length === 0) return "no_stores_content";
  const paths: string[] = [];
  for (const row of rows) {
    const path = object(row)?.path;
    if (typeof path !== "string") return "no_stores_content";
    paths.push(path);
  }
  const stores = block?.stores;
  if (!Array.isArray(stores) || stores.some((p) => typeof p !== "string")) return "stores_differ";
  const wanted = [...(stores as string[])].sort();
  const got = [...paths].sort();
  if (wanted.length !== got.length || wanted.some((p, i) => p !== got[i])) return "stores_differ";
  // Each store once: two rows of one path are not a covering of a list of stores.
  if (new Set(got).size !== got.length) return "stores_differ";
  return null;
}

/**
 * What a succeeded stamp records of what the run READ, from the recipe's dataset record (plan D12 and D14):
 *  - `zarr`: the reader (`extensions.nemar.reader`, `eegprep-lean@<version>+<commit>`), the Zarr engine
 *    (`extensions.nemar.input.zarr_engine_version`) and the input digest (`extensions.nemar.input.input_digest`,
 *    `sha256:` and 64 hexadecimal digits), the digest only when the record shows it covers every store of the
 *    run ({@link zarrCoverageRefusal});
 *  - `bids`: the input digest `git:` and `extensions.nemar.dataset.source_commit`, when that is a full commit
 *    (40 lowercase hexadecimal digits); no reader and no Zarr engine. A Worker-dispatched BIDS run is not given
 *    a source commit, so its record carries none and its digest is null: an expected null, not logged as absent.
 * A value that does not fit is left null and named in `refused` with its reason; a Zarr value the record does
 * not state is null and named in `absent`. Nothing the record says is stored as it came: the record is the
 * job's own statement and the columns hold fixed shapes only.
 */
export function stampInputFields(value: unknown, input: RecipeInput): StampInputFields {
  const nemar = object(object(object(value)?.extensions)?.nemar);
  const out: StampInputFields = {
    reader: null,
    input_engine: null,
    input_digest: null,
    refused: [],
    reasons: {},
    absent: [],
  };
  const refuse = (field: StampInputField, reason: StampRefusalReason): void => {
    out.refused.push(field);
    out.reasons[field] = reason;
  };
  /** A value the input must state: absent is named, a value that does not fit is refused. */
  const take = (
    field: StampInputField,
    stated: unknown,
    fits: (text: string) => boolean,
    set: (text: string) => string = (text) => text,
  ): void => {
    if (stated === undefined || stated === null) {
      out.absent.push(field);
    } else if (typeof stated === "string" && fits(stated)) {
      out[field] = set(stated);
    } else {
      refuse(field, "bad_shape");
    }
  };
  if (input === "zarr") {
    const block = object(nemar?.input);
    take("reader", nemar?.reader, (t) => STAMP_WORD_RE.test(t));
    take("input_engine", block?.zarr_engine_version, (t) => STAMP_WORD_RE.test(t));
    take("input_digest", block?.input_digest, (t) => STAMP_ZARR_DIGEST_RE.test(t));
    if (out.input_digest !== null) {
      const reason = zarrCoverageRefusal(block);
      if (reason !== null) {
        out.input_digest = null;
        refuse("input_digest", reason);
      }
    }
  } else {
    // The digest of a BIDS input is the commit the files were read at; a record that names none is the usual case.
    const commit = object(nemar?.dataset)?.source_commit;
    if (commit !== undefined && commit !== null) {
      if (typeof commit === "string" && SOURCE_COMMIT_RE.test(commit)) {
        out.input_digest = `git:${commit}`;
      } else {
        refuse("input_digest", "bad_shape");
      }
    }
  }
  return out;
}

/**
 * Whether a recipe lists the executor: the one decision the route, the dispatch and the dry run take of where a
 * recipe may be dispatched, before the input is looked at ({@link recipeRunsInput}).
 */
export function recipeRunsOn(
  recipe: Pick<ComputeRecipe, "executors">,
  executor: RecipeExecutor,
): boolean {
  return recipe.executors.includes(executor);
}
