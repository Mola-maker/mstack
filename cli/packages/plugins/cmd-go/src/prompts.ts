/**
 * Stage prompts and the STATUS line. Prompts are short plain text (no markdown
 * headings, no XML) so the run engine's family adapter can wrap them.
 */

import type { StageName } from "@mola/plugin-sdk";
import { STAGE_ARTIFACT } from "./stages.js";

export interface StagePromptInput {
  stage: StageName;
  intent: string;
  /** the run dir relative to the agent's cwd, e.g. `.mstack/runs/go-…` */
  dir: string;
  /** artifacts of earlier stages that exist, relative to `dir` */
  previous: string[];
  /** set when implement runs again because verify failed */
  retryFrom?: string;
}

const TASK: Record<StageName, string> = {
  think:
    "The request is vague. Pin it down: state the most useful reading of it, your assumptions, and 2-4 checkable done-criteria. Do not edit source files.",
  plan:
    "Write a plan a builder can execute: the files to touch, the steps in order, and the checks that prove it works. Do not edit source files.",
  implement:
    "Implement the plan. Make the smallest change that satisfies it, in the existing style. Summarize what you changed (file list, one line each).",
  verify:
    "Run the project's real checks for this change (tests, build, lint where they exist). List every exact command you ran and its result line (pass/fail counts). Do not edit source files. Report failed if any command fails.",
  review:
    "Review the change (git diff) against the intent and the plan, as someone other than its author. One line per issue: `FINDING: <high|medium|low> <file:line> <what is wrong>`. One line per area you checked and found sound: `CLEARED: <area>`. Do not edit source files.",
  ship:
    "Get the change out: create a branch if needed, commit with a clear message, push, and open a pull request. Put the branch name and PR URL in the summary.",
};

export function buildStagePrompt(i: StagePromptInput): string {
  const artifact = `${i.dir}/${STAGE_ARTIFACT[i.stage]}`;
  const lines = [
    `Intent: ${i.intent}`,
    `Run dir: ${i.dir}`,
    `Stage: ${i.stage}`,
    "",
    TASK[i.stage],
  ];
  if (i.previous.length > 0) {
    lines.push("", `Earlier artifacts (read them first): ${i.previous.map((a) => `${i.dir}/${a}`).join(", ")}`);
  }
  if (i.stage === "implement" && i.retryFrom) {
    lines.push(
      "",
      `Verification failed. Read ${i.dir}/${i.retryFrom}, fix what it reports, and do not repeat the same fix twice.`,
    );
  }
  lines.push(
    "",
    `Write the result to ${artifact}. If you cannot write files, put the full content in your final message instead.`,
    "End your reply with exactly one line: STATUS: done|failed|blocked <one-line summary>",
  );
  return lines.join("\n");
}

export type AgentStatus = "done" | "failed" | "blocked";

export interface ParsedStatus {
  status: AgentStatus;
  summary: string;
  /** false when the agent never wrote a STATUS line (counts as failed) */
  found: boolean;
}

/** Parse the last `STATUS: done|failed|blocked <summary>` line; a missing line is `failed`. */
export function parseStatus(text: string): ParsedStatus {
  const re = /^[ \t>*_`-]*STATUS:[ \t]*(done|failed|blocked)\b[ \t:-]*(.*?)[ \t*_`]*$/gim;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text ?? ""); m; m = re.exec(text ?? "")) last = m;
  if (!last) return { status: "failed", summary: "no STATUS line in the agent's reply", found: false };
  return { status: last[1].toLowerCase() as AgentStatus, summary: last[2].trim(), found: true };
}

/** The reply without its STATUS line (used as the artifact when the agent could not write the file). */
export function stripStatus(text: string): string {
  return (text ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^[ \t>*_`-]*STATUS:[ \t]*(done|failed|blocked)\b/i.test(l))
    .join("\n")
    .trim();
}
