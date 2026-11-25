/**
 * Review receipts (FRAMEWORK §13.4): `.mstack/receipts/<tree>.json`, bound to the
 * exact tree of the commit being landed. A receipt counts only when the
 * reviewer's model family differs from the author's, no blocking FINDING is
 * open, and the review does not end with REQUEST CHANGES.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Finding {
  line: string;
  where: string;
  blocking: boolean;
  why: string;
}

export interface ReviewParse {
  findings: Finding[];
  cleared: string[];
  verdict: "APPROVE" | "REQUEST CHANGES" | null;
}

export interface ReviewReceipt {
  schemaVersion: 1;
  tree: string;
  commit: string;
  ref: string;
  reviewer: string;
  reviewerModel: string;
  reviewerFamily: string;
  authorModel: string;
  authorFamily: string;
  verdict: "APPROVE" | "REQUEST CHANGES" | null;
  findings: { total: number; blocking: number; open: string[] };
  review: string;
  verify?: string;
  createdAt: string;
}

const WHERE = /([\w./\\-]+:\d+)/;

/**
 * Two formats: the reviewer agent's `FINDING path:line | problem | scenario` (blocking
 * only with a REPRO line under it) and the go stage's `FINDING: high|medium|low path:line …`.
 * `low` / `nit` never block; a CLEARED line for the same path:line closes a finding.
 */
export function parseReview(text: string): ReviewParse {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const findings: Finding[] = [];
  const cleared: string[] = [];
  let verdict: ReviewParse["verdict"] = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^[\s>*_`-]+/, "");
    if (/^CLEARED\b/i.test(l)) {
      const w = WHERE.exec(l)?.[1];
      cleared.push(w ?? l.slice(7).trim());
      continue;
    }
    if (/^(APPROVE|REQUEST CHANGES)\b/.test(l)) verdict = l.startsWith("APPROVE") ? "APPROVE" : "REQUEST CHANGES";
    if (!/^FINDING\b/i.test(l)) continue;
    const where = WHERE.exec(l)?.[1] ?? "";
    const head = l.slice(0, 40).toLowerCase();
    const minor = /\b(low|nit|minor|style)\b/.test(head);
    const sev = /\b(high|medium|critical|blocker)\b/.test(head);
    let repro = false;
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j].replace(/^[\s>*_`-]+/, "");
      if (/^FINDING\b/i.test(n)) break;
      if (/^REPRO\b/i.test(n)) {
        repro = true;
        break;
      }
    }
    const blocking = !minor && (sev || repro);
    findings.push({ line: lines[i].trim(), where, blocking, why: minor ? "low/nit" : sev ? "severity" : repro ? "reproduced" : "unconfirmed (no REPRO)" });
  }
  return { findings, cleared, verdict };
}

export function openBlocking(p: ReviewParse): Finding[] {
  return p.findings.filter((f) => f.blocking && !(f.where && p.cleared.includes(f.where)));
}

/** Family of a model route: the routing table's matcher when given, else the provider's model word. */
export function familyFrom(route: string, matcher?: (route: string) => string | null): string {
  const viaTable = matcher?.(route);
  if (viaTable) return viaTable;
  const model = route.toLowerCase().split("/").pop() ?? route.toLowerCase();
  for (const [fam, words] of Object.entries({
    claude: ["claude", "opus", "sonnet", "haiku", "fable"],
    gpt: ["gpt", "o3", "o4", "codex"],
    gemini: ["gemini"],
    deepseek: ["deepseek"],
    kimi: ["kimi", "moonshot"],
    qwen: ["qwen"],
    grok: ["grok"],
    glm: ["glm"],
  })) {
    if (words.some((w) => model.includes(w))) return fam;
  }
  return model.split(/[-_.:]/)[0] || model;
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string; err: string; code: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), code: r.status ?? 1 };
}

export function topLevel(cwd: string): string {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) throw new Error("not inside a git repository");
  return r.out;
}

export function treeOf(cwd: string, ref: string): { tree: string; commit: string } {
  const commit = git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (!commit.ok) throw new Error(`no such commit: ${ref}`);
  const tree = git(cwd, ["rev-parse", `${commit.out}^{tree}`]);
  return { tree: tree.out, commit: commit.out };
}

export const receiptsDir = (top: string): string => path.join(top, ".mstack", "receipts");
export const receiptPath = (top: string, tree: string): string => path.join(receiptsDir(top), `${tree}.json`);

export function readReceipt(top: string, tree: string): ReviewReceipt | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(receiptPath(top, tree), "utf8")) as ReviewReceipt;
    return r.schemaVersion === 1 && r.tree === tree ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Why this receipt does not count; empty when it does. */
export function receiptProblems(r: ReviewReceipt | undefined, opts: { needVerify?: boolean } = {}): string[] {
  if (!r) return ["no review receipt for this tree (mola guard receipt --review <file> …)"];
  const out: string[] = [];
  if (r.reviewerFamily === r.authorFamily) out.push(`reviewer family "${r.reviewerFamily}" is the author's family`);
  if (r.findings.blocking > 0 && r.findings.open.length > 0) out.push(`${r.findings.open.length} blocking finding(s) open: ${r.findings.open.join(", ")}`);
  if (r.verdict === "REQUEST CHANGES") out.push("the review ends with REQUEST CHANGES");
  if (opts.needVerify && !r.verify) out.push("no verify artifact recorded (pass --verify <verify.md> to mola guard receipt)");
  return out;
}
