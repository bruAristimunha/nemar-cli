/**
 * #1493: the root declares `-v, --version`, and Commander recognizes that
 * boolean anywhere on the command line, so `nemar dataset release <id>
 * --version X.Y.Z` prints the CLI version and exits 0 unless the pre-pass in
 * src/lib/argv-shadowing.ts hands the value to `release`. A scripted release
 * (`-y`) would silently do nothing.
 *
 * The unit tests run bindShadowedOptionValues over the REAL command tree: the
 * command groups src/index.ts registers, under a root with the same flags as
 * the one in src/index.ts. A hand-kept copy of the tree would keep passing
 * after a flag was added or renamed in src/commands, which is the drift this
 * guard exists to catch. The entry-point tests drive the real CLI (`bun run
 * src/index.ts`) against a local stand-in backend; with no account key
 * configured, reaching the release handler shows up as its "Not authenticated"
 * refusal, while a swallowed flag prints the version.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { Command, type Option } from "commander";
import { adminCommand } from "../src/commands/admin";
import { authCommand } from "../src/commands/auth";
import { completionCommand } from "../src/commands/completion";
import {
  createDownloadCommand,
  createUploadCommand,
  datasetCommand,
} from "../src/commands/dataset";
import { doctorCommand } from "../src/commands/doctor";
import { sandboxCommand } from "../src/commands/sandbox";
import {
  MisplacedShadowedOptionError,
  MissingShadowedValueError,
  bindShadowedOptionValues,
} from "../src/lib/argv-shadowing";
import { version } from "../src/lib/version";

// ---------------------------------------------------------------------------
// The real command tree
// ---------------------------------------------------------------------------

// The module-level command groups src/index.ts passes to addCommand().
// addCommand() sets the child's `.parent`, and these objects are shared with
// every other test file in the same `bun test` process, so each one's parent
// is put back in afterAll.
const SHARED_GROUPS = [
  adminCommand,
  authCommand,
  completionCommand,
  datasetCommand,
  doctorCommand,
  sandboxCommand,
];

// Declared inline in src/index.ts rather than exported, so the tree below
// cannot see them, and neither can the collision walk: when this was written
// none takes a flag an ancestor also declares, and nothing re-checks that.
// The drift test (it spawns the CLI, so it sits with the entry-point tests)
// compares top-level names only, so it fails when index.ts gains or loses a
// command, which is the cue to look. Extracting the program assembly from
// index.ts would let the tree cover them.
const INLINE_ROOT_COMMANDS = ["login", "logout", "register", "signup", "switch", "whoami"];

/** The root with the flags src/index.ts declares (descriptions shortened). */
function declareRoot(): Command {
  return new Command("nemar")
    .version(version, "-v, --version", "Output the current version")
    .option("--no-color", "Disable colored output")
    .option("--verbose", "Enable verbose output")
    .option("--help-all", "Show detailed help with examples and descriptions")
    .option("--debug", "Write a diagnostic log for this run");
}

/** What Commander had parsed for the command that was about to run. */
interface Reached {
  name: string;
  opts: Record<string, unknown>;
  optsWithGlobals: Record<string, unknown>;
  processedArgs: unknown[];
}

/** Thrown to stop a parse before the action runs, carrying what it had parsed. */
class StoppedBeforeAction extends Error {
  constructor(readonly reached: Reached) {
    super("stopped before the action");
  }
}

let program: Command;
const originalParents = SHARED_GROUPS.map((c) => c.parent);

beforeAll(() => {
  program = declareRoot();
  // The root's own --version handler would otherwise process.exit(0) the test
  // runner if the pre-pass ever failed to protect a subcommand's flag.
  program.exitOverride();
  for (const group of SHARED_GROUPS) program.addCommand(group);
  // Fresh instances, as in src/index.ts: Commander gives a Command one parent.
  program.addCommand(createDownloadCommand());
  program.addCommand(createUploadCommand());
  // Stop at the command that would run, before its action touches the network
  // or the account. What Commander parsed for that command is the evidence.
  program.hook("preAction", (_root, actionCommand) => {
    throw new StoppedBeforeAction({
      name: actionCommand.name(),
      opts: { ...actionCommand.opts() },
      optsWithGlobals: { ...actionCommand.optsWithGlobals() },
      processedArgs: [...actionCommand.processedArgs],
    });
  });
});

afterAll(() => {
  SHARED_GROUPS.forEach((group, i) => {
    group.parent = originalParents[i];
  });
});

/** The parse called process.exit(), which would have ended the whole `bun test` run. */
class ProcessExitCalled extends Error {}

/**
 * Commander 12 never clears the option values a parse stored, and the command
 * groups are shared with every other test file in this process. After a parse
 * (including one that died on a usage error before reaching any command), drop
 * what it set, keeping declared defaults, so no case sees, or leaves behind,
 * another case's flags.
 */
function forgetParsedOptions(command: Command): void {
  const state = command as unknown as {
    _optionValues?: Record<string, unknown>;
    _optionValueSources?: Record<string, unknown>;
  };
  for (const [key, source] of Object.entries(state._optionValueSources ?? {})) {
    if (source === "default") continue;
    delete state._optionValues?.[key];
    delete state._optionValueSources?.[key];
  }
  for (const sub of command.commands) forgetParsedOptions(sub);
}

/**
 * Parse `argv` the way src/index.ts does and return what Commander had parsed
 * for the command it reached. Only the throwaway root has exitOverride(); a
 * usage error raised by a shared command (a missing <dataset-id>, say) calls
 * process.exit(1), which would abort every test file in the run, so
 * process.exit and stderr are trapped for the length of the parse and the exit
 * surfaces as a failure.
 */
async function reach(argv: string[]): Promise<Reached> {
  const realExit = process.exit;
  const realWrite = process.stderr.write;
  let stderr = "";
  process.exit = ((code?: number) => {
    throw new ProcessExitCalled(`process.exit(${code}) during parse: ${stderr.trim()}`);
  }) as typeof process.exit;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let outcome: unknown;
  try {
    await program.parseAsync(bindShadowedOptionValues(program, argv), { from: "user" });
  } catch (err) {
    outcome = err;
  } finally {
    process.exit = realExit;
    process.stderr.write = realWrite;
    forgetParsedOptions(program);
  }
  if (outcome instanceof StoppedBeforeAction) return outcome.reached;
  throw outcome ?? new Error("the parse finished without reaching a command");
}

/** The pre-pass over the real tree, unless another tree is named. */
const bind = (argv: string[], tree: Command = program) => bindShadowedOptionValues(tree, argv);

/** Every case comes back from the pre-pass exactly as it went in. */
function unchanged(cases: string[][], tree: Command = program): void {
  for (const argv of cases) expect(bind(argv, tree)).toEqual(argv);
}

/** The error the pre-pass throws for `argv`; fails if it returns instead. */
function thrown(argv: string[], tree: Command = program): unknown {
  try {
    bind(argv, tree);
  } catch (err) {
    return err;
  }
  throw new Error(`the pre-pass returned for ${JSON.stringify(argv)} instead of throwing`);
}

describe("bindShadowedOptionValues on the real command tree", () => {
  // The flag belongs to `release`, but typed before that name it lands on
  // `dataset`, which does not declare it, so the root claims it and prints the
  // CLI version (the equals spelling is rejected by `dataset` as an unknown
  // option, so it cannot be rewritten into place either). Fail instead.
  test("a shadowed flag typed before its command is an error", () => {
    for (const argv of [
      ["dataset", "--version", "2.0.0", "release", "nm1", "-y"],
      ["dataset", "--version", "release", "nm1", "-y"],
      ["--debug", "dataset", "--verbose", "--version", "2.0.0", "release", "nm1"],
    ]) {
      const err = thrown(argv) as MisplacedShadowedOptionError;
      expect(err).toBeInstanceOf(MisplacedShadowedOptionError);
      expect(err.message).toBe("error: option '--version <version>' must come after 'release'");
      expect(err.command.name()).toBe("release");
    }
  });

  // Shapes that must keep meaning what they meant before the pre-pass existed.
  test("root-level and out-of-position flags keep their meaning", () => {
    unchanged([
      // The root's own --version, ahead of any command.
      ["--version", "dataset", "release", "nm1"],
      ["--version", "2.0.0", "dataset", "release", "nm1", "-y"],
      // Typed before a command that does not take a value for it: `dataset`
      // and `list` just see the root's flag.
      ["dataset", "--version", "list"],
      ["dataset", "--version", "2.0.0", "list"],
      // `--` ends option parsing for everything after it, including the
      // command names.
      ["dataset", "--", "release", "nm1", "--version"],
      ["dataset", "--", "release", "nm1", "--version", "2.0.0"],
      // The equals spelling typed early is `dataset`'s unknown option to
      // report, not ours.
      ["dataset", "--version=2.0.0", "release", "nm1", "-y"],
    ]);
    // After the command's own name it is that command's, whatever else follows.
    expect(bind(["dataset", "release", "--version", "6.0.0", "nm1"])).toEqual([
      "dataset",
      "release",
      "--version=6.0.0",
      "nm1",
    ]);
  });

  // A value that starts with "-" has to be spelled --flag=value: the next
  // token is read as a flag, so `--version -1.0.0` is a missing value. A lone
  // "-" is the exception, because Commander reads it as a value too.
  test("a lone dash is a value; any other dash-leading token is not", () => {
    expect(bind(["dataset", "release", "nm1", "--version", "-"])).toEqual([
      "dataset",
      "release",
      "nm1",
      "--version=-",
    ]);
    expect(bind(["dataset", "release", "nm1", "--version", "-", "-y"])).toEqual([
      "dataset",
      "release",
      "nm1",
      "--version=-",
      "-y",
    ]);
    expect(thrown(["dataset", "release", "nm1", "--version", "-1.0.0"])).toBeInstanceOf(
      MissingShadowedValueError,
    );
    unchanged([["dataset", "release", "nm1", "--version=-1.0.0"]]);
  });

  test("joins a shadowed value option of the addressed subcommand", () => {
    expect(bind(["dataset", "release", "nm099999", "--version", "2.0.0", "-y"])).toEqual([
      "dataset",
      "release",
      "nm099999",
      "--version=2.0.0",
      "-y",
    ]);
  });

  test("works with global flags before and after the subcommand", () => {
    expect(bind(["--debug", "dataset", "release", "--version", "1.2.3", "nm1"])).toEqual([
      "--debug",
      "dataset",
      "release",
      "--version=1.2.3",
      "nm1",
    ]);
    expect(bind(["dataset", "release", "nm1", "--version", "1.2.3", "--verbose"])).toEqual([
      "dataset",
      "release",
      "nm1",
      "--version=1.2.3",
      "--verbose",
    ]);
  });

  test("leaves everything else alone", () => {
    unchanged([
      // The root's own flag, with no command ahead of it.
      ["--version"],
      ["-v"],
      // `dataset` is a command but declares no --version, so it is still the
      // root's flag.
      ["dataset", "--version"],
      // Already the equals form.
      ["dataset", "release", "nm1", "--version=2.0.0"],
      // After `--` nothing is an option, valueless or not.
      ["dataset", "release", "nm1", "--", "--version", "2.0.0"],
      ["dataset", "release", "nm1", "--", "--version"],
      // `--jobs` is the leaf's own option and `--verbose` is a root boolean
      // typed after the command, which works anywhere.
      ["dataset", "upload", "./x", "--jobs", "4", "--verbose"],
      // `validate -v, --verbose` collides with the root's `-v` (#1220): short
      // flags are not handled.
      ["dataset", "validate", "./x", "-v"],
      // A different flag that merely starts like --version.
      ["dataset", "validate", "./x", "--version-info"],
      // Not a command of this program.
      ["unknown", "--version", "1"],
    ]);
  });

  // Left alone, a bare shadowed --version is claimed by the root, which
  // prints the CLI version and exits 0: the same silent no-op as the spaced
  // form for a scripted -y release. So it fails like any option missing its
  // argument.
  test("a shadowed value option with no value is an error", () => {
    for (const argv of [
      ["dataset", "release", "nm1", "--version"],
      ["dataset", "release", "nm1", "--version", "-y"],
      ["dataset", "release", "nm1", "--version", "--yes"],
      ["dataset", "release", "--version", "-y", "nm1"],
      ["--debug", "dataset", "release", "nm1", "--version"],
      // An empty value is a missing one: the release handler would otherwise
      // read it as "no --version" and bump by --type, or prompt.
      ["dataset", "release", "nm1", "--version", "", "--type", "patch", "-y"],
      ["dataset", "release", "nm1", "--version", ""],
    ]) {
      const err = thrown(argv) as MissingShadowedValueError;
      expect(err).toBeInstanceOf(MissingShadowedValueError);
      expect(err.message).toBe("error: option '--version <version>' argument missing");
      expect(err.command.name()).toBe("release");
    }
  });

  // Asking for help is a request to read, not to run, so it wins over a
  // missing value. The bare flag is dropped: left in, the root would claim it
  // and print the CLI version instead of the help.
  test("help wins over a missing value, but only before `--`", () => {
    expect(bind(["dataset", "release", "--help", "--version"])).toEqual([
      "dataset",
      "release",
      "--help",
    ]);
    expect(bind(["dataset", "release", "nm1", "--version", "--help"])).toEqual([
      "dataset",
      "release",
      "nm1",
      "--help",
    ]);
    expect(bind(["dataset", "release", "nm1", "--version", "-h"])).toEqual([
      "dataset",
      "release",
      "nm1",
      "-h",
    ]);
    // A value that is present is still joined.
    expect(bind(["dataset", "release", "--help", "--version", "5.0.0"])).toEqual([
      "dataset",
      "release",
      "--help",
      "--version=5.0.0",
    ]);
    // `--help` after `--` is an operand, not a request for help.
    expect(thrown(["dataset", "release", "nm1", "--version", "--", "--help"])).toBeInstanceOf(
      MissingShadowedValueError,
    );
  });

  // A BOOLEAN option that collides with an ancestor's (#1220: `dataset
  // validate` declares `-v, --verbose`, the root declares `--verbose`) takes no
  // value, so the token after it is a positional. Joining them would make the
  // path argument `--verbose=./x`: `validate` allows unknown options, so
  // Commander passes that through as the path and validate checks a bogus one.
  test("a boolean collision followed by a positional is untouched", async () => {
    unchanged([
      ["dataset", "validate", "--verbose", "./x"],
      ["dataset", "search", "--verbose", "covid"],
      ["--verbose", "dataset", "validate", "./x"],
    ]);
    const validate = await reach(["dataset", "validate", "--verbose", "./x"]);
    expect(validate.name).toBe("validate");
    expect(validate.processedArgs).toEqual(["./x"]);
  });

  // Each parse below uses values no other case uses, and reach() clears what a
  // parse stored: Commander 12 never resets option values, and the shared
  // `release` command would otherwise carry them into later cases and files.
  test("Commander then hands the value to the subcommand", async () => {
    const release = await reach(["dataset", "release", "nm1", "--version", "3.1.4", "-y"]);
    expect(release.name).toBe("release");
    expect(release.opts.version).toBe("3.1.4");
    expect(release.processedArgs).toEqual(["nm1"]);
  });

  test("reach() reports a usage error from a shared command instead of exiting", async () => {
    const exitBefore = process.exit;
    const writeBefore = process.stderr.write;
    // <dataset-id> is missing, so Commander calls process.exit(1) on `release`.
    await expect(reach(["dataset", "release", "--version", "4.0.4"])).rejects.toThrow(
      /process\.exit\(1\) during parse: error: missing required argument 'dataset-id'/,
    );
    expect(process.exit).toBe(exitBefore);
    expect(process.stderr.write).toBe(writeBefore);
    // ... and the failed parse left nothing behind on the shared command.
    const release = await reach(["dataset", "release", "nm1", "-y"]);
    expect(release.opts.version).toBeUndefined();
  });

  // `admin recover status` redeclares --recover-file from its parent group
  // `admin recover`, which takes the value itself. The parent's parseOptions
  // consumes the flag AND its value wherever they appear, and `status` reads
  // it back through optsWithGlobals() (src/commands/admin.ts), so there is
  // nothing for the pre-pass to rewrite, and no new way for it to fail.
  test("an ancestor option that takes the value itself is left alone", async () => {
    unchanged([
      ["admin", "recover", "status", "--recover-file", "recover-1.json"],
      ["admin", "recover", "status", "--recover-file", "recover-2.json", "--json"],
      ["admin", "recover", "status", "--recover-file", "--json"],
      ["admin", "recover", "status", "--recover-file"],
    ]);
    const plain = await reach(["admin", "recover", "status", "--recover-file", "recover-3.json"]);
    expect(plain.name).toBe("status");
    expect(plain.optsWithGlobals.recoverFile).toBe("recover-3.json");
    const withJson = await reach([
      "admin",
      "recover",
      "status",
      "--recover-file",
      "recover-4.json",
      "--json",
    ]);
    expect(withJson.optsWithGlobals.recoverFile).toBe("recover-4.json");
    expect(withJson.optsWithGlobals.json).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant over the whole tree
// ---------------------------------------------------------------------------

/** A value-taking option and the ancestor option that declares the same long flag. */
interface Collision {
  path: string[];
  option: Option;
  claimant: Option;
}

const takesValue = (option: Option) => !!(option.required || option.optional);

/**
 * Every command below the root with a value-taking option whose long flag an
 * ancestor also declares, with the outermost such ancestor option (the one
 * Commander parses the flag with). Every command, not only tree leaves: the
 * pre-pass addresses the deepest command NAMED on the line, and `admin
 * recover` is both a group and a command with its own options.
 */
function collisions(root: Command): Collision[] {
  const found: Collision[] = [];
  const visit = (cmd: Command, path: string[], ancestors: Command[]) => {
    const outermost = new Map<string, Option>();
    for (const a of ancestors) {
      for (const o of a.options) if (o.long && !outermost.has(o.long)) outermost.set(o.long, o);
    }
    for (const option of cmd.options) {
      const claimant = option.long ? outermost.get(option.long) : undefined;
      if (claimant && takesValue(option)) found.push({ path, option, claimant });
    }
    for (const sub of cmd.commands) visit(sub, [...path, sub.name()], [...ancestors, cmd]);
  };
  for (const sub of root.commands) visit(sub, [sub.name()], [root]);
  return found;
}

/** Every way to type `path`: each command by its name or by any of its aliases. */
function pathSpellings(root: Command, path: string[]): string[][] {
  let spellings: string[][] = [[]];
  let current = root;
  for (const name of path) {
    const next = current.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no command '${name}' under '${current.name()}'`);
    const names = [name, ...next.aliases()];
    spellings = spellings.flatMap((prefix) => names.map((n) => [...prefix, n]));
    current = next;
  }
  return spellings;
}

const describeCollision = (c: Collision) => `${c.path.join(" ")} ${c.option.long}`;

describe("every same-named value option in the real tree", () => {
  test("the walk finds both kinds of collision, so it cannot pass vacuously", () => {
    const names = collisions(program).map(describeCollision);
    // The root's boolean --version claims a flag `release` takes a value for.
    expect(names).toContain("dataset release --version");
    // `admin recover` takes --recover-file itself, and `status` redeclares it.
    expect(names).toContain("admin recover status --recover-file");
  });

  test("past a BOOLEAN ancestor option, --flag value is joined to --flag=value", () => {
    const boolean = collisions(program).filter((c) => !takesValue(c.claimant));
    expect(boolean.map(describeCollision)).toContain("dataset release --version");
    for (const { path, option } of boolean) {
      const flag = option.long as string;
      // Every spelling of the path: a command can be named by its alias.
      for (const spelled of pathSpellings(program, path)) {
        expect(bind([...spelled, flag, "some-value"])).toEqual([...spelled, `${flag}=some-value`]);
      }
    }
  });

  test("past a VALUE-taking ancestor option, --flag value is left unchanged", () => {
    const valued = collisions(program).filter((c) => takesValue(c.claimant));
    expect(valued.map(describeCollision)).toContain("admin recover status --recover-file");
    unchanged(valued.map(({ path, option }) => [...path, option.long as string, "some-value"]));
  });

  test("none that a boolean claims takes an OPTIONAL value, which cannot be delivered bare", () => {
    // `--flag [value]` with no value has no spelling the shadowing ancestor
    // does not claim, so it would still be swallowed. If this fails, decide
    // how that flag is meant to work before adding it: the pre-pass can only
    // join a value, or fail a required one that is missing.
    const optional = collisions(program)
      .filter((c) => !takesValue(c.claimant) && !c.option.required)
      .map((c) => `${c.path.join(" ")} ${c.option.flags}`);
    expect(optional).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A minimal real Commander tree for what the real tree has no instance of
// ---------------------------------------------------------------------------

// The real tree has no aliased command that declares a shadowed option, no
// shadowed option that takes an OPTIONAL value, and no value option whose
// short flag collides with an ancestor's. Those branches of the pre-pass are
// exercised here, on real Commander objects, so they do not go untested until
// someone adds the first real one.
function tinyProgram(): Command {
  const tiny = new Command("tiny")
    .option("--tag")
    .option("-q, --quiet")
    .option("--maybe")
    .option("--lvl");
  const grp = new Command("grp").alias("g").option("--lvl <n>");
  grp
    .command("go")
    .alias("run")
    .argument("[arg]")
    .option("--tag <name>")
    .option("-q, --quality <level>")
    .option("--maybe [value]")
    .option("--lvl <n>");
  tiny.addCommand(grp);
  return tiny;
}

describe("bindShadowedOptionValues on a minimal tree", () => {
  const tiny = tinyProgram();

  test("finds a command named by its alias, at every level", () => {
    for (const path of [
      ["grp", "go"],
      ["g", "go"],
      ["grp", "run"],
      ["g", "run"],
    ]) {
      expect(bind([...path, "--tag", "t1"], tiny)).toEqual([...path, "--tag=t1"]);
    }
  });

  test("a flag typed before an aliased command is still caught", () => {
    expect(thrown(["g", "--tag", "t1", "run"], tiny)).toBeInstanceOf(MisplacedShadowedOptionError);
  });

  test("only the long flag is shadowed: a short flag is never joined", () => {
    // `-q` is the root's boolean and the leaf's `-q, --quality <level>`.
    // Joining would make `-q=5`, and Commander reads that as the root's `-q`
    // combined with more short flags, so the root still claims it. A short
    // flag cannot be rescued by rewriting; none exists in the real tree.
    unchanged(
      [
        ["grp", "go", "-q", "5"],
        ["grp", "go", "-q"],
        ["grp", "go", "--quality", "5"],
      ],
      tiny,
    );
  });

  test("an optional value is joined when given, and cannot be delivered bare", () => {
    expect(bind(["grp", "go", "--maybe", "m1"], tiny)).toEqual(["grp", "go", "--maybe=m1"]);
    // Never an error (a bare optional flag is legal), and never rewritten
    // (nothing the root does not claim can spell it): the gap the real-tree
    // test above keeps empty.
    unchanged(
      [
        ["grp", "go", "--maybe"],
        ["grp", "go", "--maybe", "-y"],
      ],
      tiny,
    );
    // Help still wins: the bare flag would otherwise print the root's version.
    expect(bind(["grp", "go", "--maybe", "--help"], tiny)).toEqual(["grp", "go", "--help"]);
  });

  test("the OUTERMOST ancestor option of a flag decides, not the nearest", () => {
    // The root's boolean --lvl parses the flag first, though `grp` also takes
    // a value for it, so the leaf's value must be joined.
    expect(bind(["grp", "go", "--lvl", "3"], tiny)).toEqual(["grp", "go", "--lvl=3"]);
  });
});

// ---------------------------------------------------------------------------
// The real CLI process
// ---------------------------------------------------------------------------

// Nothing here may depend on the network or a live backend. The CLI is pointed
// at a local stand-in through config.json (the account's apiUrl). test.yml
// sorts a test file into the integration-dev tier (soft on dev, required at
// the dev-to-main gate) when its TEXT matches a grep for the live-backend
// environment variable, the request helper or the CLI-runner helper, and that
// grep matches comments too, so none of those three names may appear anywhere
// in this file. The file stays in the offline unit-pure tier.
const REPO_ROOT = join(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.ts");
const DATASET_ID = "nm099999";
// The stand-in backend names this repository for the dataset. It must not
// exist: if a release got past its version check (the bug these tests guard),
// the clone fails here instead of branching, pushing and opening a pull
// request on a real dataset repository.
const NO_SUCH_REPO = "nemarOrg/argv-shadowing-1493-no-such-repo";
const HAS_RELEASE_TOOLS = !!Bun.which("git") && !!Bun.which("gh");
const SPAWN_KILL_MS = 20_000;
const SPAWN_TEST_TIMEOUT_MS = 30_000;
// Variables kept out of the child. A proxy can send even a loopback request
// elsewhere (an unroutable one made a spawn take a second); color forcing
// would change the text the tests read.
const SCRUBBED_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "FORCE_COLOR",
  "CLICOLOR_FORCE",
];
let configDir: string;
let backendUrl: string;

async function spawnCli(args: string[]) {
  // Drop every TEST_* variable and the scrubbed set, in either case, so
  // nothing ambient can override the config.json URL or reroute the request.
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("TEST_") && !SCRUBBED_ENV.includes(key.toUpperCase()),
    ),
  );
  env.NEMAR_CONFIG_DIR = configDir;
  env.NEMAR_NO_UPDATE_CHECK = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.NO_COLOR = "1";
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: SPAWN_KILL_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Bun's timeout ends the process with SIGTERM. (`proc.killed` is true after
  // ANY exit, so it cannot tell a timeout from a normal finish.)
  if (proc.signalCode) {
    throw new Error(
      `nemar ${args.join(" ")} was ended by ${proc.signalCode} after ${SPAWN_KILL_MS}ms`,
    );
  }
  return { stdout, stderr, exitCode };
}

/**
 * A mistyped option, reported the way Commander reports one: the message on
 * stderr and exit 1, with no bug-report nudge (the exit handler adds that only
 * to exits Commander did not report) and not the CLI version.
 */
function expectUsageError(
  r: { stdout: string; stderr: string; exitCode: number },
  message: string,
) {
  expect(r.stderr).toContain(message);
  expect(r.stderr).not.toContain("Run again with --debug");
  expect(r.stdout.trim()).not.toBe(version);
  expect(r.exitCode).toBe(1);
}

describe("spawned CLI", () => {
  // The stand-in backend: answers the notices call every command makes and
  // records each request, so a test can see which URL the CLI really used.
  const hits: string[] = [];
  let backend: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(`${req.method} ${pathname}`);
        if (pathname === "/notices") return Response.json({ notices: [] });
        if (pathname === `/datasets/${DATASET_ID}`) {
          return Response.json({
            dataset: {
              dataset_id: DATASET_ID,
              name: "Stand-in dataset",
              github_repo: NO_SUCH_REPO,
              status: "active",
              visibility: "private",
            },
          });
        }
        if (pathname === `/datasets/${DATASET_ID}/versions`) {
          return Response.json({ dataset_id: DATASET_ID, current_version: "v1.0.0", versions: [] });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    backendUrl = `http://127.0.0.1:${backend.port}`;
  });

  afterAll(() => {
    backend.stop(true);
  });

  /** An account that points at the stand-in backend, with or without a key. */
  function writeAccount(apiKey?: string): void {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "argv-shadow",
        accounts: { "argv-shadow": { apiUrl: backendUrl, ...(apiKey ? { apiKey } : {}) } },
      }),
    );
  }

  beforeEach(() => {
    hits.length = 0;
    configDir = mkdtempSync(join(tmpdir(), "nemar-release-version-"));
    // No key by default: the release handler refuses with "Not authenticated".
    writeAccount();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // Compares flag strings and top-level command names only, as sets: not
  // descriptions, defaults or arguments, and not the order index.ts happens
  // to declare them in. A nested command or option added to a command group
  // is not checked here; those groups are imported, not copied.
  test(
    "the tree under test has the options and top-level commands of `nemar --help`",
    async () => {
      const result = await spawnCli(["--help"]);
      // A crashed spawn would otherwise read as drift.
      expect(result.exitCode).toBe(0);
      const help = result.stdout.split("\n");
      const section = (title: string) =>
        help
          .slice(help.indexOf(`${title}:`) + 1)
          .join("\n")
          .split("\n\n")[0]
          .split("\n")
          // Wrapped descriptions are indented further than the entries.
          .filter((line) => /^ {2}\S/.test(line));

      // `-h, --help` is Commander's own and not part of options[].
      const optionFlags = section("Options").map((line) => line.trim().split(/ {2,}/)[0]);
      expect([...optionFlags].sort()).toEqual(
        [...program.options.map((o) => o.flags), "-h, --help"].sort(),
      );

      // Help prints an aliased command as `name|alias`.
      const commandNames = section("Commands").map((line) => line.trim().split(/[\s|]/)[0]);
      expect([...commandNames].sort()).toEqual(
        [...program.commands.map((c) => c.name()), ...INLINE_ROOT_COMMANDS, "help"].sort(),
      );
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "dataset release --version X.Y.Z reaches the release handler",
    async () => {
      const r = await spawnCli(["dataset", "release", "nm099999", "--version", "2.0.0", "-y"]);
      expect(r.stdout.trim()).not.toBe(version);
      expect(r.stdout).toContain("Not authenticated");
      expect(r.exitCode).toBe(1);
      // Tripwire: the notices call every command makes went to the stand-in,
      // so config.json's apiUrl is honored. Without this, a config that
      // stopped being read would send the call to the real API silently.
      expect(hits).toContain("GET /notices");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "dataset release --version with no value fails like Commander",
    async () => {
      for (const args of [
        ["dataset", "release", "nm099999", "--version"],
        ["dataset", "release", "nm099999", "--version", "-y"],
      ]) {
        // The nudge assertion also proves index.ts reports the error through
        // Commander: an error thrown out of main() would get the nudge.
        expectUsageError(
          await spawnCli(args),
          "error: option '--version <version>' argument missing",
        );
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test.skipIf(!HAS_RELEASE_TOOLS)(
    "a lone dash reaches the handler as the version, and a dash-leading value needs =",
    async () => {
      writeAccount("stand-in-key");
      const dash = await spawnCli(["dataset", "release", DATASET_ID, "--version", "-", "-y"]);
      expect(dash.stdout).toContain("Invalid version: -");
      expect(dash.exitCode).toBe(1);

      const spaced = await spawnCli(["dataset", "release", DATASET_ID, "--version", "-1.0.0"]);
      expectUsageError(spaced, "error: option '--version <version>' argument missing");

      const equals = await spawnCli(["dataset", "release", DATASET_ID, "--version=-1.0.0", "-y"]);
      expect(equals.stdout).toContain("Invalid version: -1.0.0");
      expect(equals.exitCode).toBe(1);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a shadowed flag typed before its command fails instead of printing the version",
    async () => {
      for (const args of [
        ["dataset", "--version", "2.0.0", "release", DATASET_ID, "-y"],
        ["dataset", "--version", "release", DATASET_ID, "-y"],
      ]) {
        expectUsageError(
          await spawnCli(args),
          "error: option '--version <version>' must come after 'release'",
        );
      }
      // The equals spelling cannot reach `release` from there; `dataset`
      // refuses it, which is also a failure and not the version.
      const equals = await spawnCli(["dataset", "--version=2.0.0", "release", DATASET_ID, "-y"]);
      expectUsageError(equals, "unknown option '--version=2.0.0'");
      // At the root the flag is the root's own, as documented.
      const root = await spawnCli(["--version", "dataset", "release", DATASET_ID]);
      expect(root.stdout.trim()).toBe(version);
      expect(root.exitCode).toBe(0);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "release --help shows help even when --version has no value",
    async () => {
      for (const args of [
        ["dataset", "release", "--help", "--version"],
        ["dataset", "release", DATASET_ID, "--version", "--help"],
        ["dataset", "release", DATASET_ID, "--version", "-h"],
      ]) {
        const r = await spawnCli(args);
        expect(r.stdout).toContain("Usage: nemar dataset release");
        expect(r.stdout.trim()).not.toBe(version);
        expect(r.stderr).not.toContain("error:");
        expect(r.exitCode).toBe(0);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "an empty --version is a missing value, stopped before any request for the dataset",
    async () => {
      writeAccount("stand-in-key");
      for (const args of [
        ["dataset", "release", DATASET_ID, "--version", "", "--type", "patch", "-y"],
        ["dataset", "release", DATASET_ID, "--version", ""],
      ]) {
        const r = await spawnCli(args);
        expectUsageError(r, "error: option '--version <version>' argument missing");
        expect(r.stdout).toBe("");
        expect(hits).not.toContain(`GET /datasets/${DATASET_ID}`);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  // `--version=` reaches the handler as "". A truthiness check there read it
  // as "no --version": with --type it bumped by --type, and without it the
  // handler opened an interactive prompt that hangs on a closed stdin.
  test.skipIf(!HAS_RELEASE_TOOLS)(
    "an empty --version= reaches the handler and is refused as an invalid version",
    async () => {
      writeAccount("stand-in-key");
      for (const args of [
        ["dataset", "release", DATASET_ID, "--version=", "--type", "patch", "-y"],
        ["dataset", "release", DATASET_ID, "--version=", "-y"],
      ]) {
        const r = await spawnCli(args);
        expect(r.stdout).toContain("Invalid version");
        expect(r.stdout).not.toContain("Version bump");
        expect(r.exitCode).toBe(1);
        // The handler ran far enough to ask for the dataset and its versions.
        expect(hits).toContain(`GET /datasets/${DATASET_ID}/versions`);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "the root --version still prints the CLI version",
    async () => {
      const r = await spawnCli(["--version"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(version);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
