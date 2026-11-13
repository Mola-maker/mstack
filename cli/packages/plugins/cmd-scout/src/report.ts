/** reuse.md rendering. */
import type { Candidate, ChannelReport } from "./types.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (iso?: string) => (iso ? iso.slice(0, 10) : "–");

export function licenseCell(c: Candidate): string {
  const id = c.license ?? "none";
  if (c.licenseClass === "flag") return `${id} ⚠ flagged (no auto-adapt)`;
  if (c.licenseClass === "note") return `${id} (note: file-level copyleft)`;
  return id;
}

export function renderReuse(a: {
  id: string;
  need: string;
  queries: string[];
  candidates: Candidate[];
  channels: ChannelReport[];
  decision: string;
}): string {
  const L: string[] = [];
  L.push(`# Reuse report ${a.id}`, "", "## Need", "", a.need, "", "## Queries", "");
  a.queries.forEach((q) => L.push(`- \`${q}\``));
  L.push("", "## Candidates", "");
  if (!a.candidates.length) L.push("_no candidates found_");
  else {
    L.push("| # | source | name | stars | last push | license | why it matched |", "|---|---|---|---|---|---|---|");
    a.candidates.slice(0, 15).forEach((c, i) => {
      const star = c.stars != null ? String(c.stars) : (c.popularity ?? "–");
      const name = c.kind === "local" ? `\`${c.name}\`` : `[${c.name}](${c.url})${c.starred ? " ★" : ""}`;
      L.push(`| ${i + 1} | ${c.sources.join("+")} | ${esc(name)} | ${esc(star)} | ${short(c.pushedAt)} | ${esc(licenseCell(c))} | ${esc(c.why.join("; ").slice(0, 160))} |`);
    });
  }
  L.push("", "## Harvest", "");
  const harvested = a.candidates.filter((c) => c.harvest);
  if (!harvested.length) L.push("_nothing harvested_");
  for (const c of harvested) {
    const h = c.harvest!;
    L.push(`### ${c.name}${h.dir ? ` — \`${h.dir}\`` : ""}`);
    if (h.note) L.push(`- note: ${h.note}`);
    for (const f of h.files) L.push(`- \`${f.path}\` (${f.lines ?? "?"} lines${f.hitLine ? `, first match line ${f.hitLine}` : ""})`);
    L.push("");
  }
  L.push("## Decision", "", a.decision.trim(), "", "## Channels", "");
  for (const ch of a.channels) L.push(`- ${ch.channel}: ${ch.status}${ch.detail ? ` — ${ch.detail}` : ""}`);
  L.push("");
  return L.join("\n");
}
