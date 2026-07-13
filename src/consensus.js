// src/consensus.js — the CA consensus line.
//
// A no-vig, Pinnacle-anchored blend of every stored book for a game: de-vig
// each book's moneyline pair into a fair win probability, weighted-average
// them (sharp books count more), and take weighted medians of the spread and
// total lines. This is the same product Unabated sells as "the Unabated Line";
// once the books are aggregated it is one page of math.
//
// Lock rule: the compute skips started games, so the stored consensus freezes
// at the closing consensus exactly like book_lines. Recomputed on a cron for
// pre-game games only. Display and analytics only — never a grading input.

const db = require('./db');

// Sharp anchors count more than recreational books.
const BOOK_WEIGHT = { pinnacle: 3, bovada: 1.5, betonline: 1.5 };
const weightOf = (book) => BOOK_WEIGHT[book] ?? 1;

const MIN_BOOKS = 3;

const impliedProb = (odds) => (odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100));
const toAmerican = (p) => {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
};

function weightedMedian(pairs) { // pairs = [{ v, w }]
  const items = pairs.filter((x) => x.v != null && isFinite(x.v)).sort((a, b) => a.v - b.v);
  if (!items.length) return null;
  const total = items.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of items) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return items[items.length - 1].v;
}

// Compute one game's consensus from its book_lines rows. Returns null when
// fewer than MIN_BOOKS books carry a moneyline pair.
function computeConsensus(rows) {
  const mlBooks = rows.filter((r) => r.ml_home != null && r.ml_away != null);
  if (mlBooks.length < MIN_BOOKS) return null;

  let pSum = 0, wSum = 0;
  for (const r of mlBooks) {
    const ph = impliedProb(r.ml_home), pa = impliedProb(r.ml_away);
    const fair = ph / (ph + pa); // de-vig: normalize the overround away
    const w = weightOf(r.book);
    pSum += fair * w;
    wSum += w;
  }
  const homeProb = pSum / wSum;

  const spreadHome = weightedMedian(rows.map((r) => ({ v: r.spread_home, w: weightOf(r.book) })));
  const total      = weightedMedian(rows.map((r) => ({ v: r.over_under,  w: weightOf(r.book) })));

  return {
    books_used: mlBooks.length,
    home_prob: +homeProb.toFixed(4),
    away_prob: +(1 - homeProb).toFixed(4),
    ml_home: toAmerican(homeProb),
    ml_away: toAmerican(1 - homeProb),
    spread_home: spreadHome,
    spread_away: spreadHome != null ? -spreadHome : null,
    over_under: total,
  };
}

// Cron entry: recompute for every game that has not started. Started games
// keep their last pre-start consensus (the closing consensus).
function refreshConsensus() {
  let updated = 0;
  try {
    const games = db.prepare(`
      SELECT espn_game_id, start_time, status FROM today_games
      WHERE status = 'pre'
        AND (start_time IS NULL OR datetime(replace(substr(start_time, 1, 19), 'T', ' ')) > datetime('now'))
    `).all();
    if (!games.length) return 0;
    const linesFor = db.prepare(`SELECT book, ml_home, ml_away, spread_home, over_under FROM book_lines WHERE espn_game_id = ?`);
    const up = db.prepare(`
      INSERT INTO ca_consensus
        (espn_game_id, books_used, ml_home, ml_away, home_prob, away_prob,
         spread_home, spread_away, over_under, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(espn_game_id) DO UPDATE SET
        books_used  = excluded.books_used,
        ml_home     = excluded.ml_home,
        ml_away     = excluded.ml_away,
        home_prob   = excluded.home_prob,
        away_prob   = excluded.away_prob,
        spread_home = excluded.spread_home,
        spread_away = excluded.spread_away,
        over_under  = excluded.over_under,
        updated_at  = datetime('now')
    `);
    const run = db.transaction(() => {
      for (const g of games) {
        const c = computeConsensus(linesFor.all(g.espn_game_id));
        if (!c) continue;
        up.run(
          g.espn_game_id, c.books_used, c.ml_home, c.ml_away, c.home_prob, c.away_prob,
          c.spread_home, c.spread_away, c.over_under
        );
        updated++;
      }
      // Consensus rows for games the prune removed have no read path left.
      db.prepare(`DELETE FROM ca_consensus WHERE espn_game_id NOT IN (SELECT espn_game_id FROM today_games)`).run();
    });
    run();
  } catch (err) {
    console.error('[consensus] refresh failed:', err.message);
  }
  return updated;
}

function getConsensusForGame(espn_game_id) {
  try {
    return db.prepare(`SELECT * FROM ca_consensus WHERE espn_game_id = ?`).get(espn_game_id) || null;
  } catch (_) { return null; }
}

module.exports = { refreshConsensus, getConsensusForGame, computeConsensus };
