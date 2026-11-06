// Acceptance checks from FRAMEWORK.md §8. Usage: node scripts/check.mjs
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const expected = ["m-start", "m-team", "m-think", "m-plan", "m-goal", "m-dispatch", "m-verify", "m-debug", "m-handoff",
  "m-review", "m-ship", "m-qa", "m-research", "m-learn", "m-deslop", "m-guard"];
const sections = ["## When to use", "## Procedure", "## Output", "## Stop conditions", "## Harness notes"];
const errors = [];
const err = (m) => errors.push(m);

const walk = (d) => readdirSync(d).filter((f) => !f.startsWith(".")).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

for (const name of expected) {
  const p = join(root, "skills", name, "SKILL.md");
  if (!existsSync(p)) { err(`${name}: SKILL.md missing`); continue; }
  const text = readFileSync(p, "utf8");
  const lines = text.split("\n").length;
  if (lines > 150) err(`${name}: ${lines} lines (>150)`);
  // Claude Code truncates long skills; keep well under its 20k-character limit
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > 12000) err(`${name}: ${bytes} bytes (>12000)`);
  // only SKILL.md, references/ and scripts/ belong in a skill dir (no dev or test scenario files)
  for (const entry of readdirSync(join(root, "skills", name))) {
    if (!["SKILL.md", "references", "scripts"].includes(entry) && !entry.startsWith(".")) err(`${name}: unexpected entry skills/${name}/${entry}`);
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) { err(`${name}: no frontmatter`); continue; }
  for (const k of ["name", "description", "whenToUse"]) if (!new RegExp(`^${k}:\\s*\\S`, "m").test(fm[1])) err(`${name}: frontmatter missing ${k}`);
  // An unquoted value containing ": " or " #" is invalid YAML; Claude Code then drops the skill silently.
  for (const line of fm[1].split(/\r?\n/)) {
    const v = line.replace(/^[\w-]+:\s*/, "");
    if (!/^["']/.test(v) && /: | #/.test(v)) err(`${name}: unquoted YAML value with ": " or " #": ${line.slice(0, 40)}`);
  }
  const desc = fm[1].match(/^description:\s*(.*)$/m)?.[1] ?? "";
  if (desc.length > 1024) err(`${name}: description ${desc.length} chars (>1024, the Agent Skills limit)`);
  const n = fm[1].match(/^name:\s*["']?([\w-]+)/m)?.[1];
  if (n !== name) err(`${name}: frontmatter name is ${n}`);
  if (!/^# /m.test(text)) err(`${name}: no # title`);
  let last = -1;
  for (const s of sections) {
    const i = text.indexOf(s);
    if (i < 0) err(`${name}: missing section "${s}"`);
    else if (i < last) err(`${name}: section "${s}" out of order`);
    else last = i;
  }
}

// evals/<case>/case.yaml (claude plugin eval): required keys present, and every skill named in a should-fire grader exists
if (existsSync(join(root, "evals"))) {
  for (const c of readdirSync(join(root, "evals")).filter((d) => !d.startsWith(".") && d !== "results" && statSync(join(root, "evals", d)).isDirectory())) {
    const f = join(root, "evals", c, "case.yaml");
    if (!existsSync(f)) { err(`evals/${c}: case.yaml missing`); continue; }
    const y = readFileSync(f, "utf8");
    for (const k of ['schema_version: "1.1"', "name:", "execution:", "prompt:", "graders:"]) if (!y.includes(k)) err(`evals/${c}: missing ${k}`);
    for (const m of y.matchAll(/name: fires-(m-[\w-]+|mstack)/g)) if (!expected.includes(m[1])) err(`evals/${c}: grader names unknown skill ${m[1]}`);
  }
}

const extra = readdirSync(join(root, "skills")).filter((d) => !d.startsWith(".") && !expected.includes(d));
if (extra.length) err(`unexpected skill dirs: ${extra.join(", ")}`);

for (const f of walk(join(root, "skills"))) {
  const t = readFileSync(f, "utf8");
  for (const bad of ["superpowers:", "oh-my-claudecode:", "omc:"]) if (t.includes(bad)) err(`${f}: references "${bad}"`);
  // scripts ship inside the skill: a repo-relative path does not exist once mstack is installed as a plugin
  if (t.includes("node skills/m-") && f.endsWith(".md")) err(`${f}: repo-relative script path "node skills/m-…" (use the skill dir)`);
}

for (const f of ["README.md", "docs/source-map.md", "docs/migration.md", "NOTICE.md", ".claude-plugin/plugin.json"])
  if (!existsSync(join(root, f))) err(`${f} missing`);

const mapPath = join(root, "docs", "source-map.md");
if (existsSync(mapPath) && existsSync(join(root, ".sources"))) {
  const map = readFileSync(mapPath, "utf8");
  for (const stack of readdirSync(join(root, ".sources")).filter((s) => !s.startsWith(".")))
    for (const f of readdirSync(join(root, ".sources", stack)).filter((x) => !x.startsWith("."))) {
      const base = f.replace(/\.md$/, "");
      if (!map.includes(`${stack}/${base}`) && !new RegExp(`\\b${base}\\b`).test(map)) err(`source-map: ${stack}/${base} not covered`);
    }
}

// Verbatim copy check: any 3 consecutive non-trivial lines identical to a source.
if (existsSync(join(root, ".sources"))) {
  const norm = (l) => l.trim().replace(/\s+/g, " ");
  const triples = new Map();
  for (const f of walk(join(root, ".sources"))) {
    const ls = readFileSync(f, "utf8").split("\n").map(norm);
    for (let i = 0; i + 2 < ls.length; i++) {
      const tri = ls.slice(i, i + 3);
      if (tri.every((l) => l.length > 25)) triples.set(tri.join("\n"), f);
    }
  }
  for (const f of walk(join(root, "skills"))) {
    const ls = readFileSync(f, "utf8").split("\n").map(norm);
    for (let i = 0; i + 2 < ls.length; i++) {
      const key = ls.slice(i, i + 3).join("\n");
      if (triples.has(key)) { err(`${f}:${i + 1} copies 3+ lines from ${triples.get(key)}`); break; }
    }
  }
}

if (errors.length) { console.log(errors.map((e) => "FAIL " + e).join("\n")); process.exit(1); }
console.log(`OK: ${expected.length} skills pass all checks`);
