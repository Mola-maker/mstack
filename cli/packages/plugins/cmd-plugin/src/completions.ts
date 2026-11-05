/**
 * `mola completions <bash|zsh|pwsh>` (core §8.1).
 *
 * The completion script is generated from the *live* command registry, so it
 * can never drift from the commands that actually exist: the router knows
 * every registered path and its description. The plugin asks the core router
 * for the inventory and renders the shell function from it.
 *
 * The core router is not reachable through PluginContext (core §2.3 — the
 * router exposes no handle to plugins), so cmd-plugin depends on @mola/core
 * and calls the same registry the router built. The core exposes
 * `activeRouter()` for exactly this purpose — a read-only inventory accessor
 * in the same spirit as `describeActiveBus()`.
 */

export type Shell = "bash" | "zsh" | "pwsh";

export const SHELLS: readonly Shell[] = ["bash", "zsh", "pwsh"];

export interface CommandEntry {
  /** namespaced path, e.g. ["plugin", "install"] */
  path: string[];
  description: string;
}

/** Render the completion script for one shell. */
export function renderCompletions(shell: Shell, commands: CommandEntry[]): string {
  const paths = commands.map((c) => c.path.join(" "));
  switch (shell) {
    case "bash":
      return renderBash(paths);
    case "zsh":
      return renderZsh(paths);
    case "pwsh":
      return renderPwsh(paths);
  }
}

function renderBash(paths: string[]): string {
  // one array entry per command path; the words are quoted so a path with a
  // space stays one entry
  const entries = paths.map((p) => `  ${JSON.stringify(p)}`).join("\n");
  return `# mola bash completion — install with: mola completions bash > /etc/bash_completion.d/mola
_MOLA_COMMANDS=(
${entries}
)

_mola_complete() {
  local cur prefix rest candidate
  cur="\${COMP_WORDS[COMP_CWORD]}"
  # the words typed after "mola" — the prefix of a command path
  prefix=""
  local i
  for (( i=1; i < COMP_CWORD; i++ )); do
    case "\${COMP_WORDS[i]}" in
      -*) continue ;;
    esac
    prefix="\${prefix}\${COMP_WORDS[i]} "
  done
  # every known path that starts with what the user typed; offer the next word
  local candidates=""
  for candidate in "\${_MOLA_COMMANDS[@]}"; do
    case "\${candidate}" in
      "\${prefix}"*)
        rest="\${candidate#\${prefix}}"
        case " \${candidates} " in
          *" \${rest%% *} "*) continue ;;
        esac
        candidates="\${candidates} \${rest%% *}"
        ;;
    esac
  done
  COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
  return 0
}
complete -F _mola_complete mola

# known command paths:
# ${paths.join(", ")}
`;
}

function renderZsh(paths: string[]): string {
  // zsh's _describe wants "value:description"; the value is the full path
  const lines = paths
    .map((p) => `    '${p.replace(/:/g, "\\:")}':${p}`)
    .join("\n");
  return `#compdef mola
# mola zsh completion — install with: mola completions zsh > "\${fpath[1]}/_mola"
_mola() {
  local -a commands
  commands=(
${lines}
  )
  _describe 'mola command' commands
}
compdef _mola mola
`;
}

function renderPwsh(paths: string[]): string {
  const list = paths.map((p) => `'${p}'`).join(", ");
  return `# mola PowerShell completion — install with: mola completions pwsh | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName 'mola' -ScriptBlock {
    param(\$wordToComplete, \$commandAst, \$cursorPosition)
    @(${list}) |
        Where-Object { \$_ -like "\$wordToComplete*" } |
        ForEach-Object {
            [System.Management.Automation.CompletionResult]::new(\$_, \$_, 'ParameterValue', \$_)
        }
}
`;
}

/** The commands a completion script should offer, sorted and deduped. */
export function normalizeCommands(commands: CommandEntry[]): CommandEntry[] {
  const seen = new Set<string>();
  const out: CommandEntry[] = [];
  for (const c of commands) {
    const key = c.path.join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ path: c.path, description: c.description ?? "" });
  }
  return out.sort((a, b) => a.path.join(" ").localeCompare(b.path.join(" ")));
}
