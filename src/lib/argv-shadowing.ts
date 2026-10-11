/**
 * Keep a subcommand's value-taking option from being claimed by an ancestor
 * option of the same name (#1493).
 *
 * The hazard: Commander recognizes an ancestor's options anywhere on the
 * command line unless positional options are enabled, and enabling them would
 * break every global flag typed after the subcommand (`nemar dataset upload
 * ./x --verbose`). The root declares `-v, --version` as a boolean, so in
 * `nemar dataset release nm000104 --version 2.0.0`, the form the release help
 * documents, the root claims `--version`, prints the CLI version and exits 0,
 * and a scripted release (`-y`) silently does nothing. The equals spelling
 * (`--version=2.0.0`) reaches the subcommand, because a boolean does not match
 * `--flag=value`.
 *
 * The rewrite: for the command the line addresses, every option that takes a
 * value and whose long flag an ancestor declares as a BOOLEAN is joined to its
 * value (`--version 2.0.0` -> `--version=2.0.0`). Only the tokens after that
 * command's name are its own. An ancestor option that takes a value itself
 * (`admin recover --recover-file`) needs no join: the ancestor consumes the
 * flag and its value together, and the leaf reads it back through
 * `optsWithGlobals()`.
 *
 * Two shapes are errors, because passing them along lets the root claim the
 * flag, which is the same silent no-op:
 * - A shadowed flag with no value: last token, empty, or followed by a token
 *   that reads as a flag. Commander itself would take ANY next token as the
 *   value of a required option; this deliberately diverges, because a
 *   flag-looking next token (`--version -y`) is far more likely a forgotten
 *   value than a value. A value that really starts with "-" is spelled
 *   `--flag=value`. A lone "-" counts as a value, as it does for Commander.
 * - A shadowed flag typed before the command that declares it (`dataset
 *   --version 2.0.0 release`). At the root it stays the root's own flag.
 * Asking for help (`--help` or `-h` before `--`) outranks a missing value; the
 * bare flag is dropped so the root does not print the version instead.
 *
 * The errors are thrown, not printed: the function stays free of output and
 * process.exit so tests can assert on it, and src/index.ts reports them
 * through the declaring command, which makes the stream and exit code
 * Commander's own. The message is rebuilt here because Commander's
 * optionMissingArgument is private and absent from its typings; the tests pin
 * the literal, so an upgrade that changes the wording is noticed.
 *
 * Left alone: anything after `--`, a flag already spelled `--flag=value`, and
 * boolean collisions (#1220, `-v` vs `-v, --verbose`). Not handled:
 * - Short flags. Rewriting cannot rescue one: Commander's combined-short-flag
 *   rule makes the root claim `-vVALUE`. None exists today.
 * - An OPTIONAL-value option (`--flag [value]`) is joined when it has a
 *   value, but without one a bare flag has no spelling the root will not
 *   claim. None exists today; a test pins that.
 */

import type { Command, Option } from "commander";

/**
 * A shadowed value-taking option was written without a value. Carries the
 * command that declares it so the caller can report it the way Commander does.
 */
export class MissingShadowedValueError extends Error {
  readonly code = "commander.optionMissingArgument";

  constructor(
    readonly command: Command,
    readonly option: Option,
  ) {
    // Commander's own wording for a required option with no argument.
    super(`error: option '${option.flags}' argument missing`);
    this.name = "MissingShadowedValueError";
  }
}

/**
 * A shadowed option was typed before the command it belongs to
 * (`dataset --version 2.0.0 release`). The command ahead of it does not
 * declare it, so the root claims it, and the equals spelling cannot reach the
 * right command either (Commander has the command ahead reject it as an
 * unknown option).
 */
export class MisplacedShadowedOptionError extends Error {
  readonly code = "commander.unknownOption";

  constructor(
    readonly command: Command,
    readonly option: Option,
  ) {
    super(`error: option '${option.flags}' must come after '${command.name()}'`);
    this.name = "MisplacedShadowedOptionError";
  }
}

/**
 * Whether `token` can stand as an option's value. A lone "-" can: Commander
 * itself reads it as a value (it is the usual spelling of stdin). Any other
 * token that starts with "-" reads as a flag, so a value that starts with "-"
 * has to be spelled `--flag=value`. An empty token is a missing value, not an
 * empty one: a caller testing the option for truthiness reads it as absent.
 */
function isValue(token: string | undefined): token is string {
  return token === "-" || (!!token && !token.startsWith("-"));
}

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/**
 * The value-taking options of `command` that an ancestor's BOOLEAN option of
 * the same long flag would claim first, keyed by that long flag.
 *
 * The outermost ancestor declaring a flag is the one Commander parses it
 * with. A boolean takes the flag and leaves the value behind as a stray
 * argument, so those are the options that need a join. An ancestor that takes a
 * value itself (`admin recover --recover-file`) consumes the flag and its value
 * together, so nothing is shadowed.
 */
function shadowedOptions(command: Command, ancestors: readonly Command[]): Map<string, Option> {
  const claimedBy = new Map<string, Option>();
  for (const ancestor of ancestors) {
    for (const o of ancestor.options) {
      if (o.long && !claimedBy.has(o.long)) claimedBy.set(o.long, o);
    }
  }
  const shadowed = new Map<string, Option>();
  for (const o of command.options) {
    if (!(o.required || o.optional) || !o.long) continue;
    const claimant = claimedBy.get(o.long);
    if (claimant && !(claimant.required || claimant.optional)) shadowed.set(o.long, o);
  }
  return shadowed;
}

/**
 * Every long flag that some command below `command` takes a value for while an
 * ancestor's boolean claims it. Tree-wide on purpose: the walk meets a flag
 * before it knows which command will end up taking it.
 */
function shadowedFlagsInTree(command: Command, ancestors: readonly Command[]): Set<string> {
  const flags = new Set(shadowedOptions(command, ancestors).keys());
  for (const sub of command.commands) {
    for (const f of shadowedFlagsInTree(sub, [...ancestors, command])) flags.add(f);
  }
  return flags;
}

/**
 * Return `argv` (user arguments, i.e. `process.argv.slice(2)`) with shadowed
 * value options of the addressed subcommand joined to their values.
 *
 * @throws {MissingShadowedValueError} a shadowed option that requires a value
 *   appears with none.
 * @throws {MisplacedShadowedOptionError} a shadowed option is typed before the
 *   command that declares it.
 */
export function bindShadowedOptionValues(root: Command, argv: string[]): string[] {
  // `--` ends option parsing: what follows it is neither a flag nor a command.
  const dashDash = argv.indexOf("--");
  const end = dashDash < 0 ? argv.length : dashDash;

  // Walk to the leaf command: descend while a non-flag token names a
  // subcommand of the current one, skipping tokens that start with "-". That
  // assumes no command with subcommands takes a value option, so no option
  // value can be mistaken for a subcommand name. Only `admin recover
  // --recover-file` does; its value ends the walk at `recover`, which shadows
  // nothing. The one value the walk steps over is a shadowed flag's own.
  const treeFlags = shadowedFlagsInTree(root, []);
  const early: { flag: string; index: number }[] = [];
  const ancestors: Command[] = [];
  let current = root;
  let leafIndex = -1;
  for (let i = 0; i < end; i++) {
    const token = argv[i];
    if (token.startsWith("-")) {
      // A shadowed flag below the root, ahead of the command that takes it
      // (`dataset --version 2.0.0 release`): remember it, and step over its
      // value so the walk can still find that command. At the root it is the
      // root's own flag (`nemar --version`).
      if (current !== root && treeFlags.has(token)) {
        early.push({ flag: token, index: i });
        const next = argv[i + 1];
        if (isValue(next) && !findSubcommand(current, next)) i++;
      }
      continue;
    }
    const sub = findSubcommand(current, token);
    if (!sub) break;
    ancestors.push(current);
    current = sub;
    leafIndex = i;
  }
  if (leafIndex < 0) return argv;

  const shadowed = shadowedOptions(current, ancestors);
  if (shadowed.size === 0) return argv;
  for (const { flag, index } of early) {
    const option = shadowed.get(flag);
    if (option && index < leafIndex) throw new MisplacedShadowedOptionError(current, option);
  }

  // Help outranks a missing value: asking for it is a request to read, not run.
  const helpRequested = argv.slice(0, end).some((token) => token === "--help" || token === "-h");

  // Only the tokens after the leaf's name belong to it. Whatever came before
  // stays the ancestors' (`nemar --version dataset release ...` prints the
  // version), apart from the misplaced flag rejected above.
  const out = argv.slice(0, leafIndex + 1);
  for (let i = leafIndex + 1; i < end; i++) {
    const token = argv[i];
    const option = shadowed.get(token);
    if (!option) {
      out.push(token);
      continue;
    }
    const next = argv[i + 1];
    if (isValue(next)) {
      out.push(`${token}=${next}`);
      i++;
    } else if (!helpRequested) {
      if (option.required) throw new MissingShadowedValueError(current, option);
      out.push(token);
    }
    // else: with help requested the bare flag is dropped. Left in, the root
    // claims it and prints the CLI version instead of the help.
  }
  out.push(...argv.slice(end));
  return out;
}
