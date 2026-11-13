import sys, json
from compression import zstd
p = sys.argv[1]
lines = zstd.decompress(open(p, "rb").read()).decode("utf8", "ignore").splitlines()
n=0
for ln in lines:
    ev = json.loads(ln)
    if ev.get("type") in ("tool/call","approval/asked","approval/decided"):
        if "git" in ln and n < 4 or ev["type"].startswith("approval"):
            print(ln[:700]); print('---'); n+=1
