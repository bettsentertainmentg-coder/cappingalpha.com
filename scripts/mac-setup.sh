#!/bin/bash
# scripts/mac-setup.sh — bring the whole CappingAlpha Mac side up on any machine.
# Idempotent: safe to re-run. See docs/MAC_SETUP.md for the full runbook.
set -e
cd "$(dirname "$0")/.."

echo "== CappingAlpha Mac setup =="

command -v node >/dev/null || { echo "Node is required (20+). Install it first."; exit 1; }
command -v pm2 >/dev/null || { echo "Installing pm2..."; npm install -g pm2; }

echo "-- Installing dependencies"
npm install --no-audit --no-fund

if [ ! -f .env ]; then
  echo "!! No .env found in $(pwd)."
  echo "   Copy it from the old machine, then re-run. Required vars:"
  echo "   RELAY_SECRET, RAILWAY_URL (+ see docs/MAC_SETUP.md for the rest)"
  exit 1
fi

# Warn (not fail) on missing relay vars — capperboss dev can still run without them.
for v in RELAY_SECRET RAILWAY_URL; do
  grep -q "^${v}=" .env || echo "!! .env is missing ${v} (odds-engine and pb-relay need it)"
done

STUDIO="$HOME/projects/cappingalpha-studio"
if [ -d "$STUDIO" ]; then
  echo "-- Studio found; installing its dependencies"
  (cd "$STUDIO" && npm install --no-audit --no-fund)
else
  echo "-- No studio at $STUDIO (fine; comment its block out of ecosystem.config.js if pm2 complains)"
fi

echo "-- Starting everything via pm2"
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "== Done. =="
echo "Next steps:"
echo "  1. pm2 startup   (run the command it prints, then: pm2 save)"
echo "  2. Open /admin/health on the site; odds-engine + pb-relay should check in shortly"
