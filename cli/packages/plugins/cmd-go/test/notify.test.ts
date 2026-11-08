import test from "node:test";
import assert from "node:assert/strict";
import { headerSafe, maskUrl, sendNotify, type FetchLike } from "../src/notify.js";
import { fakeAgent, makeCtx } from "./helpers.js";

const SECRET = "https://ntfy.example.org/my-very-secret-topic-123";

test("maskUrl hides the path (the secret) and the query", () => {
  assert.equal(maskUrl(SECRET), "https://ntfy.example.org/***");
  assert.equal(maskUrl("https://u:p@h.example/hook/abc?token=zzz"), "https://h.example/***");
  assert.equal(maskUrl("not a url"), "<invalid url>");
});

test("no channel configured: stderr only, nothing fetched", async () => {
  const f = makeCtx([fakeAgent()]);
  const err: string[] = [];
  let fetched = 0;
  const res = await sendNotify(f.ctx, { text: "hello" }, { stderr: (l) => err.push(l), fetch: async () => (fetched++, { ok: true, status: 200 }) });
  assert.equal(fetched, 0);
  assert.deepEqual(res.channels, []);
  assert.match(err.join("\n"), /hello/);
});

test("ntfy: POST the text with a Title header; webhook: JSON {title,text}; the topic never reaches stderr", async () => {
  const f = makeCtx([fakeAgent()], { "notify.ntfy": SECRET, "notify.webhook": "https://hooks.example/h/secret-token" });
  const err: string[] = [];
  const seen: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const res = await sendNotify(f.ctx, { text: "run blocked", title: "mola go" }, {
    stderr: (l) => err.push(l),
    fetch: async (url, init) => (seen.push({ url, init }), { ok: true, status: 200 }),
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, SECRET);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, "run blocked");
  assert.equal(seen[0].init.headers?.Title, "mola go");
  assert.deepEqual(JSON.parse(seen[1].init.body), { title: "mola go", text: "run blocked" });
  assert.ok(res.channels.every((c) => c.ok));
  const all = err.join("\n") + JSON.stringify(res);
  assert.ok(!all.includes("my-very-secret-topic-123"));
  assert.ok(!all.includes("secret-token"));
});

test("network error: warn (masked), no throw", async () => {
  const f = makeCtx([fakeAgent()], { "notify.ntfy": SECRET });
  const err: string[] = [];
  const res = await sendNotify(f.ctx, { text: "x" }, {
    stderr: (l) => err.push(l),
    fetch: async () => {
      throw new Error(`connect ECONNREFUSED ${SECRET}`);
    },
  });
  assert.equal(res.channels[0].ok, false);
  const all = err.join("\n") + JSON.stringify(res);
  assert.match(all, /warning/);
  assert.ok(!all.includes("my-very-secret-topic-123"), all);
});

test("HTTP error status is a warning, not a failure", async () => {
  const f = makeCtx([fakeAgent()], { "notify.ntfy": SECRET });
  const err: string[] = [];
  const res = await sendNotify(f.ctx, { text: "x" }, { stderr: (l) => err.push(l), fetch: async () => ({ ok: false, status: 503 }) });
  assert.equal(res.channels[0].ok, false);
  assert.match(err.join("\n"), /HTTP 503/);
});

test("non-ASCII titles are RFC 2047 encoded for the Title header", () => {
  assert.equal(headerSafe("plain"), "plain");
  const enc = headerSafe("需要审批");
  assert.match(enc, /^=\?UTF-8\?B\?.+\?=$/);
  assert.equal(Buffer.from(enc.slice(10, -2), "base64").toString("utf8"), "需要审批");
});
