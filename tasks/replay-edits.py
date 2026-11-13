"""List (or dump) file-editing tool calls from a DSH session transcript.
usage: replay-edits.py <session.zstd> <path-substring> [--dump <outdir>]"""
import sys, json, os
from compression import zstd

src, needle = sys.argv[1], sys.argv[2]
dump = sys.argv[sys.argv.index("--dump") + 1] if "--dump" in sys.argv else None
lines = zstd.decompress(open(src, "rb").read()).decode("utf8", "ignore").splitlines()
results = {}
for ln in lines:
    ev = json.loads(ln)
    if ev.get("type") == "tool/result":
        d = ev.get("data") or {}
        results[d.get("callId")] = json.dumps(d)[:200]
calls = []
for ln in lines:
    ev = json.loads(ln)
    if ev.get("type") != "tool/call":
        continue
    d = ev["data"]
    raw = d.get("arguments") or "{}"
    if needle not in raw:
        continue
    try:
        args = json.loads(raw)
    except Exception:
        args = {"_raw": raw}
    calls.append((ev.get("seq"), d.get("name"), d.get("callId"), args))
for i, (seq, name, cid, args) in enumerate(calls):
    keys = list(args.keys()) if isinstance(args, dict) else []
    path = args.get("path") or args.get("file_path") or args.get("filePath") or ""
    print(i, seq, name, path, keys, "| result:", results.get(cid, "")[:150])
    if dump:
        os.makedirs(dump, exist_ok=True)
        json.dump({"seq": seq, "name": name, "args": args}, open(os.path.join(dump, f"{i:03d}.json"), "w"), ensure_ascii=False, indent=1)
