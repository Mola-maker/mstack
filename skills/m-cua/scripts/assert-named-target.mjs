#!/usr/bin/env node
// Offline: did a recorded snapshot or find envelope expose a named target?
// Only a successful result counts: snapshot data.tree, or find data.match.
// `find` with ok:true and match:null is a miss. A failed envelope is never a hit.
// A missing name is a failure, not a pass. This does not start a GUI or call a desktop driver.
// Usage: node assert-named-target.mjs --name <text> [--snapshot file.json]... [--find file.json]...
// Exit 0 if the name is visible. Exit 1 if not. Exit 2 on bad arguments.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Walk an accessibility tree node: only `name` and `children`, the driver snapshot shape. */
function namesInTree(node, acc = []) {
  if (Array.isArray(node)) { for (const n of node) namesInTree(n, acc); return acc; }
  if (!node || typeof node !== "object") return acc;
  if (typeof node.name === "string") acc.push(node.name);
  if (node.children) namesInTree(node.children, acc);
  return acc;
}

function okData(doc) {
  if (!doc || doc.ok !== true || !doc.data || typeof doc.data !== "object") return null;
  return doc.data;
}

function findMatch(doc) {
  const data = okData(doc);
  if (!data || !Object.prototype.hasOwnProperty.call(data, "match")) return undefined;
  return data.match;
}

export function targetVisible(name, docs) {
  for (const doc of docs) {
    const data = okData(doc);
    if (!data) continue;
    if (Object.prototype.hasOwnProperty.call(data, "match")) {
      const match = data.match;
      if (match && typeof match === "object" && (match.name === name || namesInTree(match).includes(name)))
        return true;
      continue;
    }
    if (data.tree && namesInTree(data.tree).includes(name)) return true;
  }
  return false;
}

export function main(argv) {
  const snapshots = [];
  const finds = [];
  let name;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name" && argv[i + 1]) name = argv[++i];
    else if (argv[i] === "--snapshot" && argv[i + 1]) snapshots.push(argv[++i]);
    else if (argv[i] === "--find" && argv[i + 1]) finds.push(argv[++i]);
    else return { code: 2, text: `usage: assert-named-target.mjs --name <text> [--snapshot file]... [--find file]...\n  bad argument: ${argv[i]}` };
  }
  if (!name || (!snapshots.length && !finds.length))
    return { code: 2, text: "usage: assert-named-target.mjs --name <text> [--snapshot file]... [--find file]..." };
  const docs = [];
  try {
    for (const f of [...snapshots, ...finds]) docs.push(JSON.parse(readFileSync(f, "utf8")));
  } catch (e) {
    return { code: 2, text: `cannot read fixture: ${e.message}` };
  }
  const visible = targetVisible(name, docs);
  const findDocs = docs.slice(snapshots.length);
  const findMisses = findDocs.filter((d) => findMatch(d) == null).length;
  if (visible) return { code: 0, text: `visible: ${name}` };
  const why = finds.length && findMisses
    ? `find match:null or not ok (${findMisses}/${finds.length})`
    : "name not in snapshot tree";
  return { code: 1, text: `unreadable: ${name} (${why}). This is a failure, not a pass.` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, text } = main(process.argv.slice(2));
  console.log(text);
  process.exit(code);
}
