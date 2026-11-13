#!/usr/bin/env bash
# Resume (or start) a DSH headless worker inside its own tmux server (-L workers), so it outlives the wsl client.
# usage: tasks/resume.sh <session-id|-> <log-name> [message-file]
#
# Isolation (FRAMEWORK §13.4; 2026-11-08 incident: a worker sharing the main
# working tree ran `git reset --hard` + `git push --all` there and wiped every
# other worker's edits). Each worker now gets its own clone on branch
# agent/<name> under /root/mstack-wt/<name>; push is disabled in that clone, and
# the orchestrator collects the branch with:
#   git fetch /root/mstack-wt/<name> agent/<name>   (from WSL)
# Set MOLA_SHARED_TREE=1 only for read-only workers that must see uncommitted files.
set -u
SID=$1; NAME=$2; MSGF=${3:-}
MAIN=/mnt/e/mstack
cd "$MAIN"
if [ -z "$MSGF" ]; then MSGF=logs/$NAME.msg; echo "Continue your assigned task from where you stopped. Finish it, run your build, tests and acceptance commands, then give the reply your brief asked for." > "$MSGF"; fi
case "$MSGF" in /*) ;; *) MSGF="$MAIN/$MSGF" ;; esac
S=""; [ "$SID" != "-" ] && S="--session-id $SID"

WT=$MAIN
if [ "${MOLA_SHARED_TREE:-0}" != "1" ]; then
  WT=/root/mstack-wt/$NAME
  if [ ! -d "$WT/.git" ]; then
    mkdir -p /root/mstack-wt
    git clone -q --no-hardlinks "$MAIN" "$WT" || { echo "clone failed"; exit 1; }
    git -C "$WT" checkout -q -B "agent/$NAME" "$(git -C "$MAIN" rev-parse HEAD)"
    git -C "$WT" remote set-url --push origin "no-push://disabled-see-FRAMEWORK-13.4"
    git -C "$WT" config user.name "mstack-worker-$NAME"
    git -C "$WT" config user.email "worker@mstack.invalid"
    (cd "$WT/cli" && pnpm install --frozen-lockfile >/dev/null 2>&1) || echo "warn: pnpm install failed in $WT/cli"
  fi
fi

# Guard env (policy-guard, when built): git shim + hooks for this worker.
GUARD=""
if [ -x /root/.mola/guard/bin/git ]; then GUARD="export PATH=/root/.mola/guard/bin:\$PATH GIT_CONFIG_GLOBAL=/root/.mola/guard/gitconfig MOLA_GUARD=1;"; fi

tmux -L workers new-session -d -s "$NAME" "source ~/src/mola-dsh-stack/scripts/env.sh; $GUARD cd $WT; timeout 5400 dsh --profile mola-cli --patch $MAIN/.dsh-pro.yml $S - < $MSGF > $MAIN/logs/$NAME.out 2> $MAIN/logs/$NAME.err; echo exit=\$? >> $MAIN/logs/$NAME.out"
echo "started $NAME in $WT"
