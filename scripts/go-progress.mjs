#!/usr/bin/env node
// Progress writer for the Claude Code /go command. Same file contract as
// cli/packages/plugin-sdk/src/progress.ts, so `mola statusline`, `mola dash`
// and `mola web` show /go runs too. Zero dependencies; never throws.
//
//   start "<intent>" [--stages plan,implement,verify,review]  → prints run id
//   stage <id> <stage> <pending|running|done|failed|skipped|blocked> [--model m] [--agent a] [--summary s] [--cost usd] [--artifact f]
//   worker <id> <workerId> <stage> <working|blocked|idle|done|failed> [--model m] [--line text]
//   block <id> "<reason>" "<action>"   → prints approval id (status blocked)
//   check <id> <approvalId>            → prints pending|approved|denied
//   decide <id> <approvalId> approve|deny
//   next <id> "<text>"
//   done <id> [done|failed|stopped]
//   show <id>
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

const STAGES = ["think", "scout", "plan", "implement", "verify", "review", "ship"];
const cwd = process.env.MOLA_GO_CWD || process.cwd();
const runDir = (id) => join(cwd, ".mstack", "runs", id);
const progFile = (id) => join(runDir(id), "progress.json");
const apFile = (id, ap) => join(runDir(id), "approvals", `${ap}.json`);
const now = () => new Date().toISOString();

function writeJson(file, v) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

function opts(args) {
  const o = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) o[args[i].slice(2)] = args[++i] ?? "";
    else rest.push(args[i]);
  }
  return [o, rest];
}

function load(id) {
  if (!id || !/^[\w.-]+$/.test(id) || !existsSync(progFile(id))) throw new Error(`no run ${id}`);
  return readJson(progFile(id));
}
function save(p) {
  p.updatedAt = now();
  p.costUsd = Math.round(p.stages.reduce((s, x) => s + (x.costUsd ?? 0), 0) * 10000) / 10000;
  writeJson(progFile(p.id), p);
}

const [cmd, ...argv] = process.argv.slice(2);
const [o, a] = opts(argv);
try {
  switch (cmd) {
    case "start": {
      const d = new Date(), pad = (n) => String(n).padStart(2, "0");
      const id = `go-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${randomBytes(2).toString("hex")}`;
      const chosen = (o.stages || "scout,plan,implement,verify,review").split(",").map((s) => s.trim());
      const stages = STAGES.map((name) => ({ name, status: chosen.includes(name) ? "pending" : "skipped" }));
      const first = stages.find((s) => s.status === "pending")?.name ?? "plan";
      mkdirSync(runDir(id), { recursive: true });
      writeFileSync(join(runDir(id), "intent.md"), (a[0] ?? "") + "\n", "utf8");
      save({ schemaVersion: 1, id, intent: a[0] ?? "", cwd, status: "running", startedAt: now(), updatedAt: now(), stage: first, stages, workers: [], costUsd: 0, origin: "claude-code" });
      console.log(id);
      break;
    }
    case "stage": {
      const [id, name, status] = a;
      if (!STAGES.includes(name)) throw new Error(`unknown stage ${name}`);
      const p = load(id), s = p.stages.find((x) => x.name === name);
      s.status = status;
      if (status === "running") { s.startedAt ??= now(); p.stage = name; p.status = "running"; delete p.blocked; }
      if (["done", "failed", "skipped"].includes(status)) s.endedAt = now();
      for (const k of ["model", "agent", "summary", "artifact"]) if (o[k] !== undefined) s[k] = o[k];
      if (o.cost !== undefined) s.costUsd = (s.costUsd ?? 0) + Number(o.cost || 0);
      save(p);
      break;
    }
    case "worker": {
      const [id, wid, stage, status] = a;
      const p = load(id);
      let w = p.workers.find((x) => x.id === wid);
      if (!w) p.workers.push((w = { id: wid, stage, status, startedAt: now() }));
      Object.assign(w, { stage, status, updatedAt: now() });
      if (o.model !== undefined) w.model = o.model;
      if (o.line !== undefined) w.lastLine = o.line.slice(0, 200);
      save(p);
      break;
    }
    case "block": {
      const [id, reason, action] = a;
      const p = load(id), ap = `ap-${randomBytes(3).toString("hex")}`;
      writeJson(apFile(id, ap), { id: ap, runId: id, stage: p.stage, action: action ?? reason, status: "pending", createdAt: now() });
      p.status = "blocked";
      p.blocked = { reason, approvalId: ap };
      p.next = `approve: mola go approve ${id}  (or the web page)`;
      save(p);
      console.log(ap);
      break;
    }
    case "check": {
      const [id, ap] = a;
      console.log(existsSync(apFile(id, ap)) ? readJson(apFile(id, ap)).status : "missing");
      break;
    }
    case "decide": {
      const [id, ap, d] = a;
      const f = apFile(id, ap), v = readJson(f);
      if (v.status !== "pending") throw new Error(`approval ${ap} already ${v.status}`);
      Object.assign(v, { status: d === "approve" ? "approved" : "denied", decidedAt: now(), decidedBy: "claude-code" });
      writeJson(f, v);
      const p = load(id);
      if (p.status === "blocked") { p.status = d === "approve" ? "running" : "stopped"; delete p.blocked; save(p); }
      break;
    }
    case "next": { const p = load(a[0]); p.next = a[1]; save(p); break; }
    case "done": {
      const p = load(a[0]);
      p.status = a[1] || "done";
      delete p.blocked;
      for (const w of p.workers) if (w.status === "working") w.status = p.status === "done" ? "done" : "failed";
      save(p);
      break;
    }
    case "show": console.log(JSON.stringify(load(a[0]), null, 2)); break;
    default:
      console.error("usage: go-progress.mjs start|stage|worker|block|check|decide|next|done|show …");
      process.exit(64);
  }
} catch (e) {
  console.error(`go-progress: ${e.message}`);
  process.exit(1);
}
