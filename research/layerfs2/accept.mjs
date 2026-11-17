// LayerFS 2.0 accept path for mstack, proved on a real git repo with the shapes that broke earlier versions:
// export-ignore and export-subst attributes, a relative symlink, an executable, a submodule gitlink, a nested .git.
//   checkout-index of <base> (no .git, no attribute rewriting) → init → a Branch per worker
//   → refuse any path with a .git component, stop on shared paths → merge
//   → export the result to a fresh folder → apply ONLY the diff's paths to a git worktree at <base> → commit
// A Branch where nobody wrote must commit nothing.
// Run inside WSL: research/layerfs2/run.sh accept
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { client, close } from "@layerfs/node";

const root = mkdtempSync(join(process.env.PROBE_DIR || tmpdir(), "lfs2acc-"));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const out = (k, v) => console.log(k.padEnd(28), typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x)).slice(0, 220));
const GIT_COMPONENT = /(^|\/)\.git(\/|$)/;

/** Every path a Branch changed against main: {path, kind}; reads all pages. */
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

/** Carry exactly the changed paths from the export into the worktree; nothing else is touched. */
function applyChanges(items, exp, wt) {
  for (const { path: p } of items) {
    const rel = p.replace(/^\/+/, "");
    const src = join(exp, rel);
    const dst = join(wt, rel);
    let s = null;
    try {
      s = lstatSync(src);
    } catch {
      s = null; // gone in the result: a deletion
    }
    if (s === null) {
      rmSync(dst, { recursive: true, force: true });
      continue;
    }
    if (s.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    rmSync(dst, { recursive: true, force: true });
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
  const exp = join(root, `export-${label}`);
  await lfs.project.export(P, exp, { branch });
  const wt = join(root, `wt-${label}`);
  git(repo, "worktree", "add", "-q", "-b", `agent/${label}`, wt, base);
  const items = await changes(lfs, P, branch);
  applyChanges(items, exp, wt);
  rmSync(exp, { recursive: true, force: true }); // the export is gone before git looks: nothing may point into it
  git(wt, "add", "-A");
  return { wt, staged: git(wt, "diff", "--cached", "--name-status") };
}
try {
  await lfs.store.create("mstack");
  await lfs.project.init(P, snap);
  for (const b of ["agent-noop", "agent-a", "agent-b", "agent-c", "agent-evil", "agent-nested"]) await lfs.branch.fork(P, b, "main");
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

  // 2. checks before any merge
  const changed = {};
  for (const b of ["agent-noop", "agent-a", "agent-b", "agent-c", "agent-evil", "agent-nested"]) changed[b] = (await changes(lfs, P, b)).map((i) => i.path);
  out("changed paths", changed);
  out("refused: a .git component", Object.entries(changed).filter(([, ps]) => ps.some((x) => GIT_COMPONENT.test(x))).map(([b]) => b));
  const overlap = (x, y) => changed[x].filter((p) => changed[y].includes(p));
  out("same file a & b", overlap("agent-a", "agent-b"));
  out("same file a & c", overlap("agent-a", "agent-c"));

  // 3. a Branch where nobody wrote commits nothing
  out("no-op staged", (await accept("agent-noop", "noop")).staged || "(nothing)");

  // 4. integrate the disjoint pair and accept it
  out("merge a+c", (await lfs.branch.merge(P, "agent-int-1", "agent-a", "agent-c", { message: "int" })).kind);
  const { wt, staged } = await accept("agent-int-1", "int");
  out("int staged", staged.replace(/\n/g, " | "));
  git(wt, "commit", "-q", "-m", "agent/int: a + c");
  out("committed src.txt line 1", readFileSync(join(wt, "src.txt"), "utf8").split("\n")[0]);
  out("link still relative", readlinkSync(join(wt, "link")));
  out("run.sh executable", (statSync(join(wt, "run.sh")).mode & 0o111) !== 0);
  out("gitlink untouched", git(wt, "ls-files", "-s", "dep").split(" ")[0]);
  out("main untouched", git(repo, "rev-parse", "main") === base);
} catch (e) {
  out("FAILED", { code: e.code, message: String(e.message).slice(0, 300) });
  process.exitCode = 1;
} finally {
  close();
  rmSync(root, { recursive: true, force: true });
}
