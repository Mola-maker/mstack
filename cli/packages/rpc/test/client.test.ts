import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { JsonRpcClient } from "@mola/rpc";

/** A fake sidecar: NDJSON echo server with a mola.hello handshake and one notification. */
function fakeSidecar(): JsonRpcClient {
  const script = `
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue; // notification: no reply
        if (msg.method === "mola.hello") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "sidecar.ready" }) + "\\n");
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { name: "fake-sidecar", version: "0.0.1", protocolVersion: 1, capabilities: ["echo"] },
          }) + "\\n");
        } else if (msg.method === "fail") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "boom", data: msg.params },
          }) + "\\n");
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.params ?? null }) + "\\n");
        }
      }
    });
  `;
  const proc = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
  return new JsonRpcClient(proc);
}

test("rpc: hello handshake + call/echo + notification stream + error mapping", async () => {
  const client = fakeSidecar();
  try {
    const hello = await client.hello("mola@0.1.0");
    assert.equal(hello.name, "fake-sidecar");
    assert.deepEqual(hello.capabilities, ["echo"]);

    const echo = await client.call("env.exec", { cmd: "ls" });
    assert.deepEqual(echo, { cmd: "ls" });

    await assert.rejects(
      () => client.call("fail", { x: 1 }),
      (err: any) => err.name === "RpcError" && err.rpcCode === -32001 && err.message === "boom",
    );

    // the ready notification arrived during hello; drain the stream
    const it = client.notifications();
    const first = await it.next();
    assert.equal(first.value?.method, "sidecar.ready");
  } finally {
    client.close();
  }
});
