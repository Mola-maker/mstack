// LayerFS 2.0 accept path for mstack, proved on a real git repo with the shapes that broke earlier versions:
// export-ignore and export-subst attributes, a relative symlink, a link to a folder, an executable, a submodule gitlink,
// a nested .git (any case), a file and a folder swapping places, an edit and its revert.
//   checkout-index of <base> (no .git, no attribute rewriting) → init → a Branch per worker
//   → refuse any path with a .git component, stop on shared paths (the same path, or one under the other) → merge
//   → export the result to a fresh folder → apply ONLY the diff's paths to a git worktree at <base> → commit
// A Branch where nobody wrote, or whose writes cancel out, must commit nothing; a failed accept leaves no worktree or branch.
// Run inside WSL: research/layerfs2/run.sh accept
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { client, close } from "@layerfs/node";

const root = mkdtempSync(join(process.env.PROBE_DIR || tmpdir(), "lfs2acc-"));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
const out = (k, v) => console.log(k.padEnd(30), typeof v === "string" ? v : json(v));
// case-insensitive: on DrvFs (/mnt/c) `.GIT` is `.git`; `git~1` is its NTFS short name
const GIT_COMPONENT = /(^|\/)(\.git|git~\d+)(\/|$)/i;
const fail = (code, message) => Object.assign(new Error(message), { code });
const rel = (p) => p.replace(/^\/+/, "");
const depth = (p) => rel(p).split("/").length;
// a folder that still exists after the change: two Branches may both create or keep one
const keptDir = (i) => i.type === "dir" && i.kind !== "Removed";

/** Every path a Branch changed against main: {path, kind, type}; reads all pages. */
async function changes(lfs, p, b) {
  const all = [];
  let page_pos;
  for (;;) {
    const d = await lfs.branch.diff(p, "main", b, { paths_only: true, ...(page_pos !== undefined ? { page_pos } : {}) });
    all.push(...d.items.map((e) => ({ path: e.path, kind: e.kind, type: e.type })));
    if (!d.has_more) return all;
    page_pos = d.next_page_pos;
  }
}

/** Paths two Branches both touch: the same path (unless both keep it a folder), or one under a path the other changed. */
function collisions(xs, ys) {
  const hit = [];
  const under = (a, b) => b.path.startsWith(a.path.replace(/\/+$/, "") + "/");
  for (const a of xs)
    for (const b of ys) {
      if (a.path === b.path ? !(keptDir(a) && keptDir(b)) : (under(a, b) && !keptDir(a)) || (under(b, a) && !keptDir(b))) hit.push(a.path === b.path ? a.path : `${a.path} ~ ${b.path}`);
    }
  return hit;
}

function refuseUnsafe(items) {
  const bad = items.filter((i) => GIT_COMPONENT.test(i.path) || rel(i.path).split("/").some((c) => c === "" || c === "." || c === ".."));
  if (bad.length > 0) throw fail("Refused", `unsafe paths: ${bad.map((i) => i.path).join(", ")}`);
}

/** True when every existing ancestor of rel inside wt is a real folder (never a symlink or a file). */
function ancestorsAreDirs(wt, r) {
  const parts = r.split("/").slice(0, -1);
  for (let k = 1; k <= parts.length; k++) {
    let s;
    try {
      s = lstatSync(join(wt, ...parts.slice(0, k)));
    } catch {
      return true; // absent from here down: mkdir creates real folders
    }
    if (!s.isDirectory()) return false;
  }
  return true;
}

const lstatOrNull = (x) => {
  try {
    return lstatSync(x);
  } catch {
    return null;
  }
};

/** git's view of one exported path: "<mode> <blob>", or null when absent. */
function exportedEntry(wt, src, s) {
  if (s === null || s.isDirectory()) return null;
  if (s.isSymbolicLink()) return `120000 ${execFileSync("git", ["hash-object", "--stdin"], { cwd: wt, input: readlinkSync(src), encoding: "utf8" }).trim()}`;
  return `${s.mode & 0o111 ? "100755" : "100644"} ${git(wt, "hash-object", "--no-filters", src)}`;
}

/** Non-folder paths whose result differs from <base>: these, and only these, must reach git. */
function mustCarry(items, exp, wt, base) {
  return items.filter((i) => {
    const src = join(exp, rel(i.path));
    const s = lstatOrNull(src);
    if (s?.isDirectory()) return false;
    const line = git(wt, "ls-tree", base, "--", rel(i.path)); // "<mode> <type> <blob>\t<path>"
    const [mode, type, blob] = line.split(/\s+/);
    if (type === "tree" || (s === null && line === "")) return false; // a folder, or added and removed again
    return exportedEntry(wt, src, s) !== (line === "" ? null : `${mode} ${blob}`);
  });
}

/** Carry exactly the changed paths from the export into the worktree; nothing else is touched. */
function applyChanges(items, exp, wt) {
  refuseUnsafe(items);
  const withSrc = items.map((i) => ({ ...i, s: lstatOrNull(join(exp, rel(i.path))) }));
  const gone = withSrc.filter((i) => i.s === null).sort((a, b) => depth(b.path) - depth(a.path)); // children first
  const made = withSrc.filter((i) => i.s !== null).sort((a, b) => depth(a.path) - depth(b.path)); // parents first
  for (const { path: p } of gone) {
    const r = rel(p);
    if (!ancestorsAreDirs(wt, r)) continue; // behind a symlink or a file: not in this worktree
    try {
      rmSync(join(wt, r), { recursive: true, force: true });
    } catch (e) {
      if (e.code !== "ENOTDIR") throw e;
    }
  }
  for (const { path: p, s } of made) {
    const r = rel(p);
    const src = join(exp, r);
    const dst = join(wt, r);
    if (!ancestorsAreDirs(wt, r)) throw fail("Refused", `would write through a symlink or file: ${p}`);
    const d = lstatOrNull(dst);
    if (s.isDirectory()) {
      if (d !== null && !d.isDirectory()) rmSync(dst, { force: true }); // a file or symlink becomes a folder
      mkdirSync(dst, { recursive: true });
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    if (d !== null) rmSync(dst, { recursive: true, force: true });
    if (s.isSymbolicLink()) symlinkSync(readlinkSync(src), dst); // the link text as is, never followed
    else {
      copyFileSync(src, dst);
      chmodSync(dst, statSync(src).mode & 0o777);
    }
  }
}

// a repo with the awkward shapes
const repo = join(root, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "probe@example.invalid");
git(repo, "config", "user.name", "probe");
writeFileSync(join(repo, "src.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
writeFileSync(join(repo, "other.txt"), "other\n");
writeFileSync(join(repo, "ignored.txt"), "kept by git, dropped by git archive\n");
writeFileSync(join(repo, "ver.txt"), "$Format:%H$\n");
writeFileSync(join(repo, ".gitattributes"), "ignored.txt export-ignore\nver.txt export-subst\n");
writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho ok\n");
chmodSync(join(repo, "run.sh"), 0o755);
symlinkSync("run.sh", join(repo, "link"));
mkdirSync(join(repo, "shared"));
writeFileSync(join(repo, "shared", "s.txt"), "shared\n");
symlinkSync("shared", join(repo, "lib")); // a link to a folder
writeFileSync(join(repo, "f"), "a file that becomes a folder\n");
mkdirSync(join(repo, "d"));
writeFileSync(join(repo, "d", "x"), "in a folder that becomes a file\n");
mkdirSync(join(repo, "tree"));
writeFileSync(join(repo, "tree", "a.ts"), "a\n");
git(repo, "add", "-A");
git(repo, "update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},dep`); // a submodule gitlink
git(repo, "commit", "-q", "-m", "base");
const base = git(repo, "rev-parse", "HEAD");

// 1. the snapshot: tracked files of <base> as the worktree has them (no .git, no archive attributes, no gitlinks)
const snap = join(root, "snap");
const tmpIndex = join(root, "index");
execFileSync("git", ["read-tree", base], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
execFileSync("git", ["checkout-index", "-a", `--prefix=${snap}/`], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
out("snapshot ignored.txt kept", readFileSync(join(snap, "ignored.txt"), "utf8").startsWith("kept"));
out("snapshot ver.txt verbatim", readFileSync(join(snap, "ver.txt"), "utf8").trim());
out("snapshot link is a symlink", lstatSync(join(snap, "link")).isSymbolicLink());

const lfs = client({ home: join(root, "home") });
const P = "mstack/repo";
const wtN = { n: 0 };
async function accept(branch, label) {
  const items = await changes(lfs, P, branch);
  refuseUnsafe(items); // checked again here: the integration Branch is not the Branches step 5 looked at
  const exp = join(root, `export-${label}`);
  const wt = join(root, `wt-${label}`);
  let ok = false;
  try {
    await lfs.project.export(P, exp, { branch });
    git(repo, "worktree", "add", "-q", "-b", `agent/${label}`, wt, base);
    const expected = mustCarry(items, exp, wt, base);
    applyChanges(items, exp, wt);
    rmSync(exp, { recursive: true, force: true }); // the export is gone before git looks: nothing may point into it
    git(wt, "add", "-A");
    // a path under a gitlink, or one .gitignore hides, is dropped by `add -A` without an error
    const staged = new Set(git(wt, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean));
    const lost = expected.filter((i) => !staged.has(rel(i.path))).map((i) => i.path);
    if (lost.length > 0) throw fail("NotCarried", `not carried into git: ${lost.join(", ")}`);
    ok = true;
    return { wt, staged: git(wt, "diff", "--cached", "--name-status") };
  } finally {
    rmSync(exp, { recursive: true, force: true });
    if (!ok) {
      try {
        git(repo, "worktree", "remove", "--force", wt);
      } catch {}
      try {
        git(repo, "branch", "-D", `agent/${label}`);
      } catch {}
    }
  }
}
try {
  await lfs.store.create("mstack");
  await lfs.project.init(P, snap);
  const W = ["agent-noop", "agent-a", "agent-b", "agent-c", "agent-evil", "agent-nested", "agent-case", "agent-e", "agent-f", "agent-g",
    "agent-rev", "agent-f2d", "agent-d2f", "agent-rmtree", "agent-edittree", "agent-lnkdir"];
  for (const b of W) await lfs.branch.fork(P, b, "main");
  // e and f add different files in one new folder; g writes under the submodule path
  for (const [b, f] of [["agent-e", "e"], ["agent-f", "f"]]) {
    await lfs.file.mkdir(P, b, "/newdir", { message: b });
    await lfs.file.write(P, b, `/newdir/${f}.txt`, `${f}\n`, { message: b });
  }
  await lfs.file.mkdir(P, "agent-g", "/dep", { message: "g" });
  await lfs.file.write(P, "agent-g", "/dep/x.txt", "under a gitlink\n", { message: "g" });
  await lfs.file.edit(P, "agent-a", "/src.txt", { old: "1\n", new: "ONE\n", message: "a" });
  await lfs.file.edit(P, "agent-b", "/src.txt", { old: "8\n", new: "EIGHT\n", message: "b" });
  await lfs.file.write(P, "agent-c", "/other.txt", "other, changed by c\n", { message: "c" });
  await lfs.file.rm(P, "agent-c", "/ver.txt", { message: "c removes ver.txt" });
  await lfs.file.mkdir(P, "agent-evil", "/.git", { message: "evil" });
  await lfs.file.mkdir(P, "agent-evil", "/.git/hooks", { message: "evil" });
  await lfs.file.write(P, "agent-evil", "/.git/hooks/post-checkout", "#!/bin/sh\necho pwned\n", { message: "evil" });
  await lfs.file.mkdir(P, "agent-nested", "/pkg", { message: "nested" });
  await lfs.file.mkdir(P, "agent-nested", "/pkg/.git", { message: "nested" });
  await lfs.file.write(P, "agent-nested", "/pkg/.git/HEAD", "ref: refs/heads/main\n", { message: "nested" });
  await lfs.file.mkdir(P, "agent-case", "/pkg", { message: "case" });
  await lfs.file.mkdir(P, "agent-case", "/pkg/.GIT", { message: "case" });
  await lfs.file.write(P, "agent-case", "/pkg/.GIT/HEAD", "ref: refs/heads/main\n", { message: "case" });
  // rev: an edit and its revert; f2d / d2f: a file and a folder swap; rmtree vs edittree: delete a folder vs edit inside it
  await lfs.file.edit(P, "agent-rev", "/src.txt", { old: "1\n", new: "ONE\n", message: "rev" });
  await lfs.file.edit(P, "agent-rev", "/src.txt", { old: "ONE\n", new: "1\n", message: "rev" });
  await lfs.file.rm(P, "agent-f2d", "/f", { message: "f2d" });
  await lfs.file.mkdir(P, "agent-f2d", "/f", { message: "f2d" });
  await lfs.file.write(P, "agent-f2d", "/f/y", "y\n", { message: "f2d" });
  await lfs.file.rm(P, "agent-d2f", "/d", { message: "d2f" });
  await lfs.file.write(P, "agent-d2f", "/d", "now a file\n", { message: "d2f" });
  await lfs.file.rm(P, "agent-rmtree", "/tree", { message: "rmtree" });
  await lfs.file.edit(P, "agent-edittree", "/tree/a.ts", { old: "a\n", new: "A\n", message: "edittree" });
  // lnkdir: replaces the link /lib with a real folder (and LayerFS refuses a write through /lib while it is a link)
  try {
    await lfs.file.write(P, "agent-lnkdir", "/lib/through.txt", "x\n", { message: "lnkdir" });
    out("write through a link", "accepted (WRONG)");
  } catch (e) {
    out("write through a link", e.code);
  }
  await lfs.file.rm(P, "agent-lnkdir", "/lib", { message: "lnkdir" });
  await lfs.file.mkdir(P, "agent-lnkdir", "/lib", { message: "lnkdir" });
  await lfs.file.write(P, "agent-lnkdir", "/lib/x", "x\n", { message: "lnkdir" });

  // 2. checks before any merge
  const items = {};
  for (const b of W) {
    try {
      items[b] = await changes(lfs, P, b);
    } catch (e) {
      out(`diff ${b}`, `${e.code}: ${e.message}`);
    }
  }
  out("changed paths", Object.fromEntries(Object.entries(items).map(([b, xs]) => [b, xs.map((i) => i.path)])));
  out("item types seen", [...new Set(Object.values(items).flat().map((i) => `${i.kind}:${i.type}`))].sort());
  out("refused: a .git component", Object.entries(items).filter(([, xs]) => xs.some((x) => GIT_COMPONENT.test(x.path))).map(([b]) => b));
  const overlap = (x, y) => collisions(items[x], items[y]);
  out("shared a & b", overlap("agent-a", "agent-b"));
  out("shared a & c", overlap("agent-a", "agent-c"));
  out("shared e & f (one new dir)", overlap("agent-e", "agent-f"));
  out("shared rmtree & edittree", overlap("agent-rmtree", "agent-edittree"));
  out("shared f2d & a", overlap("agent-f2d", "agent-a"));
  const tryAccept = async (b, label) => {
    try {
      return (await accept(b, label)).staged.replace(/\n/g, " | ") || "(nothing)";
    } catch (e) {
      return `${e.code}: ${e.message}`;
    }
  };
  out("g under a gitlink", await tryAccept("agent-g", "g"));
  out("g retry after cleanup", await tryAccept("agent-g", "g"));
  out("case .GIT", await tryAccept("agent-case", "case"));
  out("lnkdir", await tryAccept("agent-lnkdir", "lnkdir"));

  // 3. a Branch where nobody wrote, or whose writes cancel out, commits nothing
  out("no-op staged", await tryAccept("agent-noop", "noop"));
  out("edit+revert staged", await tryAccept("agent-rev", "rev"));
  out("file -> folder staged", await tryAccept("agent-f2d", "f2d"));
  out("folder -> file staged", await tryAccept("agent-d2f", "d2f"));

  // 4. integrate the disjoint pair and accept it
  try {
    out("merge rmtree+edittree", (await lfs.branch.merge(P, "agent-int-x", "agent-rmtree", "agent-edittree", { message: "int" })).kind);
  } catch (e) {
    out("merge rmtree+edittree", e.code);
  }
  out("merge a+c", (await lfs.branch.merge(P, "agent-int-1", "agent-a", "agent-c", { message: "int" })).kind);
  const { wt, staged } = await accept("agent-int-1", "int");
  out("int staged", staged.replace(/\n/g, " | "));
  git(wt, "commit", "-q", "-m", "agent/int: a + c");
  out("committed src.txt line 1", readFileSync(join(wt, "src.txt"), "utf8").split("\n")[0]);
  out("link still relative", readlinkSync(join(wt, "link")));
  out("run.sh executable", (statSync(join(wt, "run.sh")).mode & 0o111) !== 0);
  out("gitlink untouched", git(wt, "ls-files", "-s", "dep").split(" ")[0]);
  out("main untouched", git(repo, "rev-parse", "main") === base);

  // 5. applyChanges alone, with a diff LayerFS would not produce: a write under a tracked link to a folder
  const wtl = join(root, "wt-link");
  const expl = join(root, "export-link");
  git(repo, "worktree", "add", "-q", "--detach", wtl, base);
  mkdirSync(join(expl, "lib"), { recursive: true });
  writeFileSync(join(expl, "lib", "x"), "x\n");
  try {
    applyChanges([{ path: "/lib/x", kind: "Added", type: "file" }], expl, wtl);
    out("write under a link", "applied (WRONG)");
  } catch (e) {
    out("write under a link", `${e.code}: ${e.message}`);
  }
  out("link target untouched", lstatOrNull(join(wtl, "shared", "x")) === null);
} catch (e) {
  out("FAILED", { code: e.code, message: String(e.message).slice(0, 300) });
  process.exitCode = 1;
} finally {
  close();
  rmSync(root, { recursive: true, force: true });
}
