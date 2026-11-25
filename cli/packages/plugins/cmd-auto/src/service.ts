/**
 * `mola service install|status|uninstall`: keep `mola serve` running without a
 * terminal. Linux (and WSL with systemd): a systemd --user unit, with a check for
 * lingering so it survives logout. macOS: a LaunchAgent. Windows: a Task
 * Scheduler task at logon. Variables for the service go in
 * `$MOLA_HOME/service.env` (KEY=VALUE, literal), which install and uninstall keep.
 *
 * install and uninstall print exactly what they will write and run, and do it
 * only with --yes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ServicePlan {
  platform: "systemd" | "launchd" | "schtasks";
  /** file to write, with its content (none for schtasks) */
  file?: { path: string; content: string };
  /** commands to run after writing, as argv arrays */
  commands: string[][];
  /** commands that undo it */
  undo: string[][];
  notes: string[];
}

export const UNIT = "mola-serve";
const LABEL = "dev.mola.serve";

export function molaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOLA_HOME || path.join(os.homedir(), ".mola");
}

/** Read service.env: KEY=VALUE lines, optional quotes, no expansion. */
export function readServiceEnv(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // PATH and the home are the service's own
    if (/^(PATH|MOLA_HOME)$/i.test(m[1])) continue;
    out[m[1]] = v;
  }
  return out;
}

const q = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function planService(o: { platform?: NodeJS.Platform; node: string; entry: string; args: string[]; home?: string; env?: NodeJS.ProcessEnv; uid?: number }): ServicePlan {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? os.homedir();
  const mhome = molaHome(o.env);
  const envFile = path.join(mhome, "service.env");
  const argv = [o.node, o.entry, "serve", ...o.args];
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const vars = { MOLA_HOME: mhome, PATH: o.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin", ...readServiceEnv(envFile) };
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>Label</key><string>${LABEL}</string>`,
      `<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>`,
      `<key>EnvironmentVariables</key><dict>${Object.entries(vars).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>`,
      "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>",
      `<key>StandardErrorPath</key><string>${xml(path.join(mhome, "logs", "serve.log"))}</string>`,
      "</dict></plist>",
      "",
    ].join("\n");
    const target = `gui/${o.uid ?? process.getuid?.() ?? 501}`;
    return {
      platform: "launchd",
      file: { path: file, content },
      commands: [["launchctl", "bootout", `${target}/${LABEL}`], ["launchctl", "bootstrap", target, file]],
      undo: [["launchctl", "bootout", `${target}/${LABEL}`]],
      notes: ["It runs while you are logged in. Keep the Mac awake for unattended work.", "After editing service.env, run install again (launchd has no env file)."],
    };
  }
  if (platform === "win32") {
    const tr = argv.map((a) => (a.includes(" ") ? `\\"${a}\\"` : a)).join(" ");
    return {
      platform: "schtasks",
      commands: [["schtasks", "/Create", "/F", "/TN", UNIT, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", tr], ["schtasks", "/Run", "/TN", UNIT]],
      undo: [["schtasks", "/End", "/TN", UNIT], ["schtasks", "/Delete", "/F", "/TN", UNIT]],
      notes: ["It starts at logon and stops at sign-out: lock the screen instead of signing out.", "service.env is not read on Windows; set user environment variables instead."],
    };
  }
  const file = path.join(o.env?.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", `${UNIT}.service`);
  const content = [
    "[Unit]",
    "Description=mola serve (mstack schedules, webhooks, PR watches)",
    "After=network-online.target",
    "",
    "[Service]",
    `Environment=MOLA_HOME=${mhome}`,
    `Environment=PATH=${o.env?.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    `EnvironmentFile=-${envFile}`,
    `ExecStart=${argv.map(q).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    platform: "systemd",
    file: { path: file, content },
    commands: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${UNIT}.service`], ["systemctl", "--user", "restart", `${UNIT}.service`]],
    undo: [["systemctl", "--user", "disable", "--now", `${UNIT}.service`]],
    notes: [
      'To keep it running after logout: sudo loginctl enable-linger "$(id -un)" (mola service status says whether it is on).',
      "In WSL, systemd must be on (/etc/wsl.conf: [boot] systemd=true).",
    ],
  };
}
