/**
 * cmd-web (mstack 1.0, FRAMEWORK.md §13.2): `mola web [--port 7333] [--host 127.0.0.1]
 * [--token <t>] [--cwd <dir> ...]` — a zero-dependency node:http server that shows
 * live `mola go` runs (progress.json via the plugin-sdk contract) over SSE and lets
 * the user approve / deny blocked steps or stop a run from a phone.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginContext } from "@mola/plugin-sdk";
import {
  decideApproval,
  definePlugin,
  ExitCode,
  listProgress,
  MolaError,
  readApproval,
  readProgress,
  runDir,
  type Approval,
  type RunProgress,
} from "@mola/plugin-sdk";
import { PAGE_HTML } from "./page.js";

const USAGE = "usage: mola web [--port 7333] [--host 127.0.0.1] [--token <t>] [--cwd <dir> ...]";
const ID_RE = /^[\w.-]+$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const TAIL_LINES = 40;
const MAX_BODY = 64 * 1024;

export interface WebOptions {
  host?: string;
  port?: number;
  token?: string;
  cwds?: string[];
  /** SSE poll interval, default 1000 */
  pollMs?: number;
  /** SSE heartbeat interval, default 15000 */
  heartbeatMs?: number;
}

export interface WebServer {
  server: http.Server;
  host: string;
  port: number;
  token?: string;
  url: string;
  close(): Promise<void>;
}

export type TaggedRun = RunProgress & { cwd: string; approval?: Approval };

export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

/** Constant-time string compare (hash first so lengths do not leak). */
export function tokenEquals(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function tag(cwd: string, p: RunProgress): TaggedRun {
  const out: TaggedRun = { ...p, cwd };
  if (p.status === "blocked" && p.blocked?.approvalId) {
    const a = readApproval(cwd, p.id, p.blocked.approvalId);
    if (a) out.approval = a;
  }
  return out;
}

function allRuns(cwds: string[]): TaggedRun[] {
  return cwds.flatMap((c) => listProgress(c).map((p) => tag(c, p))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function findRun(cwds: string[], id: string, want?: string | null): { cwd: string; progress: RunProgress } | undefined {
  for (const cwd of cwds) {
    if (want && path.resolve(want) !== cwd) continue;
    const progress = readProgress(cwd, id);
    if (progress) return { cwd, progress };
  }
  return undefined;
}

function tail(file: string, n = TAIL_LINES): string[] | undefined {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return undefined;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startWeb(opts: WebOptions = {}): Promise<WebServer> {
  const host = opts.host ?? "127.0.0.1";
  let token = opts.token || undefined;
  if (!isLoopback(host) && !token) {
    throw new MolaError("USAGE_ERROR", `binding to ${host} requires --token`, ExitCode.Usage);
  }
  const cwds = [...new Set([...(opts.cwds ?? []), process.cwd()].map((c) => path.resolve(c)))];
  const pollMs = opts.pollMs ?? 1000;
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const clients = new Set<() => void>();

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const given = bearer ?? url.searchParams.get("token") ?? "";
    return tokenEquals(given, token);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const segs = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(PAGE_HTML);
      return;
    }
    if (segs[0] !== "api") return send(res, 404, { error: "not found" });
    if (!authorized(req, url)) return send(res, 401, { error: "unauthorized" });

    if (method === "GET" && segs.length === 2 && segs[1] === "runs") return send(res, 200, allRuns(cwds));

    if (method === "GET" && segs.length === 2 && segs[1] === "stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 2000\n\n");
      const seen = new Map<string, string>();
      const tick = (): void => {
        for (const r of allRuns(cwds)) {
          const key = `${r.cwd}|${r.id}`;
          const sig = `${r.updatedAt}|${r.approval?.status ?? ""}`;
          if (seen.get(key) === sig) continue;
          seen.set(key, sig);
          res.write(`event: run\ndata: ${JSON.stringify(r)}\n\n`);
        }
      };
      tick();
      const poll = setInterval(tick, pollMs);
      const beat = setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs);
      const done = (): void => {
        clearInterval(poll);
        clearInterval(beat);
        clients.delete(close);
      };
      const close = (): void => {
        done();
        res.end();
      };
      clients.add(close);
      req.on("close", done);
      return;
    }

    if (segs[1] !== "runs" || segs.length < 3) return send(res, 404, { error: "not found" });
    const id = segs[2];
    if (!ID_RE.test(id)) return send(res, 400, { error: "bad run id" });

    if (method === "GET" && segs.length === 3) {
      const hit = findRun(cwds, id, url.searchParams.get("cwd"));
      if (!hit) return send(res, 404, { error: "run not found" });
      const dir = runDir(hit.cwd, id);
      const artifacts: Record<string, string[]> = {};
      for (const s of hit.progress.stages) {
        if (!s.artifact) continue;
        const file = path.resolve(dir, s.artifact);
        if (!file.startsWith(dir + path.sep)) continue;
        const t = tail(file);
        if (t) artifacts[s.artifact] = t;
      }
      const events = tail(path.join(dir, "events.jsonl"));
      return send(res, 200, { progress: tag(hit.cwd, hit.progress), artifacts, ...(events ? { events } : {}) });
    }

    if (method === "POST") {
      const ctype = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (ctype !== "application/json") return send(res, 415, { error: "content-type must be application/json" });
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        return send(res, 400, { error: "invalid JSON body" });
      }
      const hit = findRun(cwds, id, url.searchParams.get("cwd"));
      if (!hit) return send(res, 404, { error: "run not found" });

      if (segs.length === 4 && segs[3] === "stop") {
        const dir = runDir(hit.cwd, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "STOP"), new Date().toISOString() + "\n", "utf8");
        return send(res, 200, { ok: true, stop: true });
      }
      if (segs.length === 5 && segs[3] === "approvals") {
        const approvalId = segs[4];
        if (!ID_RE.test(approvalId)) return send(res, 400, { error: "bad approval id" });
        const decision = (body as { decision?: unknown } | null)?.decision;
        if (decision !== "approve" && decision !== "deny") {
          return send(res, 400, { error: 'decision must be "approve" or "deny"' });
        }
        const ok = decideApproval(hit.cwd, id, approvalId, decision === "approve", "web");
        if (!ok) return send(res, 409, { error: "approval missing or already decided" });
        return send(res, 200, { ok: true, status: decision === "approve" ? "approved" : "denied" });
      }
    }
    return send(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7333, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as net.AddressInfo;
  const shown = host.includes(":") ? `[${host}]` : host;
  const url = `http://${shown}:${addr.port}/${token ? `?token=${token}` : ""}`;
  return {
    server,
    host,
    port: addr.port,
    ...(token ? { token } : {}),
    url,
    async close() {
      for (const c of [...clients]) c();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** `--cwd` may repeat; parseArgs keeps only the last, so also scan the raw argv. */
function cwdFlags(flag: string | boolean | undefined, argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--cwd" && argv[i + 1] && !argv[i + 1].startsWith("-")) out.push(argv[++i]);
    else if (t.startsWith("--cwd=")) out.push(t.slice(6));
  }
  if (typeof flag === "string" && !out.includes(flag)) out.push(flag);
  return out;
}

function tailscaleHint(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) return a.address;
    }
  }
  return undefined;
}

export default definePlugin({
  activate(ctx: PluginContext) {
    ctx.commands.register({
      path: ["web"],
      description: "live runs in a browser (phone-friendly): workers, cost, approve/deny",
      async handler(args, io) {
        if (args.positionals.length > 0) throw new MolaError("USAGE_ERROR", USAGE, ExitCode.Usage);
        const port = args.flags.port === undefined ? 7333 : Number(args.flags.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new MolaError("USAGE_ERROR", `${USAGE} — bad --port`, ExitCode.Usage);
        }
        const host = typeof args.flags.host === "string" ? args.flags.host : "127.0.0.1";
        let token = typeof args.flags.token === "string" ? args.flags.token : undefined;
        if (!isLoopback(host) && !token) {
          token = crypto.randomBytes(24).toString("base64url");
        }
        const configured = ctx.config.get<unknown>("web.cwds", []);
        const cfgCwds = Array.isArray(configured) ? configured.filter((c): c is string => typeof c === "string") : [];
        const cwds = [...cwdFlags(args.flags.cwd, process.argv), ...cfgCwds].map((c) => path.resolve(io.cwd, c));
        const web = await startWeb({ host, port, ...(token ? { token } : {}), cwds: [io.cwd, ...cwds] });
        io.out(`mola web listening on ${web.url}`);
        if (!isLoopback(host)) {
          const ts = tailscaleHint();
          io.out(`Tailscale: open http://${ts ?? "<your 100.x address>"}:${web.port}/${token ? `?token=${token}` : ""} on your phone`);
        }
        io.data({ url: web.url, host, port: web.port });
        await new Promise<void>((resolve) => {
          const stop = (): void => resolve();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        await web.close();
        return ExitCode.Ok;
      },
    });
  },
});
