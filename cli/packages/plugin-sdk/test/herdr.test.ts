import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { herdrAgents, herdrStateOf, locateHerdr, parseAgentList, reportRunToHerdr } from "@mola/plugin-sdk";

// The shape `herdr agent list` prints, from the API schema bundled with herdr 0.9.5 (success_response: agent_list, AgentInfo).
const LIST = JSON.stringify({
  id: "cli:agent:list",
  result: {
    type: "agent_list",
    agents: [
      { terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", focused: true, revision: 3, agent_status: "working", agent: "claude", display_agent: "Claude Code", name: "builder", cwd: "E:/mslave", title: "fix the bug" },
      { terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p2", focused: false, revision: 1, agent_status: "blocked", agent: "codex", name: null, cwd: null, title: "needs \u001b[2Jyou" },
      { terminal_id: "t3", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p3", focused: false, revision: 1, agent_status: "sleeping" },
      { not: "an agent" },
    ],
  },
});

test("parseAgentList: agents with their status; odd entries dropped; text cleaned", () => {
  const s = parseAgentList(LIST);
  assert.equal(s.state, "running");
  if (s.state !== "running") return;
  assert.equal(s.agents.length, 3);
  assert.deepEqual(s.agents[0], { pane: "w1:p1", workspace: "w1", name: "builder", agent: "Claude Code", status: "working", cwd: "E:/mslave", title: "fix the bug" });
  assert.equal(s.agents[1].agent, "codex");
  assert.equal(s.agents[1].title, "needs  [2Jyou");
  assert.equal(s.agents[2].status, "unknown");
});

test("parseAgentList: a stopped server, another error, and output that is not JSON", () => {
  assert.deepEqual(parseAgentList('{"id":"cli:agent:list","error":{"code":"server_not_running","message":"no herdr server is running"}}'), { state: "stopped" });
  assert.deepEqual(parseAgentList('{"error":{"code":"denied","message":"nope"}}'), { state: "error", message: "nope" });
  assert.equal(parseAgentList("panic").state, "error");
  assert.equal(parseAgentList('{"result":{"type":"pane_list","panes":[]}}').state, "error");
});

test("herdrAgents: absent when herdr is not installed; runs the CLI it finds", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mola-herdr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(herdrAgents({ PATH: dir } as NodeJS.ProcessEnv), { state: "absent" });
  // a stand-in herdr: a node script behind the platform's launcher
  const js = path.join(dir, "fake.js");
  fs.writeFileSync(js, `process.stdout.write(${JSON.stringify(LIST)})`);
  let bin: string;
  if (process.platform === "win32") {
    bin = path.join(dir, "herdr.exe");
    fs.copyFileSync(process.execPath, bin); // a real executable; it is given the script through HERDR_BIN_PATH below
  } else {
    bin = path.join(dir, "herdr");
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}"\n`);
    fs.chmodSync(bin, 0o755);
  }
  assert.equal(locateHerdr({ PATH: dir } as NodeJS.ProcessEnv), bin);
  if (process.platform !== "win32") {
    const s = herdrAgents({ PATH: dir } as NodeJS.ProcessEnv);
    assert.equal(s.state, "running");
  }
});

test("herdrStateOf: working, blocked, idle", () => {
  assert.equal(herdrStateOf({ status: "running" }), "working");
  assert.equal(herdrStateOf({ status: "blocked" }), "blocked");
  for (const s of ["done", "failed", "stopped"] as const) assert.equal(herdrStateOf({ status: s }), "idle");
});

test("reportRunToHerdr: only inside a herdr pane; the report herdr documents", () => {
  const calls: Array<[string, string[]]> = [];
  const launch = (bin: string, args: string[]): void => void calls.push([bin, args]);
  const run = { status: "blocked" as const, intent: "ship it", stage: "ship" as const, blocked: { reason: "approve the push\u001b[2J" } };
  assert.equal(reportRunToHerdr(run, {} as NodeJS.ProcessEnv, launch), false);
  assert.equal(reportRunToHerdr(run, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" } as NodeJS.ProcessEnv, launch), false);
  assert.equal(calls.length, 0);
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_BIN_PATH: "/opt/herdr" } as NodeJS.ProcessEnv;
  assert.equal(reportRunToHerdr(run, env, launch), true);
  const [bin, args] = calls[0];
  assert.equal(bin, "/opt/herdr");
  assert.deepEqual(args.slice(0, 9), ["pane", "report-agent", "w1:p2", "--source", "mstack", "--agent", "mola", "--state", "blocked"]);
  assert.equal(args[9], "--seq");
  assert.ok(Number(args[10]) > 1.7e12);
  assert.deepEqual(args.slice(11), ["--message", "approve the push [2J"]);
  reportRunToHerdr({ status: "running", intent: "fix the bug", stage: "implement" }, env, launch);
  assert.deepEqual(calls[1][1].slice(7, 9), ["--state", "working"]);
  assert.equal(calls[1][1][12], "implement: fix the bug");
});
