/**
 * JSON-RPC 2.0 NDJSON stdio client (ADR-0001) — client half only.
 *
 * Framing: newline-delimited JSON, one message per line, UTF-8. Handshake:
 * `mola.hello {protocolVersion: 1, host: "mola@<ver>"}` → sidecar answers with
 * name/version/capabilities; a major-version mismatch is reported by the caller
 * as exit 69. The server half and supervision arrive with the sidecars (B3).
 */
export declare const PROTOCOL_VERSION = 1;
export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: unknown;
}
export interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}
export interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}
export declare class RpcError extends Error {
    readonly rpcCode: number;
    readonly data?: unknown | undefined;
    constructor(rpcCode: number, message: string, data?: unknown | undefined);
}
export interface HelloResult {
    name: string;
    version: string;
    capabilities: string[];
    protocolVersion?: number;
}
export declare class JsonRpcClient {
    private readonly proc;
    private nextId;
    private pending;
    private buffer;
    private notifyQueue;
    private notifyWaiters;
    private closed;
    /** @param proc a spawned child process with piped stdio */
    constructor(proc: any);
    static spawn(command: string, args?: string[], opts?: Record<string, unknown>): JsonRpcClient;
    private onData;
    private onMessage;
    private pushNotification;
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
    notify(method: string, params?: unknown): void;
    /** Server→client notifications (PTY output, sync progress) as a stream. */
    notifications(): AsyncGenerator<JsonRpcNotification, void, void>;
    /** mola.hello handshake (ADR-0001). Mismatch on major version ⇒ caller reports exit 69. */
    hello(host: string): Promise<HelloResult>;
    close(): void;
}
