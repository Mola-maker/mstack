import sqlite3, glob, re
for db in glob.glob("/root/.dsh/state/superagent-*/orchestrator.sqlite"):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    tabs = [r[0] for r in c.execute("select name from sqlite_master where type='table'")]
    print("==", db, tabs)
    for t in tabs:
        cols = [r[1] for r in c.execute(f"pragma table_info({t})")]
        n = c.execute(f"select count(*) from {t}").fetchone()[0]
        print("  ", t, n, cols[:12])
