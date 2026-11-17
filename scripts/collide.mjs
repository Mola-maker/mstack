#!/usr/bin/env node
// Which skills of another plugin are likely to fire on the same phrases as ours?
//   node scripts/collide.mjs <other plugin's skills dir> [--mine skills] [--min 0.2] [--top 20] [--json]
// A static heuristic over the frontmatter text a model routes on (description + when_to_use): tf-idf cosine similarity
// per pair, with the shared terms that carry it. It finds pairs worth a look; it does not prove that one phrase fires
// both skills. That needs a session with both plugins installed (the routing evals, run on purpose).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STOP = new Set("the and for with when use used using this that from into your you are not any all can will its but has have only than then them they their what which who how why where also each per via one two out off over under about after before more most other such like just without within across both either not never always must should may might upon unless until while use skill skills user users task tasks work works working run runs running make makes need needs want wants get gets give gives new old".split(" "));

/** description + when_to_use of a SKILL.md; "" when it has no frontmatter. */
export function routingText(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return "";
  const pick = (key) => {
    const row = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]);
    return row ? row[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return `${pick("description")} ${pick("when_to_use") || pick("whenToUse")}`.trim();
}

/** Terms: lower-case ascii words of 3+ letters minus stop words, plus adjacent CJK character pairs. */
export function terms(text) {
  const out = [];
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) if (!STOP.has(w)) out.push(w);
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}

export function loadSkills(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md")))
    .map((d) => ({ name: d.name, text: routingText(readFileSync(join(dir, d.name, "SKILL.md"), "utf8")) }))
    .filter((s) => s.text);
}

/** Pairs (ours × theirs) by tf-idf cosine over both sets, best first. */
export function collisions(mine, theirs, { min = 0.2 } = {}) {
  const docs = [...mine.map((s) => ({ ...s, side: "mine" })), ...theirs.map((s) => ({ ...s, side: "theirs" }))].map((s) => ({ ...s, tf: count(terms(s.text)) }));
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t) => Math.log(1 + docs.length / df.get(t));
  const vec = (d) => new Map([...d.tf].map(([t, n]) => [t, (1 + Math.log(n)) * idf(t)]));
  const norm = (v) => Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0));
  for (const d of docs) { d.v = vec(d); d.n = norm(d.v); }
  const out = [];
  for (const a of docs.filter((d) => d.side === "mine"))
    for (const b of docs.filter((d) => d.side === "theirs")) {
      let dot = 0;
      const shared = [];
      for (const [t, x] of a.v) if (b.v.has(t)) { dot += x * b.v.get(t); shared.push([t, x * b.v.get(t)]); }
      const score = a.n && b.n ? dot / (a.n * b.n) : 0;
      if (score >= min) out.push({ mine: a.name, theirs: b.name, score: Math.round(score * 1000) / 1000, shared: shared.sort((p, q) => q[1] - p[1]).slice(0, 6).map(([t]) => t) });
    }
  return out.sort((p, q) => q.score - p.score);
}

const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());

function main(argv) {
  const pos = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  if (!pos[0]) { console.error("usage: collide.mjs <other plugin's skills dir> [--mine skills] [--min 0.2] [--top 20] [--json]"); return 2; }
  const root = resolve(fileURLToPath(import.meta.url), "..", "..");
  const mine = loadSkills(resolve(root, opt("mine", "skills")));
  const theirs = loadSkills(resolve(pos[0]));
  if (!theirs.length) { console.error(`no SKILL.md with a description under ${pos[0]}`); return 2; }
  const rows = collisions(mine, theirs, { min: Number(opt("min", "0.2")) }).slice(0, Number(opt("top", "20")));
  if (argv.includes("--json")) console.log(JSON.stringify({ mine: mine.length, theirs: theirs.length, pairs: rows }, null, 2));
  else {
    console.log(`${mine.length} of ours x ${theirs.length} of theirs; ${rows.length} pair(s) at or above ${opt("min", "0.2")} (static text similarity, not a routing test)`);
    for (const r of rows) console.log(`${r.score.toFixed(2)}  ${r.mine}  <->  ${r.theirs}   [${r.shared.join(", ")}]`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
