import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  approvalPath,
  readApproval,
  runDir,
  writeApproval,
  writeProgress,
  type RunProgress,
} from "@mola/plugin-sdk";
import { startWeb, type WebServer } from "@mola/plugin-cmd-web";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mola-web-"));
}

function run(cwd: string, id: string, extra: Partial<RunProgress> = {}): RunProgress {
  const now = new Date().toISOString();
  const p: RunProgress = {
    schemaVersion: 1,
    id,
    intent: "fix the bug",
    cwd,
    status: "running",
    startedAt: now,
    updatedAt: now,
    stage: "implement",
    stages: [
      { name: "plan", status: "done", costUsd: 0.1, artifact: "plan.md" },
      { name: "implement", status: "running", costUsd: 0.2 },
    ],
    workers: [{ id: "w1", stage: "implement", status: "working", model: "sonnet", startedAt: now, lastLine: "editing" }],
    costUsd: 0,
    ...extra,
  };
  writeProgress(p);
  return p;
}

async function get(base: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const r = await fetch(base + p, { headers });
  return { status: r.status, body: await r.text() };
}

async function post(base: string, p: string, body: string, type = "application/json"): Promise<{ status: number; body: string }> {
  const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": type }, body });
  return { status: r.status, body: await r.text() };
}

async function withWeb(
  opts: Parameters<typeof startWeb>[0],
  fn: (w: WebServer, base: string) => Promise<void>,
): Promise<void> {
  const w = await startWeb({ port: 0, ...opts });
  try {
    await fn(w, `http://127.0.0.1:${w.port}`);
  } finally {
    await w.close();
  }
}

test("GET / serves the page; /api/runs lists runs tagged with cwd", async () => {
  const cwd = tmp();
  run(cwd, "r1");
  await withWeb({ cwds: [cwd] }, async (_w, base) => {
    const page = await get(base, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<meta name="viewport"/);
    assert.match(page.body, /prefers-color-scheme:dark/);
    const runs = JSON.parse((await get(base, "/api/runs")).body) as Array<{ id: string; cwd: string }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "r1");
    assert.equal(runs[0].cwd, path.resolve(cwd));
  });
});

test("GET /api/runs/:id returns progress plus artifact and events tails", async () => {
  const cwd = tmp();
  run(cwd, "r1");
  const dir = runDir(cwd, "r1");
  fs.writeFileSync(path.join(dir, "plan.md"), Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "events.jsonl"), '{"a":1}\n{"a":2}\n');
  await withWeb({ cwds: [cwd] }, async (_w, base) => {
    const r = JSON.parse((await get(base, "/api/runs/r1")).body) as {
      progress: { id: string };
      artifacts: Record<string, string[]>;
      events: string[];
    };
    assert.equal(r.progress.id, "r1");
    assert.equal(r.artifacts["plan.md"].length, 40);
    assert.equal(r.artifacts["plan.md"][39], "line 99");
    assert.deepEqual(r.events, ['{"a":1}', '{"a":2}']);
    assert.equal((await get(base, "/api/runs/nope")).status, 404);
  });
});

test("SSE sends the run, then an update after the file changes", async () => {
  const cwd = tmp();
  const p = run(cwd, "r1");
  await withWeb({ cwds: [cwd], pollMs: 50 }, async (w) => {
    const events: Array<{ intent: string; costUsd: number }> = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: w.port, path: "/api/stream" }, (res) => {
        assert.match(String(res.headers["content-type"]), /text\/event-stream/);
        let buf = "";
        res.on("data", (c: Buffer) => {
          buf += c.toString();
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            if (!part.startsWith("event: run")) continue;
            events.push(JSON.parse(part.split("\ndata: ")[1]));
            if (events.length === 1) {
              p.stages[1].costUsd = 5;
              setTimeout(() => writeProgress(p), 20);
            } else {
              req.destroy();
              resolve();
            }
          }
        });
      });
      req.on("error", (e) => (events.length >= 2 ? resolve() : reject(e)));
      setTimeout(() => reject(new Error("timeout")), 5000).unref();
    });
    assert.equal(events.length, 2);
    assert.ok(events[1].costUsd > events[0].costUsd);
  });
});

test("SSE sends heartbeat comments", async () => {
  const cwd = tmp();
  await withWeb({ cwds: [cwd], heartbeatMs: 30 }, async (w) => {
    const got = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: w.port, path: "/api/stream" }, (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => {
          buf += c.toString();
          if (buf.includes(": heartbeat")) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on("error", () => {});
      setTimeout(() => reject(new Error("timeout")), 3000).unref();
    });
    assert.match(got, /: heartbeat/);
  });
});

test("off-loopback host requires a token; loopback does not", async () => {
  await assert.rejects(() => startWeb({ port: 0, host: "0.0.0.0", cwds: [tmp()] }), /requires --token/);
  const w = await startWeb({ port: 0, host: "0.0.0.0", token: "t0k", cwds: [tmp()] });
  await w.close();
  const lb = await startWeb({ port: 0, cwds: [tmp()] });
  assert.equal(lb.token, undefined);
  await lb.close();
});

test("with a token every /api route checks it; bad token is 401", async () => {
  const cwd = tmp();
  run(cwd, "r1");
  await withWeb({ token: "sekret", cwds: [cwd] }, async (_w, base) => {
    assert.equal((await get(base, "/")).status, 200);
    for (const p of ["/api/runs", "/api/runs/r1", "/api/stream"]) {
      assert.equal((await get(base, p)).status, 401, p);
      assert.equal((await get(base, `${p}?token=wrong`)).status, 401, p);
    }
    assert.equal((await post(base, "/api/runs/r1/stop", "{}")).status, 401);
    assert.equal((await get(base, "/api/runs?token=sekret")).status, 200);
    assert.equal((await get(base, "/api/runs", { Authorization: "Bearer sekret" })).status, 200);
    assert.equal((await get(base, "/api/runs", { Authorization: "Bearer nope" })).status, 401);
  });
});

test("traversal ids are rejected; non-JSON POST is rejected", async () => {
  const cwd = tmp();
  run(cwd, "r1");
  await withWeb({ cwds: [cwd] }, async (_w, base) => {
    assert.equal((await get(base, "/api/runs/..%2f..%2fetc")).status, 400);
    assert.equal((await get(base, "/api/runs/a%5Cb")).status, 400);
    assert.equal((await post(base, "/api/runs/..%2fx/stop", "{}")).status, 400);
    assert.equal((await post(base, "/api/runs/r1/approvals/..%2fx", '{"decision":"approve"}')).status, 400);
    assert.equal((await post(base, "/api/runs/r1/stop", "a=b", "application/x-www-form-urlencoded")).status, 415);
    assert.equal((await post(base, "/api/runs/r1/stop", "x", "text/plain")).status, 415);
    assert.equal(fs.existsSync(path.join(runDir(cwd, "r1"), "STOP")), false);
    assert.equal((await post(base, "/api/runs/r1/stop", "{bad")).status, 400);
  });
});

test("approve, deny and stop write the right files", async () => {
  const cwd = tmp();
  run(cwd, "r1", { status: "blocked", blocked: { reason: "push", approvalId: "a1" } });
  const mk = (id: string) =>
    writeApproval(cwd, { id, runId: "r1", stage: "ship", action: "git push origin x", status: "pending", createdAt: new Date().toISOString() });
  mk("a1");
  mk("a2");
  await withWeb({ cwds: [cwd] }, async (_w, base) => {
    const one = JSON.parse((await get(base, "/api/runs")).body) as Array<{ approval?: { action: string } }>;
    assert.equal(one[0].approval?.action, "git push origin x");

    assert.equal((await post(base, "/api/runs/r1/approvals/a1", '{"decision":"approve"}')).status, 200);
    const a1 = readApproval(cwd, "r1", "a1")!;
    assert.equal(a1.status, "approved");
    assert.equal(a1.decidedBy, "web");
    assert.equal((await post(base, "/api/runs/r1/approvals/a1", '{"decision":"deny"}')).status, 409);

    assert.equal((await post(base, "/api/runs/r1/approvals/a2", '{"decision":"deny"}')).status, 200);
    assert.equal(readApproval(cwd, "r1", "a2")!.status, "denied");
    assert.ok(fs.existsSync(approvalPath(cwd, "r1", "a2")));
    assert.equal((await post(base, "/api/runs/r1/approvals/a2", '{"decision":"maybe"}')).status, 400);

    assert.equal((await post(base, "/api/runs/r1/stop", "{}")).status, 200);
    assert.ok(fs.existsSync(path.join(runDir(cwd, "r1"), "STOP")));
    assert.equal((await post(base, "/api/runs/ghost/stop", "{}")).status, 404);
  });
});
