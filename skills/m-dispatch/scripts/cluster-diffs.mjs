#!/usr/bin/env node
// Cluster candidate patches by exact diff text.
// usage: node "<this skill dir>/scripts/cluster-diffs.mjs" <patch> [patch...]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INDEX_LINE = /^index [0-9a-f]{4,}\.\.[0-9a-f]{4,}(?: \d+)?$/;

export function normalizeDiff(text) {
  const lines = String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => !INDEX_LINE.test(line));
  // Ignore only extra blank lines at the end. A trailing space in a hunk still differs.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function clusterDiffs(named) {
  const groups = new Map();
  for (const item of named) {
    const key = normalizeDiff(item.text);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.name);
  }
  const clusters = [...groups.entries()]
    .map(([key, members], index) => ({
      id: index + 1,
      count: members.length,
      members: [...members].sort(),
      bytes: key.length,
    }))
    .sort((a, b) => b.count - a.count || a.members[0].localeCompare(b.members[0]));
  const n = named.length;
  const top = clusters[0]?.count ?? 0;
  const leaders = clusters.filter((cluster) => cluster.count === top && top > 0);
  const majority = leaders.length === 1 && top * 2 > n ? leaders[0].members : null;
  return {
    n,
    clusters: clusters.map(({ bytes, ...rest }) => rest),
    majority,
    tie: majority == null,
  };
}

export function main(argv, read = readFileSync) {
  const usage = 'usage: node "<this skill dir>/scripts/cluster-diffs.mjs" <patch> [patch...]\n';
  if (argv.length < 1 || argv.some((arg) => arg.startsWith("-"))) {
    return { code: 2, stdout: "", stderr: usage };
  }
  const named = [];
  try {
    for (const file of argv) named.push({ name: file, text: read(file, "utf8") });
  } catch (error) {
    return { code: 2, stdout: "", stderr: `${error.message}\n` };
  }
  return { code: 0, stdout: `${JSON.stringify(clusterDiffs(named), null, 2)}\n`, stderr: "" };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href
    || fileURLToPath(import.meta.url) === resolve(entry);
}

if (invokedDirectly()) {
  const result = main(process.argv.slice(2));
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.code);
}
