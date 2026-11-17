// LayerFS 2.0.0-rc.1 probe for mstack agent writes: two agents on their own Branches, a review diff,
// a merge (clean and conflicting), publish to main, export to a folder. Throwaway home under $TMPDIR.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, close } from "@layerfs/node";

const root = mkdtempSync(join(process.env.PROBE_DIR || tmpdir(), "lfs2-"));
const folder = join(root, "app");
mkdirSync(folder);
writeFileSync(join(folder, "README.md"), "# app\n");
writeFileSync(join(folder, "src.txt"), "line one\nline two\n");
const lfs = client({ home: join(root, "home") });
const out = (k, v) => console.log(k.padEnd(22), JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x)).slice(0, 220));
try {
  await lfs.store.create("mstack");
  await lfs.project.init("mstack/app", folder);
  out("fork a", await lfs.branch.fork("mstack/app", "agent-a", "main"));
  out("fork b", await lfs.branch.fork("mstack/app", "agent-b", "main"));
  out("write a", await lfs.file.write("mstack/app", "agent-a", "/notes.md", "# notes from a\n", { message: "a: notes" }));
  out("edit a", await lfs.file.edit("mstack/app", "agent-a", "/src.txt", { old: "line one", new: "line ONE (a)", message: "a: edit" }));
  out("write b", await lfs.file.write("mstack/app", "agent-b", "/b.md", "# from b\n", { message: "b: add" }));
  out("diff main..a", await lfs.branch.diff("mstack/app", "main", "agent-a", { paths_only: true }));
  out("merge a+b", await lfs.branch.merge("mstack/app", "agent-ab", "agent-a", "agent-b", { message: "merge a and b" }));
  // a conflict: both change the same line
  await lfs.branch.fork("mstack/app", "agent-c", "main");
  await lfs.file.edit("mstack/app", "agent-c", "/src.txt", { old: "line one", new: "line 1 (c)", message: "c: edit" });
  try {
    out("merge a+c", await lfs.branch.merge("mstack/app", "agent-ac", "agent-a", "agent-c", { message: "merge a and c" }));
  } catch (e) {
    out("merge a+c refused", { code: e.code, message: String(e.message).slice(0, 160) });
  }
  out("publish ab", await lfs.branch.publish("mstack/app", "agent-ab"));
  const exp = join(root, "export");
  out("export main", await lfs.project.export("mstack/app", exp));
  out("exported src.txt", readFileSync(join(exp, "src.txt"), "utf8"));
  out("exported files", ["README.md", "notes.md", "b.md", "src.txt"].map((f) => { try { readFileSync(join(exp, f)); return f; } catch { return "-" + f; } }));
} catch (e) {
  out("FAILED", { code: e.code, message: String(e.message).slice(0, 300) });
  process.exitCode = 1;
} finally {
  close();
  rmSync(root, { recursive: true, force: true });
}
