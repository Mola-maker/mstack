/**
 * Conservative approval classifier over the `mola.tool.before` waterfall
 * (DESIGN §9, BRIEF #7): push / merge / publish / destructive delete must pass
 * an approval before they run — deny ⇒ exit 77; `--yes` / `MOLA_YES=1` skips
 * when the policy allows.
 *
 * "Conservative" means deny-biased and coarse: the classifier matches the
 * joined command line (so a `bash -lc '<script>'` wrapper — how cmd-dispatch
 * reaches WSL — is scanned too), and anything matched is held. It may
 * over-match a harmless string; that is the intended failure mode. Unknown
 * commands pass: B1 has no argv inventory beyond the patterns below, and the
 * design explicitly keeps this classifier minimal until the B2 policy file.
 */

export interface ToolCall {
  tool?: string;
  argv?: string[];
  argsSummary?: string;
  callId?: string;
  /** `--yes` / MOLA_YES=1 reached the gate (Io.yes) */
  yes?: boolean;
}

export type ClassifierVerdict =
  | { action: "allow" }
  | { action: "deny"; rule: string; reason: string };

interface Rule {
  rule: string;
  re: RegExp;
  what: string;
}

const RULES: Rule[] = [
  { rule: "git.push", re: /\bgit\s+(?:(?:-\w+\s+\S+|-\S+|--\S+)\s+)*push\b/, what: "git push (outward)" },
  { rule: "git.merge", re: /\bgit\s+(?:(?:-\w+\s+\S+|-\S+|--\S+)\s+)*merge\b/, what: "git merge (outward)" },
  { rule: "git.remote-mutation", re: /\bgit\s+(?:(?:-\w+\s+\S+|-\S+|--\S+)\s+)*(?:remote\s+(?:add|remove|set-url)|push\s+--(?:delete|force))\b/, what: "git remote mutation" },
  { rule: "gh.pr-mutation", re: /\bgh\s+pr\s+(?:merge|create|edit|comment|close)\b/, what: "gh pr mutation (outward)" },
  { rule: "gh.release-mutation", re: /\bgh\s+release\s+(?:create|delete|edit|upload)\b/, what: "gh release mutation (outward)" },
  { rule: "gh.repo-mutation", re: /\bgh\s+repo\s+(?:delete|archive|edit)\b/, what: "gh repo mutation (outward)" },
  { rule: "publish", re: /\b(?:npm|pnpm|yarn|bun|cargo|twine|hatch)\s+publish\b/, what: "package publish (outward)" },
  { rule: "rm.rf", re: /\brm\s+(?:-\w*r\w*f\s+|-\w*f\w*r\s+|--recursive\s+(?:--)?f\w*\s+|--force\s+(?:--)?r\w*\s+)/, what: "rm -rf (destructive)" },
  { rule: "payment", re: /\b(?:magpie\s+gateway-key\s+issue|stripe|payment)\b/, what: "payment / spend" },
  { rule: "message-human", re: /\b(?:curl|wget)\b[^|;&]*\b(?:discord|telegram|slack)\.com\b/, what: "message to others" },
];

export function classifyToolCall(call: ToolCall): ClassifierVerdict {
  const cmdline = [call.tool ?? "", ...(call.argv ?? []), call.argsSummary ?? ""].join(" ");
  for (const r of RULES) {
    if (r.re.test(cmdline)) {
      return {
        action: "deny",
        rule: r.rule,
        reason: `policy: ${r.what} requires approval — rerun with --yes (or MOLA_YES=1) or ask the human`,
      };
    }
  }
  return { action: "allow" };
}
