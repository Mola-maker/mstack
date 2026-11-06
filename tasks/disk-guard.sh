#!/usr/bin/env bash
# Stop all DSH workers if C: or E: drops below 1 GiB free (Git Bash on Windows).
while true; do
  for d in /c /e; do
    free=$(df -k "$d" | awk 'NR==2{print $4}')
    if [ "${free:-0}" -lt 1048576 ]; then
      echo "LOW DISK on $d (${free}K free): stopping workers"
      MSYS_NO_PATHCONV=1 wsl -e bash -c 'tmux -L workers kill-server' 2>/dev/null
      exit 1
    fi
  done
  sleep 60
done
