// src/product_mode.js — THE product switch (docs/V2_DATABASE_PLAN.md section 9).
//
// settings.product_mode is 'v1' (default: nothing public changes) or 'v2' (the
// capper database). One helper answers "which product is this request seeing":
//
//   getProductMode(req) -> 'v1' | 'v2'
//
// Admin preview: an admin session plus ?mode=v2 on ANY request flips that
// browser's session into V2 (?mode=v1 flips it back). The flag lives on the
// admin session, so it never leaks to other visitors and dies with the login.
// productModeMiddleware captures the query param before the routes run (the
// /game/:id redirect drops the query string, so the flag must be taken early).

const db = require('./db');

function getProductMode(req) {
  const setting = db.getSetting('product_mode', 'v1') === 'v2' ? 'v2' : 'v1';
  if (setting === 'v2') return 'v2';
  if (req && req.session && req.session.admin && req.session.v2_preview) return 'v2';
  return 'v1';
}

function isV2(req) { return getProductMode(req) === 'v2'; }

function isPreview(req) {
  return !!(req && req.session && req.session.admin && req.session.v2_preview)
    && db.getSetting('product_mode', 'v1') !== 'v2';
}

function productModeMiddleware(req, _res, next) {
  try {
    const m = req.query && req.query.mode;
    if (m && req.session && req.session.admin) {
      if (m === 'v2') req.session.v2_preview = true;
      else if (m === 'v1') req.session.v2_preview = false;
    }
  } catch (_) {}
  next();
}

module.exports = { getProductMode, isV2, isPreview, productModeMiddleware };
