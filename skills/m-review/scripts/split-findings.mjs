#!/usr/bin/env node
// Classify m-review findings. Does not execute repro commands.
// usage: node "<this skill dir>/scripts/split-findings.mjs" <report.md> [--diff <unified.diff>]
// Untracked files in the working tree (git ls-files --others --exclude-standard) are in scope.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FINDING_RE = /^FINDING\s+(.+):(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*$/;
const REPRO_RE = /^REPRO\s+(.+?)\s*(?:→|->)\s*(.+)\s*$/;
const CLEARED_RE = /^CLEARED\s+(.+):(\d+)\s*\|\s*(.+)\s*$/;

export function parseDiff(diffText) {
  const files = new Map();
  let current = null;
  let newLine = 0;
  let inHunk = false;
  const ensure = (filePath) => {
    if (!files.has(filePath)) files.set(filePath, { added: new Set(), deleted: false });
    return files.get(filePath);
  };
  for (const raw of String(diffText).replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      current = ensure(git[2] === "/dev/null" ? git[1] : git[2]);
      inHunk = false;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = null;
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk && current) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith("+")) {
      current.added.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.deleted = true;
    } else if (!line.startsWith("\\")) {
      newLine += 1;
    }
  }
  return files;
}

function normPath(file) {
  return String(file).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// Every existing line of a brand-new file counts as added. An empty file has none.
export function addedFileRecord(text) {
  const norm = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const body = norm.endsWith("\n") ? norm.slice(0, -1) : norm;
  const added = new Set();
  if (body.length) {
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i += 1) added.add(i + 1);
  }
  return { added, deleted: false };
}

// Not a git repo, or git missing → empty map (the diff still classifies). Read errors throw.
export function collectUntracked(cwd = process.cwd()) {
  const run = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error || (run.status ?? 1) !== 0) return new Map();
  const files = new Map();
  for (const rel of run.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const buf = readFileSync(join(cwd, rel));
    if (buf.includes(0)) continue;
    files.set(normPath(rel), addedFileRecord(buf.toString("utf8")));
  }
  return files;
}

export function lineInScope(files, file, line) {
  const rec = files.get(normPath(file));
  if (!rec) return false;
  if (line === 0) return rec.deleted && rec.added.size === 0;
  return rec.added.has(line);
}

export function splitFindings(text, diffText, extraFiles = null) {
  const confirmed = [];
  const unconfirmed = [];
  const cleared = [];
  const errors = [];
  const files = diffText == null ? null : parseDiff(diffText);
  if (files && extraFiles) {
    for (const [file, rec] of extraFiles) {
      const key = normPath(file);
      const prev = files.get(key);
      if (!prev) files.set(key, { added: new Set(rec.added), deleted: false });
      else for (const n of rec.added) prev.added.add(n);
    }
  }
  let pending = null;

  const flush = () => {
    if (!pending) return;
    (pending.repro ? confirmed : unconfirmed).push(pending);
    pending = null;
  };

  const attachScope = (item) => {
    if (!files) {
      item.inScope = null;
      return item;
    }
    item.inScope = lineInScope(files, item.file, item.line);
    return item;
  };

  for (const raw of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (line.startsWith("FINDING")) {
      flush();
      const match = FINDING_RE.exec(line);
      if (!match || !match[3].trim() || !match[4].trim()) {
        errors.push(`malformed FINDING: ${line}`);
        continue;
      }
      pending = attachScope({
        file: normPath(match[1].trim()),
        line: Number(match[2]),
        problem: match[3].trim(),
        failure: match[4].trim(),
        repro: null,
      });
      continue;
    }
    if (line.startsWith("REPRO")) {
      const match = REPRO_RE.exec(line);
      if (!pending || pending.repro || !match || !match[1].trim() || !match[2].trim()) {
        errors.push(`malformed REPRO: ${line}`);
        continue;
      }
      pending.repro = { command: match[1].trim(), output: match[2].trim() };
      continue;
    }
    if (line.startsWith("CLEARED")) {
      flush();
      const match = CLEARED_RE.exec(line);
      if (!match || !match[3].trim()) {
        errors.push(`malformed CLEARED: ${line}`);
        continue;
      }
      cleared.push(attachScope({
        file: normPath(match[1].trim()),
        line: Number(match[2]),
        why: match[3].trim(),
      }));
    }
  }
  flush();

  const conclusion = confirmed.filter((item) => item.inScope !== false);
  const outOfScope = confirmed.filter((item) => item.inScope === false).length;
  return {
    confirmed,
    unconfirmed,
    cleared,
    conclusion,
    counts: {
      confirmed: confirmed.length,
      unconfirmed: unconfirmed.length,
      cleared: cleared.length,
      conclusion: conclusion.length,
      outOfScope,
    },
    errors,
  };
}

export function parseArgs(argv) {
  const out = { file: null, diff: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--diff") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error("--diff needs a path");
      out.diff = value;
      i += 1;
    } else if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  if (rest.length !== 1) throw new Error("expected one report file");
  out.file = rest[0];
  return out;
}

export function main(argv, read = readFileSync, collect = collectUntracked) {
  const usage = 'usage: node "<this skill dir>/scripts/split-findings.mjs" <report.md> [--diff <unified.diff>]\n';
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return { code: 2, stdout: "", stderr: `${usage}${error.message}\n` };
  }
  let report;
  let diff;
  let extra = null;
  try {
    report = read(args.file, "utf8");
    if (args.diff == null) {
      diff = null;
    } else {
      diff = read(args.diff, "utf8");
      // Run from the project root: untracked files are part of the change even when
      // `git diff` is empty (a new file never appears in that diff).
      extra = collect(process.cwd());
    }
  } catch (error) {
    return { code: 2, stdout: "", stderr: `${error.message}\n` };
  }
  const parsed = splitFindings(report, diff, extra);
  if (parsed.errors.length) {
    return { code: 2, stdout: "", stderr: `${parsed.errors.join("\n")}\n` };
  }
  const code = parsed.counts.outOfScope > 0 ? 1 : 0;
  return { code, stdout: `${JSON.stringify(parsed, null, 2)}\n`, stderr: "" };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href
    || fileURLToPath(import.meta.url) === resolve(entry);
}

if (invokedDirectly()) {
  const result = main(process.argv.slice(2));
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.code);
}
