/**
 * A run's inbox: notes the owner sends while a run is going (`mola go say`, the
 * web console). They queue in `.mstack/runs/<id>/inbox.jsonl` and the next stage
 * that starts reads every note it has not read yet. `inbox.read` holds how many
 * lines were handed over, so a note is delivered once.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runDir, writeJsonAtomic } from "./progress.js";
import { stripInvisible } from "./sanitize.js";

export interface InboxNote {
  at: string;
  by: string;
  text: string;
}

export const MAX_NOTE = 4000;

const inboxFile = (cwd: string, runId: string): string => path.join(runDir(cwd, runId), "inbox.jsonl");
const cursorFile = (cwd: string, runId: string): string => path.join(runDir(cwd, runId), "inbox.read.json");

export function readInbox(cwd: string, runId: string): InboxNote[] {
  let text: string;
  try {
    text = fs.readFileSync(inboxFile(cwd, runId), "utf8");
  } catch {
    return [];
  }
  const out: InboxNote[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const n = JSON.parse(line) as InboxNote;
      if (typeof n.text === "string") out.push(n);
    } catch {
      // a torn line is skipped
    }
  }
  return out;
}

/** Queue a note. Invisible characters are stripped; returns the stored note and how many were removed. */
export function addNote(cwd: string, runId: string, text: string, by: string): { note: InboxNote; removed: number } {
  const { text: clean, removed } = stripInvisible(text);
  const body = clean.trim();
  if (!body) throw new Error("the note is empty");
  if (body.length > MAX_NOTE) throw new Error(`a note is at most ${MAX_NOTE} characters`);
  const note: InboxNote = { at: new Date().toISOString(), by, text: body };
  fs.mkdirSync(runDir(cwd, runId), { recursive: true });
  fs.appendFileSync(inboxFile(cwd, runId), JSON.stringify(note) + "\n", "utf8");
  return { note, removed };
}

export function pendingNotes(cwd: string, runId: string): InboxNote[] {
  const all = readInbox(cwd, runId);
  let read = 0;
  try {
    read = Number((JSON.parse(fs.readFileSync(cursorFile(cwd, runId), "utf8")) as { read?: number }).read) || 0;
  } catch {
    read = 0;
  }
  return all.slice(read);
}

/** Hand over every unread note and mark them read. */
export function takeNotes(cwd: string, runId: string): InboxNote[] {
  const all = readInbox(cwd, runId);
  const pending = pendingNotes(cwd, runId);
  if (pending.length > 0) writeJsonAtomic(cursorFile(cwd, runId), { read: all.length });
  return pending;
}
