#!/usr/bin/env bash
# Per-round recorder for the headed visual fallback.
# For a computer-use session with a live desktop and explicit headed-visual
# authorization. Do not run it from a non-graphical shell.
#
# There is no prepare-then-replay loop. Each label is one frame:
#   observe -> the model locates the target in THAT before.png
#   -> act with those png coordinates
#   -> the model reviews after.png and records verify.
# Coordinates from another label or an earlier frame must not be reused
# unless the model has just measured them on this label's before.png.
# Do not treat a SHA-256 match across labels as a reason to skip locate;
# act already refuses a click when the live frame differs from this
# label's observe hash.
#
# Times recorded here are driver/wrapper walls only. They do not include
# model locate or review time. The 80s gap in the 2026-11-16 visual run
# was model/scheduling, not wrapper cost, and is not a speedup target.
# This script does not declare a performance winner. --side only namespaces
# the trial directory (A-t1 vs B-t1); both sides run cua-visual.mjs so a
# click is always bound to that label's hashed observe frame.
#
# Usage:
#   bash cua-visual-ab.sh observe --app APP --out-dir DIR --bin BIN --side A|B --label t1
#   # model reads DIR/A-t1/before.png (or B-t1) and chooses png-x,png-y
#   bash cua-visual-ab.sh act --out-dir DIR --bin BIN --side A|B --label t1 --png-x N --png-y N
#   bash cua-visual-ab.sh verify --out-dir DIR --side A|B --label t1 --verify pending|pass|fail|refuse|error
#   bash cua-visual-ab.sh summary --out-dir DIR

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WRAPPER="$SCRIPT_DIR/cua-visual.mjs"

usage() {
  echo "Usage: $0 observe --app APP --out-dir DIR --bin BIN --side A|B --label NAME" >&2
  echo "       $0 act --out-dir DIR --bin BIN --side A|B --label NAME --png-x N --png-y N" >&2
  echo "       $0 verify --out-dir DIR --side A|B --label NAME --verify pending|pass|fail|refuse|error" >&2
  echo "       $0 summary --out-dir DIR" >&2
  echo "prepare/trial were removed: do not retake a frame and replay an earlier point." >&2
  exit 2
}

APP=; OUT=; BIN=; PNG_X=; PNG_Y=; SIDE=; LABEL=; MODE=; VERIFY=

while [ $# -gt 0 ]; do
  case "$1" in
    observe|act|verify|summary) MODE=$1; shift ;;
    prepare|trial)
      echo "prepare/trial were removed. Use observe, then act on that label's frame, then verify." >&2
      usage
      ;;
    --app) APP=$2; shift 2 ;;
    --out-dir) OUT=$2; shift 2 ;;
    --bin) BIN=$2; shift 2 ;;
    --png-x) PNG_X=$2; shift 2 ;;
    --png-y) PNG_Y=$2; shift 2 ;;
    --side) SIDE=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    --verify) VERIFY=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$MODE" ] && [ -n "$OUT" ] || usage
if [ "$MODE" != "summary" ]; then
  [ -n "$SIDE" ] && [ -n "$LABEL" ] || usage
  case "$SIDE" in A|B) ;; *) echo "--side must be A or B" >&2; exit 2 ;; esac
fi

trial_dir() { printf '%s/%s-%s' "$OUT" "$SIDE" "$LABEL"; }
record_path() { printf '%s/record.json' "$(trial_dir)"; }

ns() { date +%s%N; }
iso() { date --iso-8601=ns; }

write_record() {
  python3 - "$1" "$2" <<'PY'
import json,sys,pathlib
path=pathlib.Path(sys.argv[1])
patch=json.loads(sys.argv[2])
doc={}
if path.exists():
    doc=json.loads(path.read_text())
for k,v in patch.items():
    if isinstance(v, dict) and isinstance(doc.get(k), dict):
        doc[k]={**doc[k], **v}
    else:
        doc[k]=v
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(doc, indent=2)+"\n")
PY
}

observe_B() {
  local dir
  dir=$(trial_dir)
  mkdir -p "$dir"
  local t0 t1
  t0=$(ns)
  node "$WRAPPER" observe --app "$APP" --out-dir "$dir" --headed-visual --bin "$BIN" >"$dir/observe.stdout.json"
  t1=$(ns)
  python3 - "$dir" "$t0" "$t1" "$SIDE" "$LABEL" "$(iso)" <<'PY'
import json,sys,pathlib
d=pathlib.Path(sys.argv[1])
t0,t1=int(sys.argv[2]),int(sys.argv[3])
obs=json.loads((d/"observe.stdout.json").read_text())
data=obs.get("data") or {}
if not obs.get("ok"):
    sys.exit(1)
wall=(t1-t0)/1e6
rec={
  "side": sys.argv[4],
  "label": sys.argv[5],
  "observe": {
    "at": sys.argv[6],
    "driver_wall_ms": wall,
    "driver_calls": len(data.get("driver_calls") or []),
    "before": (data.get("screenshot") or {}).get("path"),
    "sha256": (data.get("screenshot") or {}).get("sha256"),
    "window_id": (data.get("window") or {}).get("id"),
  },
  "act": None,
  "verify": {"status": "pending"},
  "task_succeeded": None,
}
(d/"record.json").write_text(json.dumps(rec, indent=2)+"\n")
print("observe side=%s label=%s driver_calls=%s driver_wall_ms=%s before=%s" % (
  rec["side"], rec["label"], rec["observe"]["driver_calls"], rec["observe"]["driver_wall_ms"], rec["observe"]["before"]))
print("Locate the target in that before.png, then run act with --png-x --png-y for this same side and label.", file=sys.stderr)
PY
}

observe_A() {
  [ -n "$APP" ] && [ -n "$BIN" ] || usage
  observe_B
}

act_B() {
  local dir
  dir=$(trial_dir)
  [ -f "$dir/observe.json" ] || { echo "no observe for $SIDE-$LABEL; run observe first" >&2; exit 1; }
  local t0 t1 status
  t0=$(ns)
  set +e
  node "$WRAPPER" act --observe "$dir/observe.json" --png-x "$PNG_X" --png-y "$PNG_Y" --headed-visual --bin "$BIN" >"$dir/act.stdout.json"
  status=$?
  set -e
  t1=$(ns)
  python3 - "$dir" "$t0" "$t1" "$status" "$(iso)" <<'PY'
import json,sys,pathlib
d=pathlib.Path(sys.argv[1])
t0,t1,status=int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4])
act=json.loads((d/"act.stdout.json").read_text())
rec=json.loads((d/"record.json").read_text())
wall=(t1-t0)/1e6
if act.get("ok"):
    data=act["data"]
    rec["act"]={
      "at": sys.argv[5],
      "driver_wall_ms": wall,
      "driver_calls": len(data.get("driver_calls") or []),
      "png": data.get("png"),
      "screen": data.get("screen"),
      "delivery": data.get("delivery"),
      "after": (data.get("after_screenshot") or {}).get("path"),
      "status": "ok",
      "task_succeeded": data.get("task_succeeded"),
    }
    rec["verify"]={"status": "pending"}
    rec["task_succeeded"]=None
    print("act side=%s label=%s status=ok driver_calls=%s driver_wall_ms=%s delivery=%s after=%s task_succeeded=%s verify=pending" % (
      rec["side"], rec["label"], rec["act"]["driver_calls"], wall, rec["act"]["delivery"], rec["act"]["after"], rec["act"]["task_succeeded"]))
    print("Review after.png, then run verify --verify pass|fail for this side and label.", file=sys.stderr)
else:
    err=act.get("error") or {}
    rec["act"]={
      "at": sys.argv[5],
      "driver_wall_ms": wall,
      "driver_calls": None,
      "status": "refuse" if err.get("code") in ("CONTENT_CHANGED","STALE_BOUNDS","STALE_WINDOW","BEFORE_EVIDENCE_CHANGED","BEFORE_EVIDENCE_MISSING","HEADED_VISUAL_REQUIRED") else "error",
      "code": err.get("code"),
      "message": err.get("message"),
      "current_screenshot": (err.get("current_screenshot") or {}).get("path"),
      "task_succeeded": None,
    }
    rec["verify"]={"status": rec["act"]["status"]}
    rec["task_succeeded"]=None
    print("act side=%s label=%s status=%s code=%s driver_wall_ms=%s task_succeeded=None" % (
      rec["side"], rec["label"], rec["act"]["status"], rec["act"].get("code"), wall))
    if err.get("code")=="CONTENT_CHANGED":
        print("Frame changed. Locate the target in the new current.png after a fresh observe; do not reuse these png coordinates.", file=sys.stderr)
(d/"record.json").write_text(json.dumps(rec, indent=2)+"\n")
sys.exit(0 if status==0 else 1)
PY
}

act_A() {
  act_B
}

cmd_verify() {
  case "$VERIFY" in
    pending|pass|fail|refuse|error) ;;
    *) echo "--verify must be pending, pass, fail, refuse, or error" >&2; exit 2 ;;
  esac
  local rec
  rec=$(record_path)
  [ -f "$rec" ] || { echo "no record for $SIDE-$LABEL" >&2; exit 1; }
  python3 - "$rec" "$VERIFY" "$(iso)" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1])
rec=json.loads(p.read_text())
rec["verify"]={"status": sys.argv[2], "at": sys.argv[3]}
# Model review never writes task_succeeded from driver ok/delivery.
if sys.argv[2]=="pass":
    rec["task_succeeded"]=True
elif sys.argv[2]=="fail":
    rec["task_succeeded"]=False
else:
    rec["task_succeeded"]=None
p.write_text(json.dumps(rec, indent=2)+"\n")
print("verify side=%s label=%s verify=%s task_succeeded=%s" % (
  rec.get("side"), rec.get("label"), rec["verify"]["status"], rec["task_succeeded"]))
PY
}

cmd_summary() {
  python3 - "$OUT" <<'PY'
import json,sys,pathlib
root=pathlib.Path(sys.argv[1])
rows=[]
for rec in sorted(root.glob("*/record.json")):
    try:
        doc=json.loads(rec.read_text())
    except Exception:
        continue
    rows.append(doc)
counts={"pending":0,"pass":0,"fail":0,"refuse":0,"error":0,"other":0}
print("label side observe_wall_ms act_wall_ms observe_calls act_calls delivery verify task_succeeded")
for doc in rows:
    v=(doc.get("verify") or {}).get("status") or "pending"
    counts[v if v in counts else "other"]+=1
    obs=doc.get("observe") or {}
    act=doc.get("act") or {}
    print("%s %s %s %s %s %s %s %s %s" % (
      doc.get("label"), doc.get("side"),
      obs.get("driver_wall_ms"), act.get("driver_wall_ms"),
      obs.get("driver_calls"), act.get("driver_calls"),
      act.get("delivery"), v, doc.get("task_succeeded")))
print("counts pending=%s pass=%s fail=%s refuse=%s error=%s" % (
  counts["pending"], counts["pass"], counts["fail"], counts["refuse"], counts["error"]))
print("driver_wall_ms is wrapper/driver time only and excludes model locate and review.")
print("No performance winner is declared.")
PY
}

case "$MODE" in
  observe)
    [ -n "$APP" ] && [ -n "$BIN" ] || usage
    observe_A
    ;;
  act)
    [ -n "$BIN" ] && [ -n "$PNG_X" ] && [ -n "$PNG_Y" ] || usage
    act_A
    ;;
  verify)
    [ -n "$VERIFY" ] || usage
    cmd_verify
    ;;
  summary)
    cmd_summary
    ;;
  *) usage ;;
esac
