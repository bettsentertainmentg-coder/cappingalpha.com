#!/bin/bash
# Backup MVP picks FROM Railway (the source of truth) TO the local Mac.
#
# The server is canonical: this is the DEFAULT direction. It pulls the server's
# MVP record down, saves a timestamped JSON backup on the Mac, and mirrors the
# picks into the local DB so local reflects the server (the server decides).
#
# Reverse of export-mvp.sh (which pushes local -> server, now only for the rare
# case of pushing a genuinely-missing local pick up).
#
# Source endpoint: /api/mvp/public — returns resolved (win/loss/push) picks with
# full columns, no auth. Pending / "not counted" picks are not exposed there, so
# this mirror is additive: local-only pending picks are preserved, never deleted.
#
# Usage: bash scripts/backup-mvp.sh

set -e

DB="/Users/jack/projects/capperboss/data/capper.db"
URL="https://cappingalpha.com/api/mvp/public"
BACKUP_DIR="/Users/jack/projects/capperboss/data/mvp-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
RAW="$BACKUP_DIR/mvp-server-$STAMP.json"
LATEST="$BACKUP_DIR/mvp-server-latest.json"

mkdir -p "$BACKUP_DIR"

echo "Pulling MVP picks from server ($URL)..."
curl -s "$URL" -H "User-Agent: Mozilla/5.0" -o "$RAW"
cp "$RAW" "$LATEST"

COUNT=$(python3 -c "import json; print(len(json.load(open('$RAW')).get('picks', [])))")
echo "Server returned $COUNT picks. Backup saved: $RAW"

# Mirror into the local DB — server wins. Stop the app first for a clean write
# (resolveConflictingMvpPicks runs on a 5-min cron and also writes mvp_picks).
pm2 stop capperboss
python3 - "$DB" "$RAW" <<'PY'
import json, sqlite3, sys
db_path, raw = sys.argv[1], sys.argv[2]
picks = json.load(open(raw)).get('picks', [])

# Every column on mvp_picks is present in the server response, so REPLACE the
# full row — no column is omitted (an omitted column would null out on REPLACE).
cols = ['id','team','sport','pick_type','spread','original_line','game_date',
        'score','result','saved_at','espn_game_id','home_score','away_score',
        'ml_odds','ou_odds','annotation','home_team','away_team']
placeholders = ','.join('?' for _ in cols)
sql = f"INSERT OR REPLACE INTO mvp_picks ({','.join(cols)}) VALUES ({placeholders})"

con = sqlite3.connect(db_path)
before = con.execute("SELECT COUNT(*) FROM mvp_picks").fetchone()[0]
con.executemany(sql, [[p.get(c) for c in cols] for p in picks])
con.commit()
after = con.execute("SELECT COUNT(*) FROM mvp_picks").fetchone()[0]
con.close()
print(f"Mirrored {len(picks)} server picks. Local total: {before} -> {after} "
      f"(local-only pending picks preserved).")
PY
pm2 start capperboss
echo "Done. Server is the source of truth; local now mirrors it."
