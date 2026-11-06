/**
 * api.test.ts — the Management API client. HTTP is fully mocked; no request
 * leaves the process. Asserts the one non-negotiable fact of
 * cli/design/inputs/superagent-ops.md: every request carries
 * `x-orchestrator-request: 1`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SuperagentApi, ORCHESTRATOR_HEADER } from "../src/api.js";
import { errOf, makeFakeFetch } from "./fake.js";
import { SAMPLE_SOURCES_JSON, SAMPLE_STATE_SETUP_JSON } from "./fixtures.js";

const BASE = "http://127.0.0.1:3082";

function client(http = makeFakeFetch()): { api: SuperagentApi; http: typeof http } {
  return { api: new SuperagentApi({ baseUrl: BASE, fetch: http.fetch }), http };
}

test("state: GET /orchestrator/api/state with the orchestrator header, parsed JSON", async () => {
  const { api, http } = client(makeFakeFetch({ respond: () => ({ body: SAMPLE_STATE_SETUP_JSON }) }));
  const state = await api.state();
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0].url, `${BASE}/orchestrator/api/state`);
  assert.equal(http.requests[0].method, "GET");
  assert.equal(http.requests[0].headers?.[ORCHESTRATOR_HEADER], "1");
  assert.equal(state.setup?.problem?.code, "repositoryUnset");
  assert.equal(state.load?.maxWorkers, 3);
  assert.equal(state.paused, false);
  assert.equal(state.health?.github?.state, "paused");
});

test("sources: GET /orchestrator/api/sources, parsed array", async () => {
  const { api, http } = client(makeFakeFetch({ respond: () => ({ body: SAMPLE_SOURCES_JSON }) }));
  const sources = await api.sources();
  assert.equal(http.requests[0].url, `${BASE}/orchestrator/api/sources`);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((s) => s.id), ["feishu", "github"]);
  assert.equal(sources[1].state, "error");
  assert.equal(sources[1].problem?.detail, "The GitHub Source names no repository.");
});

test("setPaused: POST /executor/pause with the JSON body {paused:true|false}", async () => {
  const { api, http } = client();
  await api.setPaused(true);
  await api.setPaused(false);
  const [pause, resume] = http.requests;
  assert.equal(pause.url, `${BASE}/orchestrator/api/executor/pause`);
  assert.equal(pause.method, "POST");
  assert.equal(pause.headers?.[ORCHESTRATOR_HEADER], "1");
  assert.equal(pause.headers?.["content-type"], "application/json");
  assert.deepEqual(JSON.parse(pause.body!), { paused: true });
  assert.deepEqual(JSON.parse(resume.body!), { paused: false });
});

test("retryTicket / stopTicket: POST /tickets/<id>/{retry,stop}, id URI-encoded", async () => {
  const { api, http } = client();
  await api.retryTicket("t 1/2");
  await api.stopTicket("abc");
  assert.equal(http.requests[0].url, `${BASE}/orchestrator/api/tickets/t%201%2F2/retry`);
  assert.equal(http.requests[0].method, "POST");
  assert.equal(http.requests[0].headers?.[ORCHESTRATOR_HEADER], "1");
  assert.equal(http.requests[1].url, `${BASE}/orchestrator/api/tickets/abc/stop`);
});

test("HTTP 404/500 → MolaError UPSTREAM_UNAVAILABLE, exit 69", async () => {
  const { api } = client(makeFakeFetch({ respond: () => ({ status: 404, body: "no such ticket" }) }));
  const err = errOf(await api.retryTicket("nope").then(() => null, (e) => e));
  assert.equal(err.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(err.exitCode, 69);
  assert.match(err.message, /HTTP 404/);
  assert.match(err.message, /no such ticket/);
});

test("connection refused (fetch throws) → UPSTREAM_UNAVAILABLE, exit 69", async () => {
  const { api } = client(
    makeFakeFetch({ respond: () => ({ throw: new Error("connect ECONNREFUSED 127.0.0.1:3082") }) }),
  );
  const err = errOf(await api.state().then(() => null, (e) => e));
  assert.equal(err.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(err.exitCode, 69);
  assert.match(err.message, /ECONNREFUSED/);
});

test("non-JSON body → UPSTREAM_UNAVAILABLE with the offending text", async () => {
  const { api } = client(makeFakeFetch({ respond: () => ({ status: 200, body: "<html>bot</html>" }) }));
  const err = errOf(await api.state().then(() => null, (e) => e));
  assert.equal(err.code, "UPSTREAM_UNAVAILABLE");
  assert.match(err.message, /did not return JSON/);
});

test("baseUrl trailing slashes are trimmed; default fetch is globalThis.fetch", async () => {
  const api = new SuperagentApi({ baseUrl: `${BASE}/` });
  assert.equal(api.baseUrl, BASE);
});
