/**
 * Parsers for magpie's human-readable output (adapters-routing §3.4).
 *
 * `magpie ls` and `magpie <agent>` have NO `--json` flag in the captured help
 * (core-plugins §10 records this gap), so mola parses the stable table output
 * and keeps golden fixtures in the tests. Nothing here invents a flag.
 *
 * Table shape (from `magpie ls`):
 *
 *   Claude Code            —  ·  effort xhigh          ~\.claude\settings.json
 *   Codex                  kimi-code-cn/k3  ·  effort high      ~\.codex\config.toml
 *   DeepSeek Harness · WSL Ubuntu  magpie/group/smart-split  ·  thinking —   \\wsl...\cordis.patch.yml
 *
 * i.e. name, then the current model (or `—`/`provider`), optional `· effort x`
 * fields, then the settings/config path.
 */

export interface MagpieAgentRow {
  /** the display name magpie shows, e.g. "Claude Code", "DeepSeek Harness · WSL Ubuntu" */
  name: string;
  /** magpie's id for this agent, e.g. "claude", "dsh@wsl:Ubuntu" */
  id: string;
  /** the model magpie currently pins for this agent, e.g. "magpie/group/smart-split" */
  model?: string;
  /** the raw "model · effort x" middle column */
  modelColumn: string;
  /** the settings/config file magpie manages for this agent */
  configPath?: string;
  /** extra field values, e.g. { effort: "xhigh" } */
  fields: Record<string, string>;
}

const DASHES = new Set(["—", "–", "-", "‐"]);
const MIDDLE_DOT = "·";

function isDash(v: string | undefined): boolean {
  return v === undefined || DASHES.has(v.trim());
}

/** magpie's display-name → id mapping (the ids `magpie <agent>` accepts). */
const NAME_TO_ID: Record<string, string> = {
  "claude code": "claude",
  "claude desktop": "claude-desktop",
  codex: "codex",
  "antigravity cli": "agy",
  antigravity: "antigravity",
  opencode: "opencode",
  pi: "pi",
  omo: "omo",
  "vs code": "vscode",
  "deepseek harness": "dsh",
  omp: "omp",
  devin: "devin",
  "kimi code": "kimi",
  "qwen code": "qwen",
  "muse code": "muse",
  openclaw: "openclaw",
  cline: "cline",
  "grok build": "grok",
  zcode: "zcode",
  workbuddy: "workbuddy",
  codebuddy: "codebuddy",
  alma: "alma",
};

/**
 * Derive an agent id from magpie's display name.
 * "DeepSeek Harness · WSL Ubuntu" → "dsh@wsl:Ubuntu"; "Kimi Code" → "kimi".
 * The suffix matches the ids `magpie <agent>` accepts (its unknown-agent error
 * text lists "dsh@wsl:Ubuntu"), so mola can hand the id straight back.
 */
export function agentIdFromName(name: string): string {
  const dot = name.indexOf(MIDDLE_DOT);
  const base = (dot < 0 ? name : name.slice(0, dot)).trim();
  const id = NAME_TO_ID[base.toLowerCase()] ?? base.toLowerCase().replace(/\s+/g, "-");
  if (dot < 0) return id;
  const raw = name.slice(dot + 1).trim();
  const wsl = /^wsl\s+(.+)$/i.exec(raw);
  return `${id}${wsl ? `@wsl:${wsl[1].trim()}` : `@${raw}`}`;
}

/** The machine part of a `dsh@wsl:Ubuntu` id, or "local". */
export function machineOf(agentId: string): string {
  const at = agentId.indexOf("@");
  if (at < 0) return "local";
  const suffix = agentId.slice(at + 1);
  return suffix.startsWith("wsl:") ? suffix : `local:${suffix}`;
}

/**
 * Parse `magpie ls` output into rows.
 * Lines that are not agent rows (headers, blanks) are skipped.
 */
export function parseMagpieLs(stdout: string): MagpieAgentRow[] {
  const rows: MagpieAgentRow[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    // skip magpie's section headers ("Routing groups", "DeepSeek", …)
    if (!/^\s{2}\S/.test(raw)) continue;

    // Split on 2+ spaces — the table uses wide column gaps. The config path is
    // always last and contains a separator (\ or /) or a scheme (http://).
    const parts = raw.trim().split(/\s{2,}/);
    if (parts.length < 2) continue;

    // "DeepSeek Harness · WSL Ubuntu" is a single name cell; magpie separates
    // the name and the model with 2+ spaces, so a name containing "·" is fine.
    const name = parts[0].trim();
    const configPath = parts[parts.length - 1].trim();
    const modelColumn = parts.slice(1, parts.length - 1).join("  ").trim();

    const model = extractModel(modelColumn);
    rows.push({
      name,
      id: agentIdFromName(name),
      model,
      modelColumn,
      configPath: isDash(configPath) ? undefined : configPath,
      fields: extractFields(modelColumn),
    });
  }
  return rows;
}

/**
 * Pull the model id out of the middle column.
 * "magpie/group/smart-split  ·  thinking —"  → "magpie/group/smart-split"
 * "kimi-code-cn/k3  ·  effort high"           → "kimi-code-cn/k3"
 * "provider —"                               → "provider"
 * "—"                                        → undefined
 */
export function extractModel(modelColumn: string): string | undefined {
  const column = modelColumn.trim();
  if (!column) return undefined;
  let head = column.split(/\s{2,}/)[0]?.trim() ?? "";
  head = head.split(MIDDLE_DOT)[0].trim();
  if (!head || isDash(head)) return undefined;
  // drop a trailing placeholder dash: "provider —" → "provider"
  const tokens = head.split(/\s+/);
  while (tokens.length > 1 && isDash(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

/** Pull "effort x" / "thinking y" style fields out of the middle column. */
export function extractFields(modelColumn: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of modelColumn.split(MIDDLE_DOT)) {
    const piece = chunk.trim();
    if (!piece || isDash(piece)) continue;
    const m = /^([a-z][a-z-]*)\s+(.+)$/i.exec(piece);
    if (!m) continue;
    const value = m[2].trim();
    if (isDash(value)) continue; // "thinking —" is no value
    out[m[1].toLowerCase()] = value;
  }
  return out;
}

/**
 * Parse `magpie <agent>` (one agent) output:
 *   "  DeepSeek Harness  magpie/group/claude-cheap  ·  thinking high  ~\.dsh\...\cordis.patch.yml"
 */
export function parseMagpieAgent(stdout: string): MagpieAgentRow | undefined {
  const rows = parseMagpieLs(stdout);
  return rows[0];
}

/**
 * Parse `magpie models [<agent>]` output into route ids.
 *
 * The output has sections:
 *   "  Routing groups"     → group/<id> rows
 *   "  DeepSeek"           → deepseek/<model> rows
 *   "  <agent> is shown …" → the agent's visible set (summary line)
 *
 * Route rows look like "  group/smart-split             <description>".
 */
export function parseMagpieRoutes(stdout: string): string[] {
  const routes: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^\s{2,}(group\/[A-Za-z0-9._-]+|auto\/[A-Za-z0-9._-]+|deepseek\/[A-Za-z0-9._\-[\]]+)\s/.exec(raw);
    if (!m) continue;
    if (!routes.includes(m[1])) routes.push(m[1]);
  }
  return routes;
}

/**
 * The agent's visible route set from `magpie models <agent>`.
 *
 * magpie writes the visible set in a lossy display form:
 *   "  dsh is shown smart-split, forcp, group-2, …, auto-kimi-k3, …"
 * The route id is written with `-` where the id has `/` (and dots survive as
 * dots), so the tokens cannot be turned back into ids reliably on their own.
 * `visibleRouteNames` therefore returns the raw tokens; the caller matches
 * them against the authoritative route ids from `parseMagpieRoutes`.
 */
export function visibleRouteNames(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^\s{2,}(\S+) is shown (.+)$/.exec(raw);
    if (!m) continue;
    for (const token of m[2].split(",")) {
      const t = token.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Match the visible display tokens against the real route ids.
 *
 * magpie's display form is lossy: `group/smart-split` is shown as the bare
 * group id ("smart-split"), while `auto/kimi-k3` keeps its family prefix
 * ("auto-kimi-k3"), and dots become "-" ("auto-minimax-m3-1-flash" is
 * `auto/minimax-m3.1-flash`). Each route id is therefore keyed both whole and
 * without its `group/`/`auto/` prefix, all in normalized (dot/slash → dash)
 * form, and tokens are looked up in both maps.
 */
export function matchVisibleRoutes(names: string[], routeIds: string[]): string[] {
  const normalize = (s: string): string => s.replace(/[./]/g, "-").toLowerCase();
  const byNorm = new Map<string, string>();
  for (const route of routeIds) {
    const norm = normalize(route);
    byNorm.set(norm, route);
    const stripped = norm.replace(/^(group|auto)-/, "");
    if (!byNorm.has(stripped)) byNorm.set(stripped, route);
  }
  const out: string[] = [];
  for (const name of names) {
    const hit = byNorm.get(normalize(name));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}
