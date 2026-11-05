#!/usr/bin/env bash
# Resume (or start) a DSH headless worker inside its own tmux server (-L workers), so it outlives the wsl client.
# usage: tasks/resume.sh <session-id|-> <log-name> [message-file]
set -u
SID=$1; NAME=$2; MSGF=${3:-}
cd /mnt/e/mstack
if [ -z "$MSGF" ]; then MSGF=logs/$NAME.msg; echo "Continue your assigned task from where you stopped. Finish it, run your build, tests and acceptance commands, then give the reply your brief asked for." > "$MSGF"; fi
S=""; [ "$SID" != "-" ] && S="--session-id $SID"
tmux -L workers new-session -d -s "$NAME" "source ~/src/mola-dsh-stack/scripts/env.sh; cd /mnt/e/mstack; timeout 5400 dsh --profile mola-cli --patch /mnt/e/mstack/.dsh-pro.yml $S - < $MSGF > logs/$NAME.out 2> logs/$NAME.err; echo exit=\$? >> logs/$NAME.out"
echo "started $NAME"
