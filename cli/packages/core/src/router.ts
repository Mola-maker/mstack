/**
 * Command router (core §2.3). Commands are namespaced paths registered by
 * plugins; longest path wins; aliases are config, not code. Handlers return an
 * ExitCode and never call process.exit. The router owns the --json envelope
 * (core §8.2): one document on stdout, diagnostics on stderr.
 */

import type { Command, Disposer, EventBus, Io, ParsedArgs } from "@mola/plugin-sdk";
import {
  MolaError,
  MolaEvents,
  ExitCode,
  banner,
  detectColor,
  formatValue,
  palette,
  parseArgv,
  table,
  toMolaError,
} from "@mola/plugin-sdk";

export interface RegisteredCommand extends Command {
  owner: string;
}

/** Help sections, in display order. Unknown first-tokens fall into "Other". */
const HELP_GROUP_ORDER = ["Overview", "Run a task", "Agents", "Models", "Superagent", "Tools", "Setup"] as const;

const HELP_GROUP_OF: Record<string, (typeof HELP_GROUP_ORDER)[number]> = {
  dash: "Overview",
  doctor: "Overview",
  version: "Overview",
  run: "Run a task",
  dispatch: "Run a task",
  think: "Run a task",
  plan: "Run a task",
  goal: "Run a task",
  team: "Run a task",
  review: "Run a task",
  ship: "Run a task",
  agents: "Agents",
  runs: "Agents",
  hooks: "Agents",
  model: "Models",
  superagent: "Superagent",
  rtk: "Tools",
  plugin: "Setup",
  config: "Setup",
  completions: "Setup",
  skills: "Setup",
};

export interface RouterOptions {
  bus?: EventBus;
  traceId: string;
}

/** Io implementation; the router calls finish() after the handler returns. */
export class IoImpl implements Io {
  private result: { set: boolean; value?: unknown } = { set: false };
  /** true once the handler printed its own human line (so finish() stays quiet) */
  private wroteHuman = false;
  commandPath = "";

  constructor(
    readonly json: boolean,
    readonly quiet: boolean,
    readonly traceId: string,
    readonly cwd: string,
    readonly yes: boolean,
  ) {}

  data(value: unknown): void {
    this.result = { set: true, value };
  }

  out(line: string): void {
    this.wroteHuman = true;
    // --json mode: stdout carries only the envelope; human output goes to stderr
    if (this.json) process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }

  note(message: string): void {
    if (this.quiet) return;
    process.stderr.write(message + "\n");
  }

  error(err: unknown): void {
    const e = toMolaError(err);
    if (this.json) {
      // stdout stays clean; one error document on stderr (core §8.2)
      process.stderr.write(
        JSON.stringify({
          schemaVersion: 1,
          traceId: this.traceId,
          error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) },
        }) + "\n",
      );
    } else {
      process.stderr.write(`mola: ${e.code}: ${e.message}\n`);
    }
  }

  finish(): void {
    if (!this.result.set) return;
    if (this.json) {
      process.stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          command: this.commandPath,
          traceId: this.traceId,
          data: this.result.value ?? null,
        }) + "\n",
      );
      return;
    }
    // the handler already spoke; don't dump data after it (and never as JSON)
    if (this.wroteHuman) return;
    const text = formatValue(this.result.value);
    if (text.length > 0) process.stdout.write(text + "\n");
  }
}

export class CommandRouter {
  private commands = new Map<string, RegisteredCommand>();

  constructor(private readonly opts: RouterOptions) {}

  private key(path: string[]): string {
    return path.join(" ");
  }

  register(command: Command, owner: string): Disposer {
    const key = this.key(command.path);
    const existing = this.commands.get(key);
    if (existing) {
      // plan-time conflict (core §2.3) — explicit overrides arrive with
      // third-party plugin support in B2; throwing here quarantines the plugin
      throw new MolaError(
        "COMMAND_CONFLICT",
        `command "${key}" is already registered by ${existing.owner} (${owner} must declare overrides)`,
        ExitCode.DataErr,
      );
    }
    this.commands.set(key, { ...command, owner });
    return () => {
      this.commands.delete(key);
    };
  }

  list(): RegisteredCommand[] {
    return [...this.commands.values()].sort((a, b) => this.key(a.path).localeCompare(this.key(b.path)));
  }

  /** Longest registered path prefix over leading positional tokens. */
  resolve(tokens: string[]): { command: RegisteredCommand; rest: string[] } | undefined {
    const leading: string[] = [];
    for (const t of tokens) {
      if (t.startsWith("-")) break;
      leading.push(t);
    }
    for (let len = Math.min(leading.length, this.maxDepth()); len >= 1; len--) {
      const hit = this.commands.get(leading.slice(0, len).join(" "));
      if (hit) return { command: hit, rest: tokens.slice(len) };
    }
    return undefined;
  }

  private maxDepth(): number {
    let max = 0;
    for (const c of this.commands.values()) max = Math.max(max, c.path.length);
    return max;
  }

  help(): string {
    // color is decoration: a pipe or NO_COLOR gets the plain banner and table
    const p = palette(detectColor());
    const groups = new Map<string, RegisteredCommand[]>();
    for (const title of HELP_GROUP_ORDER) groups.set(title, []);
    for (const c of this.list()) {
      const title = HELP_GROUP_OF[c.path[0]] ?? "Other";
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title)!.push(c);
    }
    const lines: string[] = [
      banner(p),
      "",
      "usage: mola [--json] [-v…] [-q] [--config <path>] [--cwd <dir>] [--no-color] [--yes] <command> [args]",
      "",
    ];
    for (const title of [...HELP_GROUP_ORDER, "Other"]) {
      const cmds = groups.get(title);
      if (!cmds || cmds.length === 0) continue;
      lines.push(p.bold(title));
      lines.push(
        ...table({
          rows: cmds.map((c) => [this.key(c.path), c.description]),
          indent: "  ",
        }),
        "",
      );
    }
    lines.push(p.bold("examples"));
    lines.push("  mola doctor");
    lines.push('  mola run "count TODOs in README.md"');
    lines.push("  mola dash");
    return lines.join("\n");
  }

  async dispatch(argv: string[], io: IoImpl, aliases: Record<string, string> = {}): Promise<ExitCode> {
    let tokens = [...argv];
    if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "--help" || tokens[0] === "-h") {
      process.stdout.write(this.help() + "\n");
      return ExitCode.Ok;
    }
    // aliases are config, not code (core §2.3) — rewrite the leading token once
    const alias = aliases[tokens[0]];
    if (typeof alias === "string" && alias.trim()) {
      tokens = [...alias.trim().split(/\s+/), ...tokens.slice(1)];
    }

    const hit = this.resolve(tokens);
    if (!hit) {
      const err = new MolaError(
        "COMMAND_NOT_FOUND",
        `unknown command: ${tokens.join(" ")} (run "mola help")`,
        ExitCode.Usage,
      );
      io.error(err);
      return err.exitCode;
    }

    const { command, rest } = hit;
    const pathStr = this.key(command.path);
    io.commandPath = pathStr;
    const args: ParsedArgs = parseArgv(rest);

    this.opts.bus?.emit(MolaEvents.CommandStarted, { traceId: this.opts.traceId, path: pathStr, argv: rest });
    const t0 = Date.now();
    try {
      const code = await command.handler(args, io);
      this.opts.bus?.emit(MolaEvents.CommandEnded, {
        traceId: this.opts.traceId,
        path: pathStr,
        exitCode: code,
        durationMs: Date.now() - t0,
      });
      io.finish();
      return code;
    } catch (err) {
      const e = toMolaError(err);
      this.opts.bus?.emit(MolaEvents.CommandEnded, {
        traceId: this.opts.traceId,
        path: pathStr,
        exitCode: e.exitCode,
        durationMs: Date.now() - t0,
        error: e.code,
      });
      io.error(err);
      return e.exitCode;
    }
  }
}
