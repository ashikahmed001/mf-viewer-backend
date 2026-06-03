#!/bin/bash
set -e

CONFIG="/app/litestream.yml"
DB="${DB_PATH:-/data/mf_portfolio.db}"

# If DB doesn't exist on the volume, restore latest backup from R2
if [ ! -f "$DB" ]; then
  echo "[litestream] DB not found — restoring from R2..."
  litestream restore -config "$CONFIG" -if-replica-exists "$DB" && \
    echo "[litestream] Restore complete." || \
    echo "[litestream] No backup found — starting fresh."
fi

# Start Litestream in replicate mode, wrapping the Node process
exec litestream replicate -config "$CONFIG" -exec "node server.js"
