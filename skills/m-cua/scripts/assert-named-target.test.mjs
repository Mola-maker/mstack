import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, readFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { main, targetVisible } from "./assert-named-target.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = fileURLToPath(new URL("./assert-named-target.mjs", import.meta.url));
const FIX = join(root, "references", "acceptance", "thunar-marker-unreadable");

test("the recorded Thunar fixture does not expose 标记完成.txt, and that is a failure", () => {
  const r = main([
    "--name", "标记完成.txt",
    "--snapshot", join(FIX, "snapshot-before.json"),
    "--snapshot", join(FIX, "snapshot-after.json"),
    "--find", join(FIX, "find-before.json"),
    "--find", join(FIX, "find-after.json"),
  ]);
  assert.equal(r.code, 1);
  assert.match(r.text, /unreadable: 标记完成\.txt/);
  assert.match(r.text, /match:null/);
  assert.match(r.text, /failure, not a pass/);
});

test("find ok:true with match:null is a miss even when no snapshot is given", () => {
  const d = mkdtempSync(join(tmpdir(), "named-target-"));
  try {
    const f = join(d, "find.json");
    writeFileSync(f, JSON.stringify({ ok: true, command: "find", data: { match: null, snapshot_id: "s1" } }));
    const r = main(["--name", "标记完成.txt", "--find", f]);
    assert.equal(r.code, 1);
    assert.match(r.text, /match:null/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a snapshot that names the target is visible and exits 0", () => {
  const d = mkdtempSync(join(tmpdir(), "named-target-"));
  try {
    const f = join(d, "snap.json");
    writeFileSync(f, JSON.stringify({ ok: true, command: "snapshot", data: { tree: { name: "native-doc - Thunar", children: [{ role: "label", name: "标记完成.txt" }] } } }));
    const r = main(["--name", "标记完成.txt", "--snapshot", f]);
    assert.equal(r.code, 0);
    assert.match(r.text, /visible: 标记完成\.txt/);
    assert.equal(targetVisible("标记完成.txt", [JSON.parse(readFileSync(f, "utf8"))]), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("running the script on the fixture exits 1 and prints the miss", () => {
  const r = spawnSync(process.execPath, [
    SCRIPT,
    "--name", "标记完成.txt",
    "--snapshot", join(FIX, "snapshot-before.json"),
    "--find", join(FIX, "find-before.json"),
  ], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unreadable: 标记完成\.txt/);
});

function writeJson(dir, file, obj) {
  const f = join(dir, file);
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

test("a failed snapshot envelope is not a hit even if the target name appears in error or data", () => {
  const d = mkdtempSync(join(tmpdir(), "named-target-"));
  try {
    const f = writeJson(d, "snap.json", {
      ok: false,
      command: "snapshot",
      error: { message: "WINDOW_NOT_FOUND", name: "标记完成.txt", details: { name: "标记完成.txt" } },
      data: { tree: { name: "标记完成.txt", role: "label", children: [] } },
    });
    const r = main(["--name", "标记完成.txt", "--snapshot", f]);
    assert.equal(r.code, 1);
    assert.equal(targetVisible("标记完成.txt", [JSON.parse(readFileSync(f, "utf8"))]), false);
    assert.match(r.text, /unreadable: 标记完成\.txt/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a failed find envelope is not a hit even if the queried name is echoed", () => {
  const d = mkdtempSync(join(tmpdir(), "named-target-"));
  try {
    const f = writeJson(d, "find.json", {
      ok: false,
      command: "find",
      name: "标记完成.txt",
      error: { message: "APP_NOT_FOUND", details: { name: "标记完成.txt" } },
      data: { match: { name: "标记完成.txt", ref_id: "@s1:e1" } },
    });
    const r = main(["--name", "标记完成.txt", "--find", f]);
    assert.equal(r.code, 1);
    assert.equal(targetVisible("标记完成.txt", [JSON.parse(readFileSync(f, "utf8"))]), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a name only in snapshot metadata or window fields is not visible", () => {
  const d = mkdtempSync(join(tmpdir(), "named-target-"));
  try {
    const f = writeJson(d, "snap.json", {
      ok: true,
      command: "snapshot",
      name: "标记完成.txt",
      data: {
        app: "标记完成.txt",
        window: { id: "w-1", title: "native-doc - Thunar", name: "标记完成.txt" },
        tree: { name: "native-doc - Thunar", role: "window", children: [{ role: "cell", name: "Places" }] },
      },
    });
    const r = main(["--name", "标记完成.txt", "--snapshot", f]);
    assert.equal(r.code, 1);
    assert.equal(targetVisible("标记完成.txt", [JSON.parse(readFileSync(f, "utf8"))]), false);
    assert.match(r.text, /name not in snapshot tree/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("an ok find envelope is visible only from data.match.name", () => {
  const d = mkdtempSync(join(tmpdir(), "named-target-"));
  try {
    const f = writeJson(d, "find.json", {
      ok: true,
      command: "find",
      data: { match: { name: "标记完成.txt", role: "label", ref_id: "@s1:e1" }, snapshot_id: "s1" },
    });
    const r = main(["--name", "标记完成.txt", "--find", f]);
    assert.equal(r.code, 0);
    assert.match(r.text, /visible: 标记完成\.txt/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
