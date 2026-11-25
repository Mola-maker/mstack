/**
 * mstack as an MCP server over stdio (after T3 Code's /mcp for outside agents).
 * Any agent that speaks MCP can then read runs and, when allowed, start and
 * steer them:
 *
 *   claude mcp add mstack -- mola mcp --cwd /path/to/repo [--operate] [--allow-auto]
 *   codex mcp add mstack -- mola mcp --cwd /path/to/repo
 *
 * Access is a ceiling the human picks when adding the server, never something a
 * caller can raise:
 *   - read (default): list/inspect runs, diffs, usage, schedules, watches, guard check.
 *   - --operate: also start, note, approve/deny, stop, resume runs; add PR watches.
 *   - --allow-auto: runs it starts may skip the plan approval (`mola go --auto`).
 *     Without it the `auto` argument is refused, so a run started over MCP still
 *     waits for the human before implementing.
 * The working directory is fixed by --cwd; no tool takes a path.
 *
 * Each tool declares its access level in the table below, and the call path
 * checks it again (hiding a tool from tools/list is only discovery).
 */

import * as crypto from "node:crypto";

export type Access = "read" | "operate";

export interface ToolDef {
  name: string;
  access: Access;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  /** the mola argv for this call; throws on bad input */
  argv(input: Record<string, unknown>, grant: Grant): string[];
  /** a call that returns at once and keeps running (go start) */
  detached?: boolean;
}

export interface Grant {
  operate: boolean;
  allowAuto: boolean;
}

const s = (description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "string", description, ...extra });
const RUN = s("go run id (or a unique prefix)", { pattern: "^[\\w.-]{1,80}$" });
const ID_RE = /^[\w.-]{1,80}$/;

function want(input: Record<string, unknown>, key: string, re = /.+/s): string {
  const v = input[key];
  if (typeof v !== "string" || !re.test(v.trim())) throw new Error(`"${key}" is required and must match ${re}`);
  return v.trim();
}
function opt(input: Record<string, unknown>, key: string, re: RegExp): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !re.test(v)) throw new Error(`"${key}" must match ${re}`);
  return v;
}
const noDash = (t: string): string => {
  if (t.startsWith("-")) throw new Error('text must not start with "-"');
  return t;
};
const obj = (properties: Record<string, unknown>, required: string[] = []): ToolDef["inputSchema"] => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

export const TOOLS: ToolDef[] = [
  { name: "mstack_runs", access: "read", description: "List mola go runs in this repo, newest first.", inputSchema: obj({}), argv: () => ["go", "list"] },
  {
    name: "mstack_run_status",
    access: "read",
    description: "One go run: stages, status, cost, what it waits on. No run: the newest.",
    inputSchema: obj({ run: RUN }),
    argv: (i) => ["go", "status", ...(opt(i, "run", ID_RE) ? [opt(i, "run", ID_RE)!] : [])],
  },
  {
    name: "mstack_run_diff",
    access: "read",
    description: "A run's code changes from its checkpoints: one stage's own diff (checkpoint = stage name), or base → last.",
    inputSchema: obj({ run: RUN, checkpoint: s("stage name, e.g. implement"), stat: { type: "boolean" } }, ["run"]),
    argv: (i) => ["go", "diff", want(i, "run", ID_RE), ...(opt(i, "checkpoint", ID_RE) ? [opt(i, "checkpoint", ID_RE)!] : []), ...(i.stat === true ? ["--stat"] : [])],
  },
  {
    name: "mstack_usage",
    access: "read",
    description: "Tokens and estimated cost from agent transcripts.",
    inputSchema: obj({ days: { type: "integer", minimum: 1, maximum: 365 }, by: { type: "string", enum: ["model", "day", "project", "source"] } }),
    argv: (i) => ["usage", "--days", String(Number.isInteger(i.days) ? i.days : 7), "--by", typeof i.by === "string" && ["model", "day", "project", "source"].includes(i.by) ? i.by : "model"],
  },
  { name: "mstack_schedules", access: "read", description: "Scheduled go prompts and their next run.", inputSchema: obj({}), argv: () => ["schedule", "list"] },
  { name: "mstack_watches", access: "read", description: "PR watches and their state.", inputSchema: obj({}), argv: () => ["watch", "list"] },
  {
    name: "mstack_guard_check",
    access: "read",
    description: "Whether a commit has an independent review receipt and may land.",
    inputSchema: obj({ ref: s("git ref, default HEAD", { pattern: "^[\\w./-]{1,100}$" }) }),
    argv: (i) => ["guard", "check", ...(opt(i, "ref", /^[\w./-]{1,100}$/) ? ["--ref", opt(i, "ref", /^[\w./-]{1,100}$/)!] : [])],
  },
  {
    name: "mstack_run_start",
    access: "operate",
    description:
      "Start a mola go run (think → plan → implement → verify → review, ship only when asked). Returns at once with the run id; follow it with mstack_run_status. Same key, same run. Without auto, the run waits for the human to approve the plan.",
    inputSchema: obj(
      {
        intent: s("one sentence: what to get done", { maxLength: 4000 }),
        until: { type: "string", enum: ["think", "plan", "implement", "verify", "review", "ship"] },
        auto: { type: "boolean", description: "skip the plan approval (only when the server allows it)" },
        key: s("idempotency key", { pattern: "^[\\w:.-]{1,120}$" }),
      },
      ["intent"],
    ),
    detached: true,
    argv: (i, g) => {
      if (i.auto === true && !g.allowAuto) throw new Error("this server does not allow auto runs: the run would skip the human's plan approval (start mola mcp with --allow-auto)");
      const until = opt(i, "until", /^(think|plan|implement|verify|review|ship)$/);
      const key = opt(i, "key", /^[\w:.-]{1,120}$/) ?? `mcp:${crypto.randomBytes(6).toString("hex")}`;
      return ["go", noDash(want(i, "intent")), "--key", key, "--origin", "mcp", ...(until ? ["--until", until] : []), ...(i.auto === true ? ["--auto"] : [])];
    },
  },
  {
    name: "mstack_run_note",
    access: "operate",
    description: "Queue a note for a run; its next stage reads it. Never interrupts a stage.",
    inputSchema: obj({ run: RUN, text: s("the note", { maxLength: 4000 }) }, ["run", "text"]),
    argv: (i) => ["go", "say", want(i, "run", ID_RE), noDash(want(i, "text"))],
  },
  {
    name: "mstack_run_decide",
    access: "operate",
    description: "Approve or deny the approval a blocked run waits on.",
    inputSchema: obj({ run: RUN, decision: { type: "string", enum: ["approve", "deny"] } }, ["run", "decision"]),
    argv: (i) => ["go", want(i, "decision", /^(approve|deny)$/), want(i, "run", ID_RE)],
  },
  { name: "mstack_run_stop", access: "operate", description: "Ask a running run to stop.", inputSchema: obj({ run: RUN }, ["run"]), argv: (i) => ["go", "stop", want(i, "run", ID_RE)] },
  {
    name: "mstack_run_resume",
    access: "operate",
    description: "Resume a stopped, failed or blocked run from its first unfinished stage. Returns at once.",
    inputSchema: obj({ run: RUN }, ["run"]),
    detached: true,
    argv: (i) => ["go", "--resume", want(i, "run", ID_RE)],
  },
  {
    name: "mstack_watch_pr",
    access: "operate",
    description: "Watch a PR: wake (notify, and hand to a run) on failed or passed checks, conflicts, others' comments, merge or close. Needs mola serve.",
    inputSchema: obj({ pr: { type: "integer", minimum: 1 }, repo: s("owner/name", { pattern: "^[\\w.-]+/[\\w.-]+$" }), run: RUN }, ["pr"]),
    argv: (i) => {
      if (!Number.isInteger(i.pr) || (i.pr as number) < 1) throw new Error('"pr" must be a PR number');
      const repo = opt(i, "repo", /^[\w.-]+\/[\w.-]+$/);
      const run = opt(i, "run", ID_RE);
      return ["watch", "pr", String(i.pr), ...(repo ? ["--repo", repo] : []), ...(run ? ["--run", run] : [])];
    },
  },
];

export function visibleTools(g: Grant): ToolDef[] {
  return TOOLS.filter((t) => t.access === "read" || g.operate);
}

export interface Runner {
  /** run `mola <argv> --json`, wait; the envelope's data or an error */
  call(argv: string[]): Promise<{ ok: boolean; data?: unknown; error?: string; text?: string }>;
  /** start `mola <argv>` and do not wait */
  spawn(argv: string[]): void;
  /** for detached starts: the run id once it exists */
  findRunByKey?(key: string): Promise<string | undefined>;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const PROTOCOL = "2025-06-18";

export async function handle(req: RpcRequest, g: Grant, run: Runner): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id: req.id ?? null, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: "2.0", id: req.id ?? null, error: { code, message } });
  if (req.id === undefined) return undefined; // notification
  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mstack", version: "0.1.0" },
        instructions: `mstack runs: one sentence in, the pipeline out. Access: ${g.operate ? "operate" : "read only"}${g.operate && !g.allowAuto ? " (runs wait for the human's plan approval)" : ""}.`,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: visibleTools(g).map(({ name, description, inputSchema, access }) => ({ name, description, inputSchema, annotations: { readOnlyHint: access === "read" } })) });
    case "tools/call": {
      const name = req.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool: ${String(name)}`);
      const text = (t: string, isError = false): Record<string, unknown> => reply({ content: [{ type: "text", text: t }], isError });
      if (tool.access === "operate" && !g.operate) return text(`${tool.name} needs operate access; this server is read only (mola mcp --operate)`, true);
      const input = (req.params?.arguments ?? {}) as Record<string, unknown>;
      let argv: string[];
      try {
        argv = tool.argv(input, g);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
      if (tool.detached) {
        run.spawn(argv);
        const k = argv.indexOf("--key");
        const id = k >= 0 && run.findRunByKey ? await run.findRunByKey(argv[k + 1]) : undefined;
        return text(JSON.stringify({ started: true, ...(k >= 0 ? { key: argv[k + 1] } : {}), ...(id ? { run: id } : {}), next: "mstack_run_status" }));
      }
      const r = await run.call(argv);
      if (!r.ok) return text(r.error ?? "failed", true);
      return text(JSON.stringify(r.data ?? r.text ?? null, null, 1).slice(0, 60000));
    }
    default:
      return fail(-32601, `method not found: ${req.method}`);
  }
}
