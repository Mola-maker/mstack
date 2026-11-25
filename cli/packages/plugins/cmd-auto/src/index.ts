/**
 * cmd-auto (FRAMEWORK §13.3 "unattended", after T3 Code's scheduled tasks,
 * webhook automations, PR watches and background service):
 *
 *   mola schedule add "<prompt>" --every 30m|--daily 09:30|--once <time> [--cwd d] [--auto] [--until stage]
 *   mola schedule list | rm|pause|resume|run <id>
 *   mola hook add "<prompt template>" [--cwd d] [--auto] [--github-secret <s>] [--filter "k=v"]… [--dedupe "{{…}}"]
 *                [--coalesce "{{…}}" --window 120]
 *   mola hook list | rm|pause|resume|rotate <id> | deliveries [id]
 *   mola watch pr <n> [--repo o/r] [--cwd d] [--run <goRunId> | --prompt "<p>"] [--auto] [--every 120]
 *   mola watch list | rm <id>
 *   mola serve [--port 7334] [--host 127.0.0.1] [--tick 30] [--max-runs 3] [--once]
 *   mola service install|uninstall [--yes] [-- <serve args>] | status
 */

import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Io, ParsedArgs, PluginContext } from "@mola/plugin-sdk";
import { ExitCode, MolaError, definePlugin, stripInvisible } from "@mola/plugin-sdk";
import { parseFilter, type Delivery, type Hook } from "./hooks.js";
import { type PrWatch } from "./prwatch.js";
import { describeWhen, nextRun, validateWhen, type Schedule, type When } from "./schedule.js";
import { molaHome, planService, UNIT, type ServicePlan } from "./service.js";
import { portOf, realDeps, Server } from "./serve.js";
import { mintId, pick, readList, readLog, writeList } from "./store.js";

export * from "./hooks.js";
export * from "./prwatch.js";
export * from "./schedule.js";
export * from "./serve.js";
export * from "./service.js";
export * from "./store.js";

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const usage = (text: string): MolaError => new MolaError("USAGE_ERROR", text, ExitCode.Usage);
const STAGES = ["think", "plan", "implement", "verify", "review", "ship"];

/** A flag that may repeat: parseArgs keeps the last, so read the raw argv too. */
export function repeated(name: string, args: ParsedArgs, argv: string[] = process.argv): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) out.push(argv[++i]);
    else if (argv[i].startsWith(`--${name}=`)) out.push(argv[i].slice(name.length + 3));
  }
  const v = str(args.flags[name]);
  if (v && !out.includes(v)) out.push(v);
  return out;
}

/** The prompt is passed to `mola go` as one argument: refuse what the CLI would read as a flag. */
function cleanPrompt(text: string): string {
  const { text: t, removed } = stripInvisible(text);
  const p = t.trim();
  if (!p) throw usage("the prompt is empty");
  if (p.startsWith("-")) throw usage('the prompt must not start with "-"');
  if (p.length > 8000) throw usage("the prompt is at most 8000 characters");
  if (removed > 0) process.stderr.write(`mola: removed ${removed} invisible character(s) from the prompt\n`);
  return p;
}

function cwdOf(io: Io, args: ParsedArgs): string {
  const c = str(args.flags.cwd);
  const dir = c ? path.resolve(io.cwd, c) : io.cwd;
  if (!fs.existsSync(dir)) throw new MolaError("NO_INPUT", `no such directory: ${dir}`, ExitCode.NoInput);
  return dir;
}

function untilOf(args: ParsedArgs): string | undefined {
  const u = str(args.flags.until);
  if (u && !STAGES.includes(u)) throw usage(`--until must be one of ${STAGES.join("|")}`);
  return u;
}

function oops(err: unknown): never {
  throw new MolaError("NO_INPUT", err instanceof Error ? err.message : String(err), ExitCode.NoInput);
}

function toggle<T extends { id: string }>(file: string, id: string | undefined, what: string, f: (x: T) => void): T {
  const list = readList<T>(file);
  let item: T;
  try {
    item = pick(list, id, what);
  } catch (err) {
    oops(err);
  }
  f(item);
  writeList(file, list);
  return item;
}

function runPlan(plan: ServicePlan, cmds: string[][], io: Io): boolean {
  let ok = true;
  for (const c of cmds) {
    const r = spawnSync(c[0], c.slice(1), { encoding: "utf8", windowsHide: true });
    const good = r.status === 0;
    // bootout of a service that is not loaded fails harmlessly
    const harmless = plan.platform === "launchd" && c[1] === "bootout";
    if (!good && !harmless) ok = false;
    io.out(`${good ? "ok  " : harmless ? "skip" : "FAIL"} ${c.join(" ")}${good || harmless ? "" : `: ${(r.stderr || r.error?.message || "").trim()}`}`);
  }
  return ok;
}

export default definePlugin({
  activate(ctx: PluginContext) {
    const reg = (p: string[], description: string, handler: (args: ParsedArgs, io: Io) => Promise<ExitCode> | ExitCode): void => {
      ctx.commands.register({ path: p, description, handler: async (a, io) => handler(a, io) });
    };

    // ------------------------------------------------------------ schedules
    reg(["schedule", "add"], "run a mola go prompt on a timer (--every 30m | --daily 09:30 | --once <time>)", (args, io) => {
      const prompt = cleanPrompt(args.positionals.join(" "));
      const f = args.flags;
      const whens: When[] = [];
      if (str(f.every)) whens.push({ every: str(f.every)! });
      if (str(f.daily)) whens.push({ daily: str(f.daily)! });
      if (str(f.once)) whens.push({ once: new Date(Date.parse(str(f.once)!)).toString() === "Invalid Date" ? str(f.once)! : new Date(Date.parse(str(f.once)!)).toISOString() });
      if (whens.length !== 1) throw usage('usage: mola schedule add "<prompt>" (--every 30m | --daily 09:30 | --once <time>) [--cwd d] [--auto] [--until stage]');
      const bad = validateWhen(whens[0]);
      if (bad) throw usage(bad);
      const until = untilOf(args);
      const s: Schedule = {
        id: mintId("s"),
        cwd: cwdOf(io, args),
        prompt,
        when: whens[0],
        enabled: true,
        auto: f.auto === true,
        ...(until ? { until } : {}),
        createdAt: new Date().toISOString(),
      };
      writeList("schedules.json", [...readList<Schedule>("schedules.json"), s]);
      io.data(s);
      io.out(`${s.id}: ${describeWhen(s.when)} in ${s.cwd}; next ${nextRun(s, Date.now())}. Runs need \`mola serve\` (or: mola service install).`);
      return ExitCode.Ok;
    });
    reg(["schedule", "list"], "schedules, with their next run", (_a, io) => {
      const list = readList<Schedule>("schedules.json");
      io.data(list.map((s) => ({ ...s, next: nextRun(s, Date.now()) })));
      if (list.length === 0) io.out("no schedules (mola schedule add)");
      for (const s of list) io.out(`${s.id}  ${describeWhen(s.when).padEnd(22)} next ${nextRun(s, Date.now())}  ${s.cwd}  ${s.prompt.slice(0, 60)}`);
      return ExitCode.Ok;
    });
    reg(["schedule", "rm"], "delete a schedule", (args, io) => {
      const list = readList<Schedule>("schedules.json");
      let s: Schedule;
      try {
        s = pick(list, args.positionals[0], "schedule");
      } catch (err) {
        oops(err);
      }
      writeList("schedules.json", list.filter((x) => x.id !== s.id));
      io.data({ removed: s.id });
      io.out(`removed ${s.id}`);
      return ExitCode.Ok;
    });
    reg(["schedule", "pause"], "pause a schedule", (args, io) => {
      const s = toggle<Schedule>("schedules.json", args.positionals[0], "schedule", (x) => (x.enabled = false));
      io.data(s);
      io.out(`${s.id} paused (resume: mola schedule resume ${s.id})`);
      return ExitCode.Ok;
    });
    reg(["schedule", "resume"], "resume a paused schedule", (args, io) => {
      const s = toggle<Schedule>("schedules.json", args.positionals[0], "schedule", (x) => (x.enabled = true));
      io.data(s);
      io.out(`${s.id} on; next ${nextRun(s, Date.now())}`);
      return ExitCode.Ok;
    });
    reg(["schedule", "run"], "start a schedule's run now (keyed, so it is one run per call)", (args, io) => {
      const list = readList<Schedule>("schedules.json");
      let s: Schedule;
      try {
        s = pick(list, args.positionals[0], "schedule");
      } catch (err) {
        oops(err);
      }
      const key = `sched:${s.id}:manual-${Date.now().toString(36)}`;
      const h = realDeps().mola(["go", s.prompt, "--key", key, "--origin", "trigger", ...(s.auto ? ["--auto"] : []), ...(s.until ? ["--until", s.until] : [])], s.cwd);
      io.data({ id: s.id, key, pid: h.pid ?? null });
      io.out(`started ${s.id} (${key}); follow it with: mola go status`);
      return ExitCode.Ok;
    });

    // ----------------------------------------------------------------- hooks
    reg(["hook", "add"], "a webhook URL that starts a mola go run from a prompt template", (args, io) => {
      const prompt = cleanPrompt(args.positionals.join(" "));
      const f = args.flags;
      const filters = repeated("filter", args).map((t) => {
        try {
          return parseFilter(t);
        } catch (err) {
          throw usage(err instanceof Error ? err.message : String(err));
        }
      });
      const window = f.window === undefined ? undefined : Number(f.window);
      if (window !== undefined && !(Number.isInteger(window) && window >= 10 && window <= 3600)) throw usage("--window is 10 to 3600 seconds");
      const ghSecret = str(f["github-secret"]);
      const h: Hook = {
        id: mintId("h"),
        secret: crypto.randomBytes(18).toString("base64url"),
        cwd: cwdOf(io, args),
        prompt,
        auto: f.auto === true,
        enabled: true,
        createdAt: new Date().toISOString(),
        ...(ghSecret ? { signature: { header: "x-hub-signature-256", secret: ghSecret } } : {}),
        filters,
        ...(str(f.dedupe) ? { dedupeKey: str(f.dedupe)! } : {}),
        ...(str(f.coalesce) ? { coalesceKey: str(f.coalesce)!, coalesceSec: window ?? 120 } : {}),
      };
      writeList("hooks.json", [...readList<Hook>("hooks.json"), h]);
      const p = `/hooks/${h.id}/${h.secret}`;
      io.data({ ...h, path: p });
      io.out(`${h.id}: POST ${p}`);
      io.out("Prefix the address of `mola serve` (default http://127.0.0.1:7334). The path holds the secret: give it only to the sender.");
      if (!ghSecret) io.out("Without --github-secret, anyone with the URL can start a run with any content.");
      return ExitCode.Ok;
    });
    reg(["hook", "list"], "webhooks (paths include their secret: --show-secrets)", (args, io) => {
      const list = readList<Hook>("hooks.json");
      const show = args.flags["show-secrets"] === true;
      io.data(list.map((h) => ({ ...h, secret: show ? h.secret : "***", signature: h.signature ? { header: h.signature.header, secret: "***" } : undefined })));
      if (list.length === 0) io.out("no webhooks (mola hook add)");
      for (const h of list) io.out(`${h.id}  ${h.enabled ? "on " : "off"}  /hooks/${h.id}/${show ? h.secret : "***"}  ${h.cwd}  ${h.prompt.slice(0, 50)}`);
      return ExitCode.Ok;
    });
    reg(["hook", "rm"], "delete a webhook", (args, io) => {
      const list = readList<Hook>("hooks.json");
      let h: Hook;
      try {
        h = pick(list, args.positionals[0], "hook");
      } catch (err) {
        oops(err);
      }
      writeList("hooks.json", list.filter((x) => x.id !== h.id));
      io.data({ removed: h.id });
      io.out(`removed ${h.id}; its URL stops working`);
      return ExitCode.Ok;
    });
    reg(["hook", "pause"], "pause a webhook (deliveries get 404)", (args, io) => {
      const h = toggle<Hook>("hooks.json", args.positionals[0], "hook", (x) => (x.enabled = false));
      io.data({ id: h.id, enabled: false });
      io.out(`${h.id} paused`);
      return ExitCode.Ok;
    });
    reg(["hook", "resume"], "resume a paused webhook", (args, io) => {
      const h = toggle<Hook>("hooks.json", args.positionals[0], "hook", (x) => (x.enabled = true));
      io.data({ id: h.id, enabled: true });
      io.out(`${h.id} on`);
      return ExitCode.Ok;
    });
    reg(["hook", "rotate"], "replace a webhook's URL secret (the old URL stops working)", (args, io) => {
      const h = toggle<Hook>("hooks.json", args.positionals[0], "hook", (x) => (x.secret = crypto.randomBytes(18).toString("base64url")));
      io.data({ id: h.id, path: `/hooks/${h.id}/${h.secret}` });
      io.out(`${h.id}: POST /hooks/${h.id}/${h.secret}`);
      return ExitCode.Ok;
    });
    reg(["hook", "deliveries"], "recent webhook deliveries and what each did", (args, io) => {
      const id = args.positionals[0];
      const rows = readLog<Delivery>("deliveries.jsonl").filter((d) => !id || d.hookId.startsWith(id)).slice(-50);
      io.data(rows);
      if (rows.length === 0) io.out("no deliveries yet");
      for (const d of rows) io.out(`${d.at}  ${d.hookId}  ${d.outcome}${d.reason ? ` (${d.reason})` : ""}${d.runKey ? `  ${d.runKey}` : ""}`);
      return ExitCode.Ok;
    });

    // --------------------------------------------------------------- watches
    reg(["watch", "pr"], "wake on a PR's failed/passed checks, conflicts, others' comments, merge or close", (args, io) => {
      const pr = Number(args.positionals[0]);
      if (!Number.isInteger(pr) || pr <= 0) throw usage("usage: mola watch pr <number> [--repo owner/name] [--run <goRunId> | --prompt \"…\"] [--auto] [--every 120]");
      const f = args.flags;
      const run = str(f.run);
      const prompt = str(f.prompt) ? cleanPrompt(str(f.prompt)!) : undefined;
      if (run && prompt) throw usage("--run and --prompt: pick one");
      const every = f.every === undefined ? 120 : Number(f.every);
      if (!Number.isInteger(every) || every < 30) throw usage("--every is at least 30 seconds");
      const repo = str(f.repo);
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw usage("--repo is owner/name");
      const list = readList<PrWatch>("watches.json");
      const cwd = cwdOf(io, args);
      const dup = list.find((w) => !w.ended && w.pr === pr && (w.repo ?? "") === (repo ?? "") && w.cwd === cwd);
      if (dup) {
        io.data(dup);
        io.out(`${dup.id} already watches PR #${pr}; it stays on`);
        return ExitCode.Ok;
      }
      const w: PrWatch = {
        id: mintId("w"),
        cwd,
        pr,
        ...(repo ? { repo } : {}),
        ...(run ? { run } : {}),
        ...(prompt ? { prompt } : {}),
        auto: f.auto === true,
        everySec: every,
        createdAt: new Date().toISOString(),
        commentOnlyWakes: 0,
        readFailures: 0,
        wakes: 0,
      };
      writeList("watches.json", [...list, w]);
      io.data(w);
      io.out(`${w.id}: watching PR #${pr} every ${every}s${run ? `, handing wakes to ${run}` : prompt ? ", one go run per wake" : ", notify only"}. Needs \`mola serve\`.`);
      return ExitCode.Ok;
    });
    reg(["watch", "list"], "PR watches", (_a, io) => {
      const list = readList<PrWatch>("watches.json");
      io.data(list);
      if (list.length === 0) io.out("no watches (mola watch pr <n>)");
      for (const w of list) io.out(`${w.id}  PR #${w.pr}${w.repo ? ` ${w.repo}` : ""}  ${w.ended ? `ended: ${w.ended}` : `wakes ${w.wakes}, last read ${w.lastReadAt ?? "never"}`}`);
      return ExitCode.Ok;
    });
    reg(["watch", "rm"], "stop and delete a PR watch", (args, io) => {
      const list = readList<PrWatch>("watches.json");
      let w: PrWatch;
      try {
        w = pick(list, args.positionals[0], "watch");
      } catch (err) {
        oops(err);
      }
      writeList("watches.json", list.filter((x) => x.id !== w.id));
      io.data({ removed: w.id });
      io.out(`removed ${w.id}`);
      return ExitCode.Ok;
    });

    // ----------------------------------------------------------------- serve
    reg(["serve"], "the resident loop: schedules, delayed resumes, webhooks, PR watches", async (args, io) => {
      const f = args.flags;
      const tick = f.tick === undefined ? 30 : Number(f.tick);
      const maxRuns = f["max-runs"] === undefined ? Number(ctx.config.get("serve.maxRuns", 3)) : Number(f["max-runs"]);
      if (!(tick >= 5)) throw usage("--tick is at least 5 seconds");
      const cfgCwds = ctx.config.get<unknown>("web.cwds", []);
      const server = new Server(realDeps(), { maxRuns, cwds: [io.cwd, ...(Array.isArray(cfgCwds) ? cfgCwds.filter((c): c is string => typeof c === "string") : [])] });
      if (f.once === true) {
        const r = await server.tick();
        io.data(r);
        io.out(`tick: ${r.schedules} schedule run(s), ${r.resumed} resumed, ${r.windows} webhook window(s), ${r.watches} watch read(s)`);
        return ExitCode.Ok;
      }
      const port = f.port === undefined ? Number(ctx.config.get("serve.port", 7334)) : Number(f.port);
      const host = str(f.host) ?? String(ctx.config.get("serve.host", "127.0.0.1"));
      const http = await server.listen(port, host);
      io.out(`mola serve: ticking every ${tick}s; webhooks on http://${host.includes(":") ? `[${host}]` : host}:${portOf(http)}/hooks/<id>/<secret>`);
      let busy = false;
      const loop = async (): Promise<void> => {
        if (busy) return;
        busy = true;
        try {
          await server.tick();
        } catch (err) {
          io.note(`mola serve: tick failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          busy = false;
        }
      };
      await loop();
      const timer = setInterval(() => void loop(), tick * 1000);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      clearInterval(timer);
      await new Promise<void>((r) => http.close(() => r()));
      return ExitCode.Ok;
    });

    // --------------------------------------------------------------- service
    const plan = (args: ParsedArgs): ServicePlan => {
      const entry = process.argv[1];
      if (!entry) throw new MolaError("NO_INPUT", "cannot find the mola entry point", ExitCode.NoInput);
      const dash = process.argv.indexOf("--");
      const extra = dash >= 0 ? process.argv.slice(dash + 1) : [];
      return planService({ node: process.execPath, entry: path.resolve(entry), args: extra });
    };
    reg(["service", "install"], "keep mola serve running (systemd --user, launchd, Task Scheduler); --yes applies", (args, io) => {
      const p = plan(args);
      io.data({ ...p, written: false });
      io.out(`platform: ${p.platform}`);
      if (p.file) io.out(`write ${p.file.path}:\n${p.file.content}`);
      for (const c of p.commands) io.out(`run   ${c.join(" ")}`);
      for (const n of p.notes) io.out(`note  ${n}`);
      io.out(`env   ${path.join(molaHome(), "service.env")} (KEY=VALUE; kept across install/uninstall)`);
      if (!(io.yes || args.flags.yes === true)) {
        io.out("not done. Re-run with --yes.");
        return ExitCode.Ok;
      }
      if (p.file) {
        fs.mkdirSync(path.dirname(p.file.path), { recursive: true });
        fs.writeFileSync(p.file.path, p.file.content, "utf8");
      }
      fs.mkdirSync(path.join(molaHome(), "logs"), { recursive: true });
      const ok = runPlan(p, p.commands, io);
      io.data({ ...p, written: true, ok });
      return ok ? ExitCode.Ok : ExitCode.Error;
    });
    reg(["service", "uninstall"], "stop mola serve and remove it from startup (state and service.env are kept); --yes applies", (args, io) => {
      const p = plan(args);
      for (const c of p.undo) io.out(`run    ${c.join(" ")}`);
      if (p.file) io.out(`delete ${p.file.path}`);
      if (!(io.yes || args.flags.yes === true)) {
        io.data({ ...p, removed: false });
        io.out("not done. Re-run with --yes.");
        return ExitCode.Ok;
      }
      const ok = runPlan(p, p.undo, io);
      if (p.file) fs.rmSync(p.file.path, { force: true });
      io.data({ ...p, removed: true, ok });
      return ExitCode.Ok;
    });
    reg(["service", "status"], "is mola serve installed and running", (_a, io) => {
      const p = planService({ node: process.execPath, entry: process.argv[1] ?? "mola", args: [] });
      const facts: Record<string, string | boolean> = { platform: p.platform };
      const sh = (c: string[]): { ok: boolean; out: string } => {
        const r = spawnSync(c[0], c.slice(1), { encoding: "utf8", windowsHide: true });
        return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
      };
      if (p.platform === "systemd") {
        facts.installed = fs.existsSync(p.file!.path);
        facts.active = sh(["systemctl", "--user", "is-active", `${UNIT}.service`]).out || "unknown";
        facts.enabled = sh(["systemctl", "--user", "is-enabled", `${UNIT}.service`]).out || "unknown";
        const linger = sh(["loginctl", "show-user", process.env.USER ?? "", "--property=Linger"]).out;
        facts.linger = /Linger=yes/.test(linger) ? "yes" : linger ? "no (stops at logout)" : "unknown";
      } else if (p.platform === "launchd") {
        facts.installed = fs.existsSync(p.file!.path);
        facts.loaded = sh(["launchctl", "list", "dev.mola.serve"]).ok;
      } else {
        facts.installed = sh(["schtasks", "/Query", "/TN", UNIT]).ok;
      }
      io.data(facts);
      for (const [k, v] of Object.entries(facts)) io.out(`${k.padEnd(10)} ${String(v)}`);
      return ExitCode.Ok;
    });
  },
});
