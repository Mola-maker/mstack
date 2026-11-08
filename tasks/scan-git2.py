"""List git mutations DSH agents actually ran (tool/call bash), per session, with
whether a reviewer subagent had returned before the first commit/push."""
import os, re, json, time
from compression import zstd

MUT = re.compile(r"git\s+(?:-C\s+\S+\s+)?(push|commit|merge|rebase|reset\s+--hard|checkout\s+(?:main|master)\b|cherry-pick|branch\s+-[fD])")
PROT = re.compile(r"\b(main|master|layerfs_v2_0_0|HEAD:main|HEAD:master)\b")
REVIEW = re.compile(r"review|审", re.I)

rows = []
for dp, dn, fn in os.walk("/root/.dsh/sessions"):
    for f in fn:
        if not f.endswith(".zstd"):
            continue
        p = os.path.join(dp, f)
        try:
            lines = zstd.decompress(open(p, "rb").read()).decode("utf8", "ignore").splitlines()
        except Exception:
            continue
        reviewed = False
        title = ""
        for ln in lines:
            try:
                ev = json.loads(ln)
            except Exception:
                continue
            t, d = ev.get("type"), ev.get("data") or {}
            if t == "session/title":
                title = str(d.get("title", ""))[:60]
            if t == "tool/call":
                try:
                    args = json.loads(d.get("arguments") or "{}")
                except Exception:
                    args = {}
                name = d.get("name", "")
                if name in ("subagent", "spawn_teammate", "agent", "fork") and REVIEW.search(json.dumps(args, ensure_ascii=False)):
                    reviewed = True
                cmd = args.get("command") if isinstance(args, dict) else None
                if isinstance(cmd, str) and MUT.search(cmd):
                    ops = sorted(set(m.group(1).split()[0] for m in MUT.finditer(cmd)))
                    rows.append((ev.get("time", 0) / 1000, p.split("/")[4], p.split("/")[5][:20], title, ",".join(ops),
                                 "PROTECTED-REF" if PROT.search(cmd) else "", "reviewed-before" if reviewed else "NO-REVIEW-YET",
                                 cmd.replace("\n", " ; ")[:220]))

for r in sorted(rows):
    print(time.strftime("%m-%d %H:%M", time.localtime(r[0])), *r[1:7], "|", r[7])
