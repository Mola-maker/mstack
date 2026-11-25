/**
 * `mola serve`: the resident half of unattended work. One tick (default every
 * 30 s) does, in order:
 *   1. schedules whose slot is due → `mola go … --key sched:<id>:<slot>`;
 *   2. go runs whose `resumeAt` passed → `mola go --resume <id>`;
 *   3. webhook coalescing windows that closed → `mola go … --key hook:…`;
 *   4. PR watches that are due → read, compare, wake.
 * And it answers POST /hooks/<id>/<secret> and GET /healthz.
 *
 * Every run is a `mola` child started with an argv array (never a shell). The
 * idempotency key makes a double start harmless; `maxRuns` caps how many
 * trigger runs go at once (a due slot waits for a free one).
 */

import { spawn, spawnSync } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { listProgress, wrapUntrusted, writeProgress } from "@mola/plugin-sdk";
import { closeWindows, decide, MAX_BODY, secretMatches, type Delivery, type Hook, type HookRequest, type HookState } from "./hooks.js";
import { account, compare, MAX_READ_FAILURES, PR_FIELDS, wakeText, type PrWatch } from "./prwatch.js";
import { dueSlot, type Schedule } from "./schedule.js";
import { appendLog, readList, readMap, writeList, writeMap } from "./store.js";

export interface Launched {
  pid?: number;
  exited: Promise<number>;
}

export interface ServeDeps {
  /** start `mola <args>` in cwd */
  mola(args: string[], cwd: string): Launched;
  /** run gh, wait for it */
  gh(args: string[], cwd: string): { ok: boolean; out: string; err: string };
  now(): number;
  log(line: string): void;
  env?: NodeJS.ProcessEnv;
}

export function realDeps(entry: string | undefined = process.argv[1]): ServeDeps {
  return {
    mola(args, cwd) {
      if (!entry) throw new Error("cannot find the mola entry point");
      const child = spawn(process.execPath, [entry, ...args], { cwd, stdio: "ignore", windowsHide: true });
      const exited = new Promise<number>((resolve) => {
        child.once("exit", (code) => resolve(code ?? 1));
        child.once("error", () => resolve(1));
      });
      return { ...(child.pid ? { pid: child.pid } : {}), exited };
    },
    gh(args, cwd) {
      const r = spawnSync("gh", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
      return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() };
    },
    now: () => Date.now(),
    log: (line) => process.stderr.write(`mola serve: ${line}\n`),
  };
}

export interface ServeOptions {
  maxRuns?: number;
  /** extra directories whose go runs may carry resumeAt */
  cwds?: string[];
}

export class Server {
  private running = 0;
  private selfLogin: string | undefined | null = null;
  private readonly maxRuns: number;
  constructor(
    private readonly deps: ServeDeps,
    private readonly opts: ServeOptions = {},
  ) {
    this.maxRuns = opts.maxRuns ?? 3;
  }

  get inFlight(): number {
    return this.running;
  }

  private launch(args: string[], cwd: string, what: string): boolean {
    if (this.running >= this.maxRuns) {
      this.deps.log(`${what}: ${this.running} trigger runs already going; waits for the next tick`);
      return false;
    }
    try {
      const h = this.deps.mola(args, cwd);
      this.running++;
      void h.exited.finally(() => this.running--);
      this.deps.log(`${what}: started${h.pid ? ` (pid ${h.pid})` : ""}`);
      return true;
    } catch (err) {
      this.deps.log(`${what}: could not start: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async runAndWait(args: string[], cwd: string): Promise<number> {
    try {
      return await this.deps.mola(args, cwd).exited;
    } catch {
      return 1;
    }
  }

  /** One pass over everything that may be due. */
  async tick(): Promise<{ schedules: number; resumed: number; windows: number; watches: number }> {
    const env = this.deps.env;
    const now = this.deps.now();
    const out = { schedules: 0, resumed: 0, windows: 0, watches: 0 };

    // 1. schedules
    const schedules = readList<Schedule>("schedules.json", env);
    let changed = false;
    for (const s of schedules) {
      const slot = dueSlot(s, now);
      if (!slot) continue;
      const args = ["go", s.prompt, "--key", `sched:${s.id}:${slot}`, "--origin", "trigger", ...(s.auto ? ["--auto"] : []), ...(s.until ? ["--until", s.until] : [])];
      if (!this.launch(args, s.cwd, `schedule ${s.id} ${slot}`)) continue;
      s.lastSlot = slot;
      s.lastRunAt = new Date(now).toISOString();
      if ("once" in s.when) s.enabled = false;
      changed = true;
      out.schedules++;
    }
    if (changed) writeList("schedules.json", schedules, env);

    // 2. runs to resume later
    for (const cwd of this.cwds()) {
      for (const p of listProgress(cwd)) {
        if (!p.resumeAt || Date.parse(p.resumeAt) > now) continue;
        if (p.status === "running" || p.status === "done") continue;
        delete p.resumeAt;
        writeProgress(p);
        if (this.launch(["go", "--resume", p.id], cwd, `resume ${p.id}`)) out.resumed++;
      }
    }

    // 3. webhook windows
    const hooks = readList<Hook>("hooks.json", env);
    const state = this.hookState();
    for (const w of closeWindows(hooks, state, now)) {
      this.launch(["go", w.prompt, "--key", w.runKey, "--origin", "trigger", ...(w.hook.auto ? ["--auto"] : [])], w.hook.cwd, `hook ${w.hook.id} (${w.count} coalesced)`);
      appendLog("deliveries.jsonl", { hookId: w.hook.id, at: new Date(now).toISOString(), outcome: "started", runKey: w.runKey, reason: `window closed, ${w.count} deliveries` } satisfies Delivery, env);
      out.windows++;
    }
    this.saveHookState(state);

    // 4. PR watches
    const watches = readList<PrWatch>("watches.json", env);
    let wchanged = false;
    for (const w of watches) {
      if (w.ended) continue;
      if (w.lastReadAt && now - Date.parse(w.lastReadAt) < w.everySec * 1000) continue;
      await this.pollWatch(w, now);
      wchanged = true;
      out.watches++;
    }
    if (wchanged) writeList("watches.json", watches, env);
    return out;
  }

  private cwds(): string[] {
    const env = this.deps.env;
    const set = new Set<string>((this.opts.cwds ?? []).map((c) => path.resolve(c)));
    for (const s of readList<Schedule>("schedules.json", env)) set.add(s.cwd);
    for (const h of readList<Hook>("hooks.json", env)) set.add(h.cwd);
    for (const w of readList<PrWatch>("watches.json", env)) set.add(w.cwd);
    return [...set];
  }

  private self(cwd: string): string | undefined {
    if (this.selfLogin !== null) return this.selfLogin;
    const r = this.deps.gh(["api", "user", "--jq", ".login"], cwd);
    this.selfLogin = r.ok && r.out ? r.out : undefined;
    return this.selfLogin;
  }

  async pollWatch(w: PrWatch, now: number): Promise<void> {
    w.lastReadAt = new Date(now).toISOString();
    const r = this.deps.gh(["pr", "view", String(w.pr), ...(w.repo ? ["--repo", w.repo] : []), "--json", PR_FIELDS], w.cwd);
    if (!r.ok) {
      w.readFailures++;
      this.deps.log(`watch ${w.id}: read failed (${w.readFailures}/${MAX_READ_FAILURES}): ${r.err.slice(0, 200)}`);
      if (/rate limit/i.test(r.err)) w.readFailures--; // a rate limit only pauses the watch
      if (w.readFailures >= MAX_READ_FAILURES) {
        w.ended = `${MAX_READ_FAILURES} failed reads in a row`;
        await this.notify(w, `watch on PR #${w.pr} ended: ${w.ended}`);
      }
      return;
    }
    w.readFailures = 0;
    let pr: unknown;
    try {
      pr = JSON.parse(r.out);
    } catch {
      return;
    }
    const { next, wake } = compare(w.snapshot, pr as never, this.self(w.cwd));
    w.snapshot = next;
    const end = account(w, wake);
    if (wake) {
      const text = wakeText(w, wake);
      await this.notify(w, text);
      if (w.run) {
        await this.runAndWait(["go", "say", w.run, text], w.cwd);
        const run = listProgress(w.cwd).find((p) => p.id === w.run);
        if (run && run.status !== "running" && run.status !== "done" && !end) this.launch(["go", "--resume", w.run], w.cwd, `watch ${w.id} → resume ${w.run}`);
      } else if (w.prompt && !end) {
        this.launch(["go", `${w.prompt}\n\n${wrapUntrusted(`pr #${w.pr} events`, text)}`, "--key", `watch:${w.id}:${w.wakes}`, "--origin", "trigger", ...(w.auto ? ["--auto"] : [])], w.cwd, `watch ${w.id} wake ${w.wakes}`);
      }
    }
    if (end) {
      w.ended = end;
      if (!wake?.end) await this.notify(w, `watch on PR #${w.pr} ended: ${end}`);
    }
  }

  private async notify(w: PrWatch, text: string): Promise<void> {
    await this.runAndWait(["notify", text, "--title", `mola watch · PR #${w.pr}`], w.cwd);
  }

  hookState(): HookState {
    const env = this.deps.env;
    return {
      seen: readMap<number>("seen.json", env),
      pending: readMap<HookState["pending"][string]>("pending.json", env),
      recent: {},
    };
  }

  private recent: Record<string, number[]> = {};

  saveHookState(s: HookState): void {
    writeMap("seen.json", s.seen, this.deps.env);
    writeMap("pending.json", s.pending, this.deps.env);
  }

  /** One webhook delivery. Returns the HTTP status and a short JSON body. */
  deliver(hookId: string, secret: string, req: HookRequest): { status: number; body: Record<string, unknown> } {
    const env = this.deps.env;
    const hooks = readList<Hook>("hooks.json", env);
    const hook = hooks.find((h) => h.id === hookId);
    // the same answer for an unknown hook and a wrong secret
    if (!hook || !secretMatches(hook, secret)) return { status: 404, body: { error: "not found" } };
    const state = this.hookState();
    state.recent = this.recent;
    const d = decide(hook, req, state, this.deps.now());
    this.recent = state.recent;
    this.saveHookState(state);
    if (d.action === "start") {
      const ok = this.launch(["go", d.prompt, "--key", d.runKey, "--origin", "trigger", ...(hook.auto ? ["--auto"] : [])], hook.cwd, `hook ${hook.id}`);
      const delivery = ok ? d.delivery : { ...d.delivery, outcome: "rejected" as const, reason: "too many trigger runs going" };
      appendLog("deliveries.jsonl", delivery, env);
      return ok ? { status: 202, body: { started: true, key: d.runKey } } : { status: 503, body: { error: "busy, send again later" } };
    }
    appendLog("deliveries.jsonl", d.delivery, env);
    if (d.action === "hold") return { status: 202, body: { coalesced: true } };
    return { status: d.status, body: { outcome: d.delivery.outcome, ...(d.delivery.reason ? { reason: d.delivery.reason } : {}) } };
  }

  listen(port: number, host: string): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url ?? "/", "http://localhost");
      const segs = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true, inFlight: this.running });
      if (req.method !== "POST" || segs[0] !== "hooks" || segs.length !== 3) return send(404, { error: "not found" });
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) tooBig = true;
        else chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return send(413, { error: "body over 1 MiB" });
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        const query: Record<string, string> = {};
        for (const [k, v] of url.searchParams) query[k] = v;
        try {
          const r = this.deliver(segs[1], segs[2], { headers, query, rawBody: Buffer.concat(chunks).toString("utf8") });
          send(r.status, r.body);
        } catch (err) {
          send(500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }
}

export function portOf(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}
