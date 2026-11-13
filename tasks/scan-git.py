import os, re, json, sys
pat = re.compile(r'git\s+(?:-C\s+\S+\s+)?(push|commit|merge|rebase|reset --hard|checkout\s+(?:main|master)|branch -[fD])[^"\\]{0,120}')
hits = {}
for root in ["/root/.dsh/sessions", "/root/.dsh/sessions-plain"]:
    for dp, dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            try:
                if p.endswith(".zstd"):
                    from compression import zstd
                    t = zstd.decompress(open(p, "rb").read()).decode("utf8", "ignore")
                else:
                    t = open(p, encoding="utf8", errors="ignore").read()
            except Exception: continue
            for m in pat.finditer(t):
                hits.setdefault(p, []).append(m.group(0)[:140])
for p, hs in sorted(hits.items(), key=lambda x: os.path.getmtime(x[0])):
    import time
    print(time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(p))), p.replace("/root/.dsh/", ""), len(hs))
    for h in sorted(set(hs))[:6]: print("    ", h)
