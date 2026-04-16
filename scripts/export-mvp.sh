#!/bin/bash
# Export MVP picks from local DB and import to Railway
# Run this after any Railway redeploy to restore MVP history
# Usage: bash scripts/export-mvp.sh

set -e

DB="/Users/jack/projects/capperboss/data/capper.db"
TMP="/tmp/mvp_export.json"
URL="https://cappingalpha.com/admin/import-mvp"

# Stop PM2 briefly to get clean snapshot
pm2 stop capperboss
sqlite3 "$DB" -json "SELECT * FROM mvp_picks" > "$TMP"
pm2 start capperboss

COUNT=$(python3 -c "import json; d=json.load(open('$TMP')); print(len(d))")
echo "Exporting $COUNT MVP picks to Railway..."

RESULT=$(curl -s -X POST "$URL" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  --data-binary @"$TMP")

echo "Railway response: $RESULT"
