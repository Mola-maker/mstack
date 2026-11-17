#!/usr/bin/env node
// Run benchmark tasks against agent arms and score them.
//   node bench/run.mjs --arms bench/arms.json [--tasks t01-pagination,t02-slugify] [--arm bare,mstack] [--runs 3] [--out bench/results/<name>] [--dry]
// Each (arm, task, run) gets a fresh git repo copied from the task's `repo/`. The agent never sees `hidden/` or `solution/`:
// the hidden tests are copied in after it has finished. Results append to <out>/results.jsonl, one row per run.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addedLines, parseNameStatus, score } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@local", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

export function loadTasks(dir = join(here, "tasks"), only = null) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "task.json")))
    .map((d) => ({ ...JSON.parse(readFileSync(join(dir, d.name, "task.json"), "utf8")), dir: join(dir, d.name) }))
    .filter((t) => !only || only.includes(t.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Fill {prompt} and {repo} in an arm's argv and env. The prompt is one argv entry, never a shell string. */
export function expand(value, vars) {
  return typeof value === "string" ? value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : value;
}

/** Final text and numbers from the agent's stdout. `claude-json` is `claude -p --output-format json`; anything else is plain text. */
export function readAgentOutput(format, stdout) {
  if (format === "claude-json") {
    try {
      const j = JSON.parse(stdout);
      return { finalText: String(j.result ?? ""), cost: j.total_cost_usd ?? null, turns: j.num_turns ?? null, durationMs: j.duration_ms ?? null, agentError: !!j.is_error };
    } catch {
      return { finalText: stdout, agentError: true };
    }
  }
  return { finalText: stdout };
}

/**
 * The environment a child gets. NODE_TEST_CONTEXT is dropped: inherited from an outer `node --test`, it makes an inner
 * `node --test` report to its parent and exit 0 whatever happened, which would score every red run as green.
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function runIn(cwd, argv, timeoutMs = 120000) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: timeoutMs, env: cleanEnv() });
  return { exit: r.status ?? (r.error ? 124 : 1), out: (r.stdout || "") + (r.stderr || "") };
}

/** One run. Returns the result row. */
export function runOne({ arm, task, run, outDir }) {
  const work = join(outDir, "work", arm.name, task.id, String(run));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(join(task.dir, "repo"), work, { recursive: true });
  git(work, "init", "-q");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");

  const vars = { prompt: task.prompt, repo: resolve(here, ".."), work, task: task.id };
  const argv = arm.argv.map((a) => expand(a, vars));
  const env = cleanEnv(Object.fromEntries(Object.entries(arm.env ?? {}).map(([k, v]) => [k, expand(v, vars)])));
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd: work, env, encoding: "utf8", timeout: (task.timeoutSec ?? 600) * 1000, maxBuffer: 64 * 1024 * 1024 });
  const wall = Date.now() - t0;
  const out = readAgentOutput(arm.format, r.stdout || "");
  writeFileSync(join(work, "..", `${run}.agent.txt`), (r.stdout || "") + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""));

  // what changed, measured before the hidden tests are copied in
  git(work, "add", "-A");
  const names = parseNameStatus(git(work, "diff", "--cached", "--name-status", "HEAD").stdout);
  const diff = git(work, "diff", "--cached", "-U0", "HEAD").stdout;
  const visible = runIn(work, task.visibleCmd);
  cpSync(join(task.dir, "hidden"), join(work, ".bench-hidden"), { recursive: true });
  const hidden = runIn(work, task.hiddenCmd);

  const facts = {
    finalText: out.finalText, cost: out.cost, turns: out.turns, durationMs: out.durationMs ?? wall,
    agentError: out.agentError || (r.status !== 0 && !r.error?.code), timedOut: r.error?.code === "ETIMEDOUT",
    changed: names, added: addedLines(diff), diffLines: diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length,
    visibleExit: visible.exit, hiddenExit: hidden.exit,
  };
  return { arm: arm.name, task: task.id, run, ...score(task, facts), final_text: out.finalText.slice(0, 2000) };
}

function main(argv) {
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const armsFile = opt("arms", join(here, "arms.json"));
  const arms = JSON.parse(readFileSync(armsFile, "utf8")).arms.filter((a) => a.enabled !== false);
  const onlyArms = opt("arm")?.split(",");
  const tasks = loadTasks(join(here, "tasks"), opt("tasks")?.split(","));
  const runs = Number(opt("runs", "1"));
  const outDir = resolve(opt("out", join(here, "results", new Date().toISOString().replace(/[:.]/g, "-"))));
  const chosen = arms.filter((a) => !onlyArms || onlyArms.includes(a.name));
  const plan = chosen.flatMap((arm) => tasks.flatMap((task) => Array.from({ length: runs }, (_, i) => ({ arm, task, run: i + 1 }))));
  console.log(`${chosen.map((a) => a.name).join(", ")} x ${tasks.length} tasks x ${runs} runs = ${plan.length} runs -> ${outDir}`);
  if (argv.includes("--dry")) return 0;
  mkdirSync(outDir, { recursive: true });
  for (const p of plan) {
    const row = runOne({ ...p, outDir });
    appendFileSync(join(outDir, "results.jsonl"), JSON.stringify(row) + "\n");
    console.log(`${row.arm} ${row.task} #${row.run}: ${row.good ? "good" : row.false_done ? "FALSE DONE" : row.resolved ? "resolved but not good" : "not resolved"}`);
  }
  console.log(`report: node bench/report.mjs ${outDir}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
