#!/usr/bin/env bash
# Replayable A/B comparison for the headed visual fallback.
# This script is for a computer-use session that already has a live desktop
# and an authorized headed-visual task. Do not run it from a non-graphical shell.
#
# Side A is the raw driver sequence that succeeded on 2026-11-16
# (list-windows, screenshot, focus-window, mouse-click, screenshot).
# Side B is cua-visual.mjs observe + act (same flags, no hardcoded target).
# PNG coordinates are supplied on the command line: the model locates the
# target in the fresh before image. Do not reuse 243,183 or 878,505 unless
# the model has just measured them on this run's before.png.
#
# Usage (from the graphical session, after a successful semantic miss):
#   export DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR
#   BIN=/path/to/agent-desktop   # from cua-doctor --need desktop --json
#   # First observe only, so the model can read before.png:
#   bash cua-visual-ab.sh prepare --app thunar --out-dir /tmp/cua-visual-ab --bin "$BIN"
#   # After the model reads OUT/B/before.png and chooses png-x,png-y:
#   bash cua-visual-ab.sh trial --app thunar --out-dir /tmp/cua-visual-ab --bin "$BIN" \
#     --png-x <n> --png-y <n> --side A|B --label t1
#
# Alternate sides at least 5 times (A,B,A,B,...). Record every trial line.
# Do not claim a speedup from the earlier 80s model/scheduling gap. Count
# driver invocations, wall time, delivery, and whether the after image
# confirmed the task (the model fills verify=pass|fail).

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WRAPPER="$SCRIPT_DIR/cua-visual.mjs"

usage() {
  echo "Usage: $0 prepare --app APP --out-dir DIR --bin BIN" >&2
  echo "       $0 trial --app APP --out-dir DIR --bin BIN --png-x N --png-y N --side A|B --label NAME" >&2
  exit 2
}

APP=; OUT=; BIN=; PNG_X=; PNG_Y=; SIDE=; LABEL=; MODE=

while [ $# -gt 0 ]; do
  case "$1" in
    prepare|trial) MODE=$1; shift ;;
    --app) APP=$2; shift 2 ;;
    --out-dir) OUT=$2; shift 2 ;;
    --bin) BIN=$2; shift 2 ;;
    --png-x) PNG_X=$2; shift 2 ;;
    --png-y) PNG_Y=$2; shift 2 ;;
    --side) SIDE=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$MODE" ] && [ -n "$APP" ] && [ -n "$OUT" ] && [ -n "$BIN" ] || usage

ns() { date +%s%N; }
elapsed_ms() { python3 -c "print((int('$2')-int('$1'))/1e6)"; }

prepare() {
  mkdir -p "$OUT/B"
  node "$WRAPPER" observe --app "$APP" --out-dir "$OUT/B" --bin "$BIN"
  echo "PREPARE_OUT=$OUT/B" >&2
  echo "Read $OUT/B/before.png, then run trial with --png-x --png-y --side and --headed-visual authorization already granted." >&2
}

# Baseline A: the exact raw command sequence from the successful visual run.
# Coordinates are computed here from this trial's list-windows + the supplied
# png point (not from a stored screen point).
trial_A() {
  local dir="$OUT/A-$LABEL"
  mkdir -p "$dir"
  local t0=$(ns)
  local calls=0
  local list
  list=$("$BIN" list-windows --app "$APP")
  calls=$((calls+1))
  printf '%s\n' "$list" >"$dir/list-windows.json"
  python3 - "$list" "$dir" "$APP" <<'PY'
import json,sys
doc=json.loads(sys.argv[1])
app=sys.argv[3]
wins=doc.get("data") if isinstance(doc.get("data"), list) else []
named=[w for w in wins if w.get("app_name")==app]
if len(named)!=1:
    print("A_REFUSE=ambiguous_or_missing_window", file=sys.stderr)
    sys.exit(1)
w=named[0]
open(sys.argv[2]+"/window.json","w").write(json.dumps(w))
print(w["id"])
PY
  local wid
  wid=$(python3 -c "import json; print(json.load(open('$dir/window.json'))['id'])")
  local before="$dir/before.png"
  "$BIN" screenshot --app "$APP" --window-id "$wid" "$before" >"$dir/screenshot-before.json"
  calls=$((calls+1))
  # Map using this trial's bounds + scale (same formula as the wrapper).
  python3 - "$dir" "$PNG_X" "$PNG_Y" <<'PY'
import json,sys,pathlib
d=pathlib.Path(sys.argv[1])
w=json.load(open(d/"window.json"))
shot=json.load(open(d/"screenshot-before.json"))["data"]
b=w["bounds"]; scale=float(shot["scale_factor"])
sx=round(b["x"]+float(sys.argv[2])/scale)
sy=round(b["y"]+float(sys.argv[3])/scale)
open(d/"xy.json","w").write(json.dumps({"png":{"x":float(sys.argv[2]),"y":float(sys.argv[3])},"screen":{"x":sx,"y":sy}}))
print(f"{sx},{sy}")
PY
  local xy
  xy=$(python3 -c "import json; s=json.load(open('$dir/xy.json'))['screen']; print(f\"{s['x']},{s['y']}\")")
  "$BIN" --headed focus-window --window-id "$wid" >"$dir/focus-window.json"
  calls=$((calls+1))
  "$BIN" --headed mouse-click --xy "$xy" >"$dir/mouse-click.json"
  calls=$((calls+1))
  local after="$dir/after.png"
  "$BIN" screenshot --app "$APP" --window-id "$wid" "$after" >"$dir/screenshot-after.json"
  calls=$((calls+1))
  local t1=$(ns)
  local ms
  ms=$(elapsed_ms "$t0" "$t1")
  local delivery
  delivery=$(python3 -c "import json; print(json.load(open('$dir/mouse-click.json')).get('data',{}).get('disposition',{}).get('delivery',''))")
  printf 'side=A label=%s driver_calls=%s wall_ms=%s delivery=%s before=%s after=%s xy=%s task_succeeded=unset_model_must_review_after_image\n' \
    "$LABEL" "$calls" "$ms" "$delivery" "$before" "$after" "$xy"
}

trial_B() {
  local dir="$OUT/B-$LABEL"
  mkdir -p "$dir"
  local t0=$(ns)
  node "$WRAPPER" observe --app "$APP" --out-dir "$dir" --bin "$BIN" >"$dir/observe.stdout.json"
  node "$WRAPPER" act --observe "$dir/observe.json" --png-x "$PNG_X" --png-y "$PNG_Y" --headed-visual --bin "$BIN" >"$dir/act.stdout.json"
  local t1=$(ns)
  local ms
  ms=$(elapsed_ms "$t0" "$t1")
  python3 - "$dir" "$LABEL" "$ms" <<'PY'
import json,sys
d=sys.argv[1]; label=sys.argv[2]; ms=sys.argv[3]
obs=json.load(open(d+"/observe.stdout.json"))
act=json.load(open(d+"/act.stdout.json"))
calls=len(obs.get("data",{}).get("driver_calls") or [])+len(act.get("data",{}).get("driver_calls") or [])
print("side=B label=%s driver_calls=%s wall_ms=%s delivery=%s before=%s after=%s xy=%s task_succeeded=%s" % (
  label, calls, ms, act.get("data",{}).get("delivery"),
  obs.get("data",{}).get("screenshot",{}).get("path"),
  act.get("data",{}).get("after_screenshot",{}).get("path"),
  "%s,%s" % (act.get("data",{}).get("screen",{}).get("x"), act.get("data",{}).get("screen",{}).get("y")),
  act.get("data",{}).get("task_succeeded"),
))
PY
}

if [ "$MODE" = prepare ]; then
  prepare
  exit 0
fi

[ -n "$PNG_X" ] && [ -n "$PNG_Y" ] && [ -n "$SIDE" ] && [ -n "$LABEL" ] || usage
case "$SIDE" in
  A) trial_A ;;
  B) trial_B ;;
  *) echo "--side must be A or B" >&2; exit 2 ;;
esac
