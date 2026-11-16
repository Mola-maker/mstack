import { readFileSync } from "node:fs";
import * as api from "./api.mjs";

const routes = JSON.parse(readFileSync(new URL("./routes.json", import.meta.url), "utf8"));

export function dispatch(route, arg) {
  const name = routes[route];
  if (!name || typeof api[name] !== "function") throw new Error(`no handler for ${route}`);
  return api[name](arg);
}
