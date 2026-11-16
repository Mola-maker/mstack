// Shape checks for the operate-UI routing contract and eval cases.
// This is not a behavioral run: a live model has not been executed against these evals.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const start = read("skills", "m-start", "SKILL.md");
const go = read("commands", "go.md");
const cua = read("skills", "m-cua", "SKILL.md");

function caseYaml(name) {
  const f = join(root, "evals", name, "case.yaml");
  assert.ok(existsSync(f), `missing eval ${name}`);
  return readFileSync(f, "utf8");
}

function promptOf(yaml) {
  const m = yaml.match(/^  prompt:\s*(.*)$/m);
  assert.ok(m, "eval case must have an execution prompt");
  return m[1].replace(/^["']|["']$/g, "");
}

test("m-start resumes a running /go before a fresh operate-UI route, and proof of a change is not that route", () => {
  const resume = start.search(/running or blocked/);
  const operate = start.search(/only to operate a real, already-existing UI/);
  const pipeline = start.search(/A whole task stated as one sentence/);
  assert.ok(resume >= 0 && operate >= 0 && pipeline >= 0);
  assert.ok(resume < operate, "resume a running /go before routing a new operate-UI request to m-cua");
  assert.ok(operate < pipeline, "operate-UI still comes before a new one-sentence /go pipeline");
  assert.match(start, /not to build, prove, accept, or verify a software change/);
  assert.match(start, /Proof or acceptance of a change/);
  assert.match(start, /m-verify/);
  const defaults = start.split(/\n/).find((l) => l.includes("If no single skill obviously applies"));
  assert.ok(defaults, "default-route step is present");
  assert.doesNotMatch(defaults, /真机验收/);
  assert.match(defaults, /验证一下\/验收刚才的修复.*m-verify/);
});

test("/go short-circuits only a pure operate-existing-UI intent, and keeps proof of a change on the pipeline", () => {
  const cut = go.search(/only to operate a real, already-existing UI/);
  const startRun = go.indexOf("## 0. Start the run");
  assert.ok(cut >= 0 && startRun > cut);
  assert.match(go, /not to build, prove, accept, or verify a software change/);
  assert.match(go, /accept a change by driving the UI, keep this pipeline/);
});

test("eval cases: desktop and browser operate fire m-cua and forbid /go; proof of a change fires m-verify and forbids m-cua", () => {
  const desktop = caseYaml("route-ui-to-m-cua");
  const browser = caseYaml("route-browser-to-m-cua");
  const proof = caseYaml("route-ui-proof-to-m-verify");
  for (const [yaml, promptHint] of [[desktop, /文件管理器/], [browser, /浏览器/]]) {
    assert.match(yaml, /name: fires-m-cua/);
    assert.match(yaml, /name: must-not-start-go/);
    assert.match(yaml, /tool: SlashCommand/);
    const prompt = promptOf(yaml);
    assert.match(prompt, promptHint);
    assert.doesNotMatch(prompt, /m-cua|mola-cua|agent-desktop|\/go|cua-doctor/);
  }
  assert.match(proof, /name: fires-m-verify/);
  assert.match(proof, /name: must-not-fire-m-cua/);
  assert.match(promptOf(proof), /真机验收|修复/);
  assert.doesNotMatch(promptOf(proof), /m-cua|\/go/);
});

test("m-cua still starts with the doctor and does not treat mola-cua snapshot as the desktop entry", () => {
  assert.match(cua, /Run the doctor/);
  assert.match(cua, /`mola-cua snapshot` is Android even if you pass `--app`/);
});
