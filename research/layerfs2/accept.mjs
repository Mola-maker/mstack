// LayerFS 2.0 accept path for mstack (the review of PR #16 showed export-into-the-repo, publish and the
// same-file rule do not hold). This proves the path the spec now describes, on a real git repo:
//   git archive <base> → init (no .git) → a Branch per worker → same-file and /.git/ checks on the diffs
//   → merge → export the result to a fresh folder → replace a git worktree's content → commit agent/<slug>
// Run inside WSL: research/layerfs2/run.sh accept
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, close } from "@layerfs/node";

const root = mkdtempSync(join(process.env.PROBE_DIR || tmpdir(), "lfs2acc-"));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const out = (k, v) => console.log(k.padEnd(26), typeof v === "string" ? v : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x)).slice(0, 200));
const paths = async (lfs, p, b) => {
  // the answer is {kind, from, to, items: [{path, kind, type, …}], has_more, next_page_pos}: read every page
  const all = [];
  let page_pos;
  for (;;) {
    const d = await lfs.branch.diff(p, "main", b, { paths_only: true, ...(page_pos !== undefined ? { page_pos } : {}) });
    all.push(...d.items.map((e) => e.path));
    if (!d.has_more) return all;
    page_pos = d.next_page_pos;
  }
};

// a git repo with a hook-free history
const repo = join(root, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "probe@example.invalid");
git(repo, "config", "user.name", "probe");
writeFileSync(join(repo, "src.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n");
writeFileSync(join(repo, "other.txt"), "other\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
const base = git(repo, "rev-parse", "HEAD");

// 1. the snapshot LayerFS gets: tracked files of <base>, no .git
const snap = join(root, "snap");
mkdirSync(snap);
execFileSync("bash", ["-c", `git -C "${repo}" archive ${base} | tar -x -C "${snap}"`]);
out("snapshot has .git", readdirSync(snap).includes(".git"));

const lfs = client({ home: join(root, "home") });
const P = "mstack/repo";
try {
  await lfs.store.create("mstack");
  await lfs.project.init(P, snap);
  for (const b of ["agent-a", "agent-b", "agent-c", "agent-evil"]) await lfs.branch.fork(P, b, "main");
  await lfs.file.edit(P, "agent-a", "/src.txt", { old: "1\n", new: "ONE\n", message: "a" });
  await lfs.file.edit(P, "agent-b", "/src.txt", { old: "8\n", new: "EIGHT\n", message: "b" });
  await lfs.file.write(P, "agent-c", "/other.txt", "other, changed by c\n", { message: "c" });
  // a worker that tries to plant a git hook (the snapshot has no .git, so it makes the folders first)
  await lfs.file.mkdir(P, "agent-evil", "/.git", { message: "evil" });
  await lfs.file.mkdir(P, "agent-evil", "/.git/hooks", { message: "evil" });
  await lfs.file.write(P, "agent-evil", "/.git/hooks/post-checkout", "#!/bin/sh\necho pwned\n", { message: "evil" });

  // 2. checks on the diffs before any merge
  const changed = {};
  for (const b of ["agent-a", "agent-b", "agent-c", "agent-evil"]) changed[b] = await paths(lfs, P, b);
  out("changed paths", changed);
  const gitPaths = Object.entries(changed).filter(([, ps]) => ps.some((x) => /^\/?\.git(\/|$)/.test(x))).map(([b]) => b);
  out("refused: writes .git", gitPaths);
  const overlap = (x, y) => changed[x].filter((p) => changed[y].includes(p));
  out("same file a & b", overlap("agent-a", "agent-b"));
  out("same file a & c", overlap("agent-a", "agent-c"));

  // 3. integrate only the disjoint pair
  out("merge a+c", (await lfs.branch.merge(P, "agent-int-1", "agent-a", "agent-c", { message: "int" })).kind);

  // 4. export the result to a fresh folder (never into the repo), then into a git worktree at <base>
  const exp = join(root, "export");
  await lfs.project.export(P, exp, { branch: "agent-int-1" });
  out("export has .git", readdirSync(exp).includes(".git"));
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "agent/probe", wt, base);
  // replace the tracked content with the export (deletions included), keep the worktree's .git file
  for (const f of git(wt, "ls-files", "-z").split("\0").filter(Boolean)) rmSync(join(wt, f), { force: true });
  cpSync(exp, wt, { recursive: true, filter: (s) => !/[\\/]\.git([\\/]|$)/.test(s.slice(exp.length)) });
  git(wt, "add", "-A");
  out("git diff --stat", git(wt, "diff", "--cached", "--stat").split("\n").pop());
  git(wt, "commit", "-q", "-m", "agent/probe: a + c");
  out("committed src.txt", readFileSync(join(wt, "src.txt"), "utf8").split("\n")[0]);
  out("committed other.txt", readFileSync(join(wt, "other.txt"), "utf8").trim());
  out("main untouched", git(repo, "rev-parse", "main") === base);
} catch (e) {
  out("FAILED", { code: e.code, message: String(e.message).slice(0, 300) });
  process.exitCode = 1;
} finally {
  close();
  rmSync(root, { recursive: true, force: true });
}
