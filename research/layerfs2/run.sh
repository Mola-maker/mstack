#!/bin/bash
set -e
ldd --version | head -1
mkdir -p ~/lfs2-probe && cd ~/lfs2-probe
cp "$(dirname "$0")"/probe.mjs "$(dirname "$0")"/accept.mjs .
[ -f package.json ] || echo '{"name":"lfs2-probe","private":true,"type":"module"}' > package.json
node --version
npm install --no-audit --no-fund @layerfs/node@2.0.0-rc.1 2>&1 | tail -1
PROBE_DIR=$HOME/lfs2-probe node "${1:-probe}.mjs"
