#!/usr/bin/env node
// node bench/report.mjs <results dir | results.jsonl> [more ...]   -> markdown table per arm, plus per-task detail
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { aggregate, markdown, winner } from "./lib.mjs";

const files = process.argv.slice(2).map((p) => (statSync(p).isDirectory() ? join(p, "results.jsonl") : p)).filter(existsSync);
if (!files.length) { console.error("usage: report.mjs <results dir | results.jsonl> ..."); process.exit(2); }
const rows = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const table = aggregate(rows);
console.log(markdown(table));
if (table.length > 1) {
  console.log("\nPairs (non-overlapping 95% intervals on `good`, else \"no difference shown\"):");
  for (let i = 0; i < table.length; i++) for (let j = i + 1; j < table.length; j++) console.log(`- ${table[i].arm} vs ${table[j].arm}: ${winner(table[i], table[j])}`);
}
const tasks = [...new Set(rows.map((r) => r.task))].sort();
console.log("\nPer task (good / runs):");
for (const t of tasks) console.log(`- ${t}: ` + aggregate(rows.filter((r) => r.task === t)).map((a) => `${a.arm} ${a.good.k}/${a.n}`).join(", "));
const fd = rows.filter((r) => r.false_done);
if (fd.length) console.log(`\nFalse "done" claims (${fd.length}):\n` + fd.map((r) => `- ${r.arm} ${r.task} #${r.run}: ${r.tamper_reasons?.[0] ?? (r.resolved ? "dishonest report" : "hidden tests red")}`).join("\n"));
