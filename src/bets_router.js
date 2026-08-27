// src/bets_router.js — /api/bets/* personal bet tracking endpoints (Phase B).
// Mounted in index.js: app.use('/api/bets', require('./src/bets_router')).
// Every route is owner-scoped to the session user. None require a paid tier —
// personal tracking is free; the trust moat is verification, not a paywall.

const express = require('express');
const router  = express.Router();
const ub      = require('./user_bets');

function uid(req) { return req?.session?.user?.id || null; }

router.use(express.json());
router.use((req, res, next) => {
  if (!uid(req)) return res.status(401).json({ error: 'Login required' });
  next();
});

// Wrap a handler so thrown {status,message} errors become clean JSON responses.
function send(res, fn) {
  try { return res.json(fn()); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
}
async function sendAsync(res, fn) {
  try { return res.json(await fn()); }
  catch (e) { return res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
}

// Create a manual/custom bet.
router.post('/', (req, res) => send(res, () => ({ bet: ub.createBet(uid(req), req.body || {}) })));

// Summary feed (declared before /:id routes; it's GET so there's no param clash).
router.get('/summary', (req, res) => send(res, () => ub.betSummary(uid(req), String(req.query.window || 'all').toLowerCase())));

// List the user's bets (?status=pending|settled|all&sport=&limit=&offset=).
router.get('/', (req, res) => send(res, () => ub.listBets(uid(req), {
  status: req.query.status, sport: req.query.sport, limit: req.query.limit, offset: req.query.offset,
})));

// Edit a pending bet.
router.put('/:id', (req, res) => send(res, () => ({ bet: ub.updateBet(uid(req), Number(req.params.id), req.body || {}) })));

// Delete a bet.
router.delete('/:id', (req, res) => send(res, () => ub.deleteBet(uid(req), Number(req.params.id))));

// Manually settle a non-game-linked bet.
router.post('/:id/settle', (req, res) => send(res, () => ({ bet: ub.settleBet(uid(req), Number(req.params.id), (req.body || {}).result) })));

// Share payload for one of the owner's bets: the signed card URL plus the caption.
// Owner-scoped, so a token is only ever minted for a bet the caller actually holds.
router.get('/:id/share', (req, res) => send(res, () => {
  const id = Number(req.params.id);
  const bet = ub.getBet(uid(req), id);
  if (!bet) { const e = new Error('Bet not found.'); e.status = 404; throw e; }
  const card = require('./bet_card');
  return {
    image_url: `/og/bet/${id}.png?t=${card.tokenFor(id)}`,
    text: card.shareText(id),
    site: 'https://cappingalpha.com',
    available: card.available(),
  };
}));

module.exports = router;
