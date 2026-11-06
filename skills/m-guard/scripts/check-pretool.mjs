#!/usr/bin/env node
// Optional Claude Code PreToolUse checker. Zero dependencies.
//
// Usage (hook or manual):
//   node "<this skill dir>/scripts/check-pretool.mjs"
// Reads one PreToolUse JSON object from stdin. On a match, prints a single JSON
// object whose permissionDecision is "ask" (never "deny") nested under
// hookSpecificOutput. Prints nothing when there is nothing to ask.
// Always exits 0: a crash or a non-zero status would not be a hard block, and
// this script does not try to become one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const RM_NAMES = new Set(["rm", "rmdir", "rd", "del", "erase", "ri", "remove-item"]);
const WRAPPERS = new Set(["bash", "sh", "pwsh", "powershell", "cmd"]);
const KNOWN_REMOTES = new Set(["origin", "upstream"]);

const shellBase = (word) => {
  const s = String(word).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase().replace(/\.exe$/, "");
};

export function splitSegments(command) {
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) {
      cur += c;
      if (c === q && command[i - 1] !== "\\") q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\n" || c === ";") {
      parts.push(cur);
      cur = "";
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === "|") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function tokenize(segment) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (q) {
      if (c === q) {
        q = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function isRecursiveFlag(token) {
  if (token === "--recursive" || /^-recurse$/i.test(token)) return true;
  if (/^\/[sS]$/.test(token)) return true;
  const m = token.match(/^-([A-Za-z]+)$/);
  if (!m || m[1].length > 4) return false;
  if (![...m[1]].every((ch) => "rRfFiIvV".includes(ch))) return false;
  return /[rR]/.test(m[1]);
}

export function dangerTarget(raw, home) {
  let t = String(raw).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  const sl = t.replace(/\\/g, "/");
  if (/^\/+$/.test(sl) || sl === "/*" || sl === "/.") return true;
  if (/^[A-Za-z]:\/+$/.test(sl) || /^[A-Za-z]:\/\*$/.test(sl)) return true;
  const bare = sl.replace(/\/+$/, "");
  const literals = new Set([
    "~", "~/*", "$HOME", "${HOME}", "$env:HOME", "$env:USERPROFILE",
    "$env:home", "$env:userprofile", "%USERPROFILE%", "%HOME%",
  ]);
  if (literals.has(bare) || literals.has(sl) || sl === "$HOME/*" || sl === "${HOME}/*") return true;
  if (!home) return false;
  const h = home.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (bare.toLowerCase() === h) return true;
  return sl.endsWith("/*") && sl.slice(0, -2).replace(/\/+$/, "").toLowerCase() === h;
}

function rmHit(tokens, home) {
  for (let i = 0; i < tokens.length; i++) {
    if (!RM_NAMES.has(shellBase(tokens[i]))) continue;
    let rec = false;
    const operands = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t === "--") {
        operands.push(...tokens.slice(j + 1));
        break;
      }
      if (isRecursiveFlag(t)) rec = true;
      else if (t.startsWith("--") || /^\/[A-Za-z]$/.test(t) || /^-[A-Za-z]+$/.test(t)) continue;
      else operands.push(t);
    }
    if (rec && operands.some((op) => dangerTarget(op, home))) return true;
  }
  return false;
}

function peelRemote(pos) {
  if (pos.length === 0) return [];
  const [first, ...rest] = pos;
  if (first.includes("://") || first.startsWith("git@")) return rest;
  if (pos.length >= 2 && !first.includes(":") && !first.startsWith("+")) return rest;
  if (pos.length === 1 && KNOWN_REMOTES.has(first)) return [];
  return pos;
}

function branchOf(spec, current) {
  let s = spec.startsWith("+") ? spec.slice(1) : spec;
  const colon = s.indexOf(":");
  let dst = colon >= 0 ? s.slice(colon + 1) : s;
  if (!dst) return null;
  dst = dst.replace(/^refs\/heads\//, "");
  if (dst === "HEAD") return current || null;
  return dst;
}

function pushReason(tokens, opts) {
  const gi = tokens.findIndex((t) => shellBase(t) === "git");
  if (gi < 0) return null;
  let i = gi + 1;
  while (i < tokens.length && tokens[i] !== "push") {
    const t = tokens[i];
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree") {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    return null;
  }
  if (tokens[i] !== "push") return null;
  i += 1;
  let hard = false;
  let plus = false;
  const pos = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      pos.push(...tokens.slice(i + 1));
      break;
    }
    if (t === "--force" || t.startsWith("--force=")) {
      hard = true;
      continue;
    }
    if (t === "--force-with-lease" || t.startsWith("--force-with-lease=")) continue;
    if (t.startsWith("--")) continue;
    if (/^-[A-Za-z]+$/.test(t)) {
      if (t.includes("f")) hard = true;
      continue;
    }
    if (t.startsWith("+")) plus = true;
    pos.push(t);
  }
  const refspecs = peelRemote(pos);
  for (const spec of refspecs) if (spec.startsWith("+")) plus = true;
  if (!hard && !plus) return null;

  const targets = [];
  if (refspecs.length === 0) {
    if (!opts.currentBranch) {
      return "m-guard: force-push with no refspec, and the current branch could not be read. This asks; it does not deny.";
    }
    targets.push(opts.currentBranch);
  } else {
    for (const spec of refspecs) {
      const b = branchOf(spec, opts.currentBranch);
      if (b) targets.push(b);
    }
  }
  if (!opts.defaultBranch) {
    return "m-guard: force-push, and the default branch could not be read (git symbolic-ref refs/remotes/origin/HEAD failed). This asks; it does not deny. --force-with-lease alone would not ask.";
  }
  if (!targets.some((t) => t === opts.defaultBranch)) return null;
  return `m-guard: force-push targets default branch '${opts.defaultBranch}'. --force-with-lease alone is allowed. This asks; it does not deny.`;
}

function wrapped(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (!WRAPPERS.has(shellBase(tokens[i]))) continue;
    const flag = tokens[i + 1];
    if (flag === "-c" || flag === "/c" || flag === "-Command") return tokens[i + 2] ?? null;
  }
  return null;
}

function shellReason(command, opts, depth = 0) {
  if (!command || depth > 2) return null;
  for (const seg of splitSegments(command)) {
    const tokens = tokenize(seg);
    if (rmHit(tokens, opts.home)) {
      return "m-guard: recursive delete of / or home (~, $HOME, or the home directory). This asks; it does not deny.";
    }
    const push = pushReason(tokens, opts);
    if (push) return push;
    const inner = wrapped(tokens);
    if (inner) {
      const nested = shellReason(inner, opts, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function git(cwd, args) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolveBranches(opts, cwd) {
  if (opts.lookupGit === false) {
    return { defaultBranch: opts.defaultBranch ?? null, currentBranch: opts.currentBranch ?? null };
  }
  const currentRaw = opts.currentBranch ?? git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const current = currentRaw && currentRaw !== "HEAD" ? currentRaw : null;
  let def = opts.defaultBranch ?? null;
  if (opts.defaultBranch === undefined) {
    const sym = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (sym) def = sym.includes("/") ? sym.slice(sym.lastIndexOf("/") + 1) : sym;
  }
  return { defaultBranch: def, currentBranch: current };
}

function toSlash(p) {
  return String(p).replace(/\\/g, "/");
}

function absSlash(p, cwd) {
  const s = toSlash(p).trim();
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s) || /^[A-Za-z]:$/.test(s)) return s;
  return posix.join(toSlash(cwd || "."), s);
}

function stripTrail(p) {
  const s = toSlash(p);
  if (/^\/+$/.test(s)) return "/";
  if (/^[A-Za-z]:\/+$/.test(s)) return s.slice(0, 3);
  return s.replace(/\/+$/, "");
}

export function covers(root, file) {
  const fold = (s) => (/^[A-Za-z]:/.test(s) ? s.toLowerCase() : s);
  const R = fold(stripTrail(root));
  const F = fold(stripTrail(file));
  if (R === "/") return F.startsWith("/");
  if (/^[a-z]:\/$/.test(R)) return F.startsWith(R);
  return F === R || F.startsWith(`${R}/`);
}

function canon(p, opts) {
  if (opts.canonical) return opts.canonical(p);
  const slash = toSlash(p);
  try {
    return toSlash(realpathSync(slash));
  } catch {
    const parent = slash.replace(/\/[^/]+$/, "");
    if (!parent || parent === slash) return slash;
    try {
      return toSlash(realpathSync(parent)) + slash.slice(parent.length);
    } catch {
      return slash;
    }
  }
}

export function parseFreeze(text, cwd, home) {
  const roots = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    let entry = trimmed;
    if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\")) {
      entry = (home || "") + entry.slice(1);
    }
    roots.push(absSlash(entry, cwd));
  }
  return roots;
}

function freezeReason(filePath, opts) {
  let text = opts.freezeText;
  if (text === undefined) {
    const file = opts.freezeFile ?? join(opts.cwd || ".", ".mstack", "freeze");
    if (!existsSync(file)) return null;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return "m-guard: .mstack/freeze exists but could not be read. This asks; it does not deny.";
    }
  }
  const roots = parseFreeze(text, opts.cwd, opts.home);
  if (roots.length === 0) return null;
  if (!filePath) {
    return "m-guard: Edit/Write had no file_path while .mstack/freeze lists allowed prefixes. This asks; it does not deny.";
  }
  const file = canon(absSlash(filePath, opts.cwd), opts);
  // The mstack state directory is never frozen: m-goal checkpoints and closeouts,
  // m-handoff snapshots and the freeze file itself must stay writable mid-freeze,
  // or an overnight run ends without its closeout.
  const stateDir = canon(absSlash(join(opts.cwd || ".", ".mstack"), opts), opts);
  if (covers(stateDir, file)) return null;
  if (roots.some((r) => covers(canon(r, opts), file))) return null;
  return `m-guard: path is outside .mstack/freeze (${file}). This asks; it does not deny.`;
}

export function evaluate(event, opts = {}) {
  if (!event || typeof event !== "object") return null;
  const tool = event.tool_name;
  const input = event.tool_input ?? {};
  const cwd = opts.cwd || event.cwd || ".";
  const home = opts.home ?? homedir();
  if (tool === "Bash" || tool === "PowerShell") {
    const command = String(input.command ?? "");
    const needsGit = /\bgit\b/.test(command) && /\bpush\b/.test(command);
    const branches = needsGit ? resolveBranches({ ...opts, cwd }, cwd) : {
      defaultBranch: opts.defaultBranch ?? null,
      currentBranch: opts.currentBranch ?? null,
    };
    const reason = shellReason(command, { ...opts, cwd, home, ...branches });
    return reason ? { reason } : null;
  }
  if (tool === "Edit" || tool === "Write") {
    const reason = freezeReason(input.file_path, { ...opts, cwd, home });
    return reason ? { reason } : null;
  }
  return null;
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(join(process.cwd(), arg)).href
      || import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const usage = "usage: node \"<this skill dir>/scripts/check-pretool.mjs\" < pretool.json\nReads one PreToolUse JSON object on stdin. Prints an ask decision, or nothing. Exits 0.\n";
  if (process.stdin.isTTY) {
    process.stderr.write(usage);
    process.exit(0);
  }
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) process.exit(0);
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      process.exit(0);
    }
    const hit = evaluate(event);
    if (hit) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: hit.reason,
        },
      })}\n`);
    }
    process.exit(0);
  });
}
