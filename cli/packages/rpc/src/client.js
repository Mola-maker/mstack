/**
 * JSON-RPC 2.0 NDJSON stdio client (ADR-0001) — client half only.
 *
 * Framing: newline-delimited JSON, one message per line, UTF-8. Handshake:
 * `mola.hello {protocolVersion: 1, host: "mola@<ver>"}` → sidecar answers with
 * name/version/capabilities; a major-version mismatch is reported by the caller
 * as exit 69. The server half and supervision arrive with the sidecars (B3).
 */
import { spawn } from "node:child_process";
export const PROTOCOL_VERSION = 1;
export class RpcError extends Error {
    rpcCode;
    data;
    constructor(rpcCode, message, data) {
        super(message);
        this.rpcCode = rpcCode;
        this.data = data;
        this.name = "RpcError";
    }
}
export class JsonRpcClient {
    proc;
    nextId = 1;
    pending = new Map();
    buffer = "";
    notifyQueue = [];
    notifyWaiters = [];
    closed = false;
    /** @param proc a spawned child process with piped stdio */
    constructor(proc) {
        this.proc = proc;
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk) => this.onData(chunk));
        proc.on("close", () => {
            this.closed = true;
            for (const p of this.pending.values()) {
                p.reject(new Error("sidecar exited with a pending request"));
            }
            this.pending.clear();
            this.pushNotification(null);
        });
    }
    static spawn(command, args = [], opts = {}) {
        const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], ...opts });
        return new JsonRpcClient(proc);
    }
    onData(chunk) {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line)
                this.onMessage(line);
        }
    }
    onMessage(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return; // malformed line: ignore (NDJSON framing keeps the stream alive)
        }
        if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
            const p = this.pending.get(msg.id);
            if (!p)
                return;
            this.pending.delete(msg.id);
            if (msg.error)
                p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
            else
                p.resolve(msg.result);
        }
        else if (typeof msg.method === "string") {
            this.pushNotification(msg);
        }
    }
    pushNotification(n) {
        const waiter = this.notifyWaiters.shift();
        if (waiter)
            waiter(n);
        else if (n)
            this.notifyQueue.push(n);
    }
    call(method, params) {
        if (this.closed)
            return Promise.reject(new Error("client is closed"));
        const id = this.nextId++;
        const req = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
        return new Promise((resolvePromise, rejectPromise) => {
            this.pending.set(id, {
                resolve: resolvePromise,
                reject: rejectPromise,
            });
            this.proc.stdin.write(JSON.stringify(req) + "\n");
        });
    }
    notify(method, params) {
        const msg = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
        this.proc.stdin.write(JSON.stringify(msg) + "\n");
    }
    /** Server→client notifications (PTY output, sync progress) as a stream. */
    async *notifications() {
        while (true) {
            const n = this.notifyQueue.length
                ? this.notifyQueue.shift()
                : await new Promise((r) => this.notifyWaiters.push(r));
            if (n === null)
                return;
            yield n;
        }
    }
    /** mola.hello handshake (ADR-0001). Mismatch on major version ⇒ caller reports exit 69. */
    async hello(host) {
        const result = await this.call("mola.hello", {
            protocolVersion: PROTOCOL_VERSION,
            host,
        });
        const major = (result.protocolVersion ?? PROTOCOL_VERSION) | 0;
        if (major !== PROTOCOL_VERSION) {
            throw new RpcError(-32000, `protocol version mismatch: host ${PROTOCOL_VERSION}, sidecar ${result.protocolVersion} — reinstall/upgrade mola`);
        }
        return result;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.proc.kill();
        }
        catch {
            /* already gone */
        }
    }
}
