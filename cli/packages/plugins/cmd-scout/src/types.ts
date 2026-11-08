/** Shared types and the injected dependencies of `mola scout` (FRAMEWORK §13.5). */

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** process exit code; 127 when the binary is missing, 124 on timeout */
  code: number;
}
export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}
export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponse>;

export type ModelRunner = (prompt: string, opts: { kind: string; cwd: string }) => Promise<string>;

export interface ScoutDeps {
  exec: ExecFn;
  fetch: FetchFn;
  clock: () => Date;
  model: ModelRunner;
  /** 4 hex chars for the run id; injectable for tests */
  randHex?: () => string;
}

export interface ScoutOptions {
  /** working directory; relative paths resolve against it (default process.cwd()) */
  cwd?: string;
  /** repo searched by the local channel (default cwd) */
  repo?: string;
  /** extra sibling repos (config `scout.roots`) */
  roots?: string[];
  limit?: number;
  /** false = --no-clone */
  clone?: boolean;
  /** false = --no-llm */
  llm?: boolean;
  out?: string;
  /** home dir holding .mola/cache (default os.homedir()) */
  homeDir?: string;
  /** path of starred.tsv; searched upward from cwd when absent */
  seedTsv?: string;
  /** per-channel timeout in ms (default 25000) */
  timeoutMs?: number;
}

export type Source = "local" | "stars" | "github-repos" | "github-code" | "npm" | "crates";
export type LicenseClass = "ok" | "note" | "flag";

export interface HarvestFile {
  path: string;
  lines: number | null;
  /** first line mentioning a query word */
  hitLine?: number;
  excerpt?: string;
}
export interface Harvest {
  dir?: string;
  files: HarvestFile[];
  note?: string;
}

export interface Candidate {
  /** dedupe key: `owner/name` (lowercase) for repos, `npm:x` / `crates:x` for packages, `local:<path>` */
  key: string;
  kind: "local" | "repo" | "package";
  name: string;
  url: string;
  sources: Source[];
  stars?: number;
  /** package downloads / popularity note */
  popularity?: string;
  pushedAt?: string;
  license?: string;
  licenseClass: LicenseClass;
  /** false when the license is flagged: never auto-"adapt" */
  adaptable: boolean;
  starred: boolean;
  sizeKB?: number;
  description?: string;
  why: string[];
  /** local hits: file:line */
  hits?: string[];
  /** owner/name of the GitHub repo behind a package, when known */
  repo?: string;
  score: number;
  harvest?: Harvest;
}

export interface ChannelReport {
  channel: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
}

export interface ScoutResult {
  id: string;
  need: string;
  dir: string;
  reusePath: string;
  candidatesPath: string;
  queries: string[];
  candidates: Candidate[];
  channels: ChannelReport[];
  decision: { status: "pending" | "decided" | "failed"; text: string };
  summary: string[];
}
