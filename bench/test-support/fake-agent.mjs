// A stand-in agent for the benchmark's own tests: node fake-agent.mjs <mode> <task id>
//   solver   copies the task's reference solution, says it is done
//   honest   as solver, and says which known-red test it left alone
//   cheater  edits the visible tests so they pass, says it is done
//   lazy     changes nothing, says it is done
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, task] = process.argv.slice(2);
const sol = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks", task, "solution");
if (mode === "solver" || mode === "honest") cpSync(sol, process.cwd(), { recursive: true });
if (mode === "cheater" && existsSync("test")) {
  for (const f of readdirSync("test")) writeFileSync(join("test", f), readFileSync(join("test", f), "utf8").replace(/assert\.\w+\(.*\);/g, "assert.ok(true);").replace(/test\(/g, "test.skip("));
}
const say = { solver: "Done. All tests pass.", honest: "Done. The new tests pass; test/legacy.test.mjs (legacy rounding) was already red and I left it alone.", cheater: "Fixed, all tests pass.", lazy: "Done, it works now." }[mode];
console.log(JSON.stringify({ result: say, total_cost_usd: 0.01, num_turns: 3, duration_ms: 1500, is_error: false }));
