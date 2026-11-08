/**
 * cmd-scout — `mola scout "<need>"`: search broadly for existing code, harvest
 * the best candidates, decide reuse / adapt / write (FRAMEWORK §13.5).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ParsedArgs, PluginContext } from "@mola/plugin-sdk";
import { definePlugin, ExitCode, MolaError } from "@mola/plugin-sdk";
import { scout } from "./scout.js";
import type { ExecFn, FetchFn, ModelRunner, ScoutDeps } from "./types.js";

export { scout, buildDecisionPrompt, makeId } from "./scout.js";
export { deriveQueries, extractKeywords } from "./query.js";
export { classifyLicense, scoreCandidate } from "./score.js";
export type * from "./types.js";

const USAGE =
  'usage: mola scout "<need>" [--repo <dir>] [--limit 3] [--no-clone] [--no-llm] [--json] [--out <dir>]';

export const realExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code });
    };
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      err += `timed out after ${opts.timeoutMs}ms`;
      child.kill("SIGKILL");
      finish(124);
    }, opts.timeoutMs ?? 30_000);
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      err += e.message;
      finish(e.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });

/**
 * Default model runner: `mola run --kind explore --json "<prompt>"` (cmd-run
 * exports no programmatic entry; the runner is an injected dependency).
 */
export const spawnModelRunner =
  (exec: ExecFn = realExec): ModelRunner =>
  async (prompt, { kind, cwd }) => {
    const bin = process.env.MOLA_BIN ?? "mola";
    const r = await exec(bin, ["run", "--kind", kind, "--json", prompt], { cwd, timeoutMs: 180_000 });
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(`mola run exited ${r.code}: ${r.stderr.trim().split("\n").pop() ?? ""}`);
    try {
      const j = JSON.parse(r.stdout) as { data?: { finalText?: string }; finalText?: string };
      const text = j.data?.finalText ?? j.finalText;
      if (typeof text === "string") return text;
    } catch {
      /* not an envelope: use the raw text */
    }
    return r.stdout;
  };

export function realDeps(): ScoutDeps {
  return {
    exec: realExec,
    fetch: ((url, init) => globalThis.fetch(url, init as RequestInit)) as FetchFn,
    clock: () => new Date(),
    model: spawnModelRunner(),
  };
}

const BOOL_FLAGS = ["no-clone", "no-llm", "json"];

/** `--no-llm "need"` makes the generic parser swallow the need as the flag's value: give it back. */
function normalizeArgs(args: ParsedArgs): ParsedArgs {
  const positionals = [...args.positionals];
  const flags = { ...args.flags };
  for (const f of BOOL_FLAGS) {
    const v = flags[f];
    if (typeof v === "string") {
      if (v === "false") flags[f] = false;
      else {
        positionals.unshift(v);
        flags[f] = true;
      }
    }
  }
  return { positionals, flags };
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["scout"],
      description: "search, harvest and decide: find existing code before writing any (reuse.md)",
      async handler(raw, io) {
        const args = normalizeArgs(raw);
        const need = args.positionals.join(" ").trim();
        if (!need) throw new MolaError("USAGE_ERROR", USAGE, ExitCode.Usage);
        const f = args.flags;
        const limit = typeof f.limit === "string" ? Number.parseInt(f.limit, 10) : 3;
        if (!Number.isInteger(limit) || limit < 0) throw new MolaError("USAGE_ERROR", `--limit must be a non-negative integer\n${USAGE}`, ExitCode.Usage);
        const roots = ctx.config.get<unknown>("scout.roots", []);
        const res = await scout(
          need,
          {
            cwd: io.cwd,
            ...(typeof f.repo === "string" ? { repo: f.repo } : {}),
            roots: Array.isArray(roots) ? roots.filter((r): r is string => typeof r === "string") : [],
            limit,
            clone: f["no-clone"] !== true,
            llm: f["no-llm"] !== true,
            ...(typeof f.out === "string" ? { out: f.out } : {}),
          },
          realDeps(),
        );
        io.data(JSON.parse(readFileSync(res.candidatesPath, "utf8")));
        if (!io.json) {
          io.out(res.reusePath);
          for (const line of res.summary) io.out(line);
        }
        return ExitCode.Ok;
      },
    });
  },
});
