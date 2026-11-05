#!/usr/bin/env bash
# Run one mstack build worker through DSH headless (WSL, profile mola-cli, model group/smart-split (magpie route)).
# usage: tasks/dispatch.sh w1
set -u
W=$1
cd /mnt/e/mstack
printf -- '- id: agent-default-model\n  config:\n    provider: magpie\n    model: group/smart-split\n' > .dsh-pro.yml
source ~/src/mola-dsh-stack/scripts/env.sh
timeout 3600 dsh --profile mola-cli --patch /mnt/e/mstack/.dsh-pro.yml - < tasks/$W.md > logs/$W.out 2> logs/$W.err
echo "exit=$?" >> logs/$W.out
