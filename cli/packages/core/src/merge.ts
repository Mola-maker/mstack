/**
 * Config deep-merge (core §2.4): later layer wins for scalars, arrays and
 * objects; `null` deletes the key.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === null) return undefined; // delete marker
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
      const merged = deepMerge(out[k], v);
      if (merged === undefined) delete out[k];
      else out[k] = merged;
    }
    return out;
  }
  return overlay;
}

export function deepFreeze<T>(value: T): T {
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  } else if (Array.isArray(value)) {
    for (const v of value) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Get a dotted path ("a.b.c") from a plain object. */
export function getPath(obj: unknown, key: string): { found: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (!isPlainObject(cur) || !(part in cur)) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

/** Set a dotted path on a plain object; `null`/undefined deletes. */
export function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (!isPlainObject(next)) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = value;
}
