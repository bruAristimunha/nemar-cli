/**
 * The three shell completion scripts `nemar completion <shell>` prints
 * (epic #1144 phase 5b, issue #1149, D4). Each one shells out to
 * `nemar __complete -- <words...>` and reads back newline-separated
 * candidates followed by a final `:<directive>` line -- the cobra protocol
 * (see src/lib/completion/candidates.ts's CompletionDirective for the short
 * list of directives this CLI actually emits).
 *
 * None of the three branches on the directive's value: the only one this
 * CLI ever emits is NoFileComp (suppress filename completion), and all
 * three registrations below already default to that -- bash's `complete -F`
 * with no `-o default`/`-o bashdefault`, zsh's `compadd` with no `_files`
 * fallback, and fish's `complete -f`. Reading it back is still done (and the
 * line is always stripped before the remaining lines become candidates) so
 * a future second directive doesn't require touching every script's parsing
 * logic, only its branching.
 *
 * The bash script avoids `mapfile` (bash 4+): macOS still ships bash 3.2 as
 * /bin/bash, where `mapfile` is "command not found", `raw` was never split and
 * TAB offered nothing, with the error hidden behind the user's prompt.
 *
 * Built with array-of-lines + join("\n") rather than one big template
 * literal, so the shells' own `${...}`/`$(...)` syntax below never has to
 * be escaped against TypeScript's own template-literal interpolation.
 */

const BASH_SCRIPT_LINES = [
  "# nemar completion for bash",
  "# Install (current shell):  source <(nemar completion bash)",
  "# Install (persistent):     nemar completion bash > /usr/local/etc/bash_completion.d/nemar",
  "_nemar_complete() {",
  "  local cur words_to_complete raw line lines n",
  '  cur="${COMP_WORDS[COMP_CWORD]}"',
  '  words_to_complete=("${COMP_WORDS[@]:1:COMP_CWORD}")',
  '  raw="$(nemar __complete -- "${words_to_complete[@]}" 2>/dev/null)"',
  "  COMPREPLY=()",
  '  if [[ -n "$raw" ]]; then',
  "    lines=()",
  '    while IFS= read -r line; do lines+=("$line"); done <<< "$raw"',
  "    n=${#lines[@]}",
  "    if (( n > 0 )); then",
  '      COMPREPLY=("${lines[@]:0:n-1}")',
  "    fi",
  "  fi",
  "}",
  "complete -F _nemar_complete nemar",
  "",
];

const ZSH_SCRIPT_LINES = [
  "#compdef nemar",
  "# nemar completion for zsh",
  "# Install (current shell):  source <(nemar completion zsh)",
  '# Install (persistent):     nemar completion zsh > "${fpath[1]}/_nemar"  (then restart your shell)',
  "_nemar() {",
  "  local -a request_words lines candidates",
  '  request_words=("${(@)words[2,CURRENT]}")',
  '  lines=("${(@f)$(nemar __complete -- "${request_words[@]}" 2>/dev/null)}")',
  "  if (( ${#lines[@]} > 0 )); then",
  '    candidates=("${(@)lines[1,-2]}")',
  "  else",
  "    candidates=()",
  "  fi",
  '  compadd -- "${candidates[@]}"',
  "}",
  '_nemar "$@"',
  "",
];

const FISH_SCRIPT_LINES = [
  "# nemar completion for fish",
  "# Install: nemar completion fish > ~/.config/fish/completions/nemar.fish",
  "function __nemar_complete_words",
  "    set -l tokens (commandline -opc)",
  "    set -l cur (commandline -ct)",
  "    set -l request_words",
  "    if test (count $tokens) -gt 1",
  "        set request_words $tokens[2..-1]",
  "    end",
  "    set request_words $request_words $cur",
  "    set -l lines (nemar __complete -- $request_words 2>/dev/null)",
  "    if test (count $lines) -gt 0",
  "        set -e lines[-1]",
  "    end",
  "    for line in $lines",
  "        echo $line",
  "    end",
  "end",
  "complete -c nemar -f -a '(__nemar_complete_words)'",
  "",
];

export function bashCompletionScript(): string {
  return BASH_SCRIPT_LINES.join("\n");
}

export function zshCompletionScript(): string {
  return ZSH_SCRIPT_LINES.join("\n");
}

export function fishCompletionScript(): string {
  return FISH_SCRIPT_LINES.join("\n");
}
