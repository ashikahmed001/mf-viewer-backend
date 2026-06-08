import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import logger from '../logger.js';
import { runNavSync } from '../jobs/navSync.js';

const router = Router();
const MFAPI = 'https://api.mfapi.in/mf';

// ─── All-schemes cache (refreshed every 24 h) ─────────────────────────────────
let schemesCache   = null;
let schemesCachedAt = 0;
const SCHEMES_TTL  = 24 * 60 * 60 * 1000; // 24 hours

async function getAllSchemes() {
  if (schemesCache && Date.now() - schemesCachedAt < SCHEMES_TTL) return schemesCache;
  logger.info('Fetching full AMFI scheme list from mfapi.in…');
  const raw = await fetchJson(MFAPI);                          // returns [{schemeCode, schemeName}]
  schemesCache   = raw.map(m => ({ scheme_code: String(m.schemeCode), scheme_name: m.schemeName }));
  schemesCachedAt = Date.now();
  logger.info(`AMFI cache loaded — ${schemesCache.length} schemes`);
  return schemesCache;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`mfapi.in returned ${res.status} for ${url}`);
  return res.json();
}

async function q(sql, args = []) {
  const r = await getDb().execute({ sql, args });
  return Array.from(r.rows);
}

async function q1(sql, args = []) {
  const r = await getDb().execute({ sql, args });
  return r.rows[0] ?? null;
}

async function exec(sql, args = []) {
  return getDb().execute({ sql, args });
}

// Name similarity score + Growth/IDCW preference
function nameSimilarity(fundName, schemeName) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const fundWords   = new Set(normalize(fundName));
  const schemeWords = normalize(schemeName);
  let hits = 0;
  for (const w of schemeWords) if (fundWords.has(w)) hits++;
  let score = hits / Math.max(fundWords.size, 1);

  const lower = schemeName.toLowerCase();
  // Boost Growth / Direct Growth options
  if (lower.includes('growth') && !lower.includes('idcw')) score += 0.15;
  // Extra boost for Direct plan (typically preferred for tracking)
  if (lower.includes('direct')) score += 0.05;
  // Penalise IDCW / Dividend options
  if (lower.includes('idcw') || lower.includes('dividend')) score -= 0.3;

  return score;
}

// ─── GET /api/nav/schemes/all — full AMFI list for client-side search ────────
router.get('/schemes/all', requireAdmin, async (req, res) => {
  try {
    const schemes = await getAllSchemes();
    res.json(schemes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/nav/search?q= — search mfapi.in and return scored results ───────
router.get('/search', requireAdmin, async (req, res) => {
  const { q, fund_name } = req.query;
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const matches = await fetchJson(`${MFAPI}/search?q=${encodeURIComponent(q)}`);
    if (!matches?.length) return res.json([]);
    const scored = matches
      .map(m => ({
        scheme_code: String(m.schemeCode),
        scheme_name: m.schemeName,
        score: fund_name ? nameSimilarity(fund_name, m.schemeName) : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    res.json(scored);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/nav/mappings — all funds with their current mapping status ──────
router.get('/mappings', requireAdmin, async (req, res) => {
  try {
    const rows = await q(`
      SELECT f.id, f.name,
             m.scheme_code, m.scheme_name, m.confirmed, m.synced_at,
             (SELECT COUNT(*) FROM nav_history n WHERE n.scheme_code = m.scheme_code) AS nav_rows
      FROM funds f
      LEFT JOIN fund_nav_map m ON m.fund_id = f.id
      ORDER BY f.name
    `);
    res.json(rows);
  } catch (err) {
    logger.error('GET /api/nav/mappings failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/nav/auto-match — search mfapi.in for all unmapped funds ────────
router.post('/auto-match', requireAdmin, async (req, res) => {
  try {
    const funds = await q(`
      SELECT f.id, f.name FROM funds f
      LEFT JOIN fund_nav_map m ON m.fund_id = f.id
      WHERE m.fund_id IS NULL
      ORDER BY f.name
    `);

    logger.info(`auto-match — searching mfapi.in for ${funds.length} unmapped fund(s)`);
    const results = [];

    for (const fund of funds) {
      // Use first ~4 meaningful words for search
      const searchQ = fund.name.split(/\s+/).slice(0, 4).join(' ');
      try {
        const matches = await fetchJson(`${MFAPI}/search?q=${encodeURIComponent(searchQ)}`);
        if (!matches?.length) { results.push({ fund_id: fund.id, fund_name: fund.name, candidates: [] }); continue; }

        // Score and rank
        const scored = matches
          .map(m => ({ scheme_code: String(m.schemeCode), scheme_name: m.schemeName, score: nameSimilarity(fund.name, m.schemeName) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        const top = scored[0];

        if (top.score >= 0.7) {
          // High confidence — auto-confirm AND sync immediately, no manual steps needed
          await exec(
            `INSERT OR REPLACE INTO fund_nav_map (fund_id, scheme_code, scheme_name, confirmed) VALUES (?,?,?,1)`,
            [fund.id, top.scheme_code, top.scheme_name]
          );
          try {
            const nav_rows = await syncFundNav(fund.id, top.scheme_code);
            logger.ok(`auto-match+sync — "${fund.name}"  score=${top.score.toFixed(2)}  ${nav_rows} rows`);
            results.push({ fund_id: fund.id, fund_name: fund.name, candidates: scored, auto_confirmed: true, nav_rows });
          } catch (syncErr) {
            logger.warn(`auto-match — sync failed for "${fund.name}": ${syncErr.message}`);
            results.push({ fund_id: fund.id, fund_name: fund.name, candidates: scored, auto_confirmed: true, nav_rows: 0 });
          }
        } else if (top.score >= 0.5) {
          // Medium confidence — save as unconfirmed, needs manual confirmation
          await exec(
            `INSERT OR REPLACE INTO fund_nav_map (fund_id, scheme_code, scheme_name, confirmed) VALUES (?,?,?,0)`,
            [fund.id, top.scheme_code, top.scheme_name]
          );
          results.push({ fund_id: fund.id, fund_name: fund.name, candidates: scored, auto_confirmed: false });
        } else {
          results.push({ fund_id: fund.id, fund_name: fund.name, candidates: scored, auto_confirmed: false });
        }
      } catch (e) {
        logger.warn(`auto-match — failed for "${fund.name}": ${e.message}`);
        results.push({ fund_id: fund.id, fund_name: fund.name, candidates: [], error: e.message });
      }
    }

    logger.ok(`auto-match — done  ${results.length} fund(s)`);
    res.json(results);
  } catch (err) {
    logger.error('POST /api/nav/auto-match failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Shared sync helper ───────────────────────────────────────────────────────
async function syncFundNav(fundId, scheme_code) {
  const data = await fetchJson(`${MFAPI}/${scheme_code}`);
  if (!data?.data?.length) return 0;

  const db = getDb();
  const CHUNK = 500;
  const rows = data.data;

  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(
      rows.slice(i, i + CHUNK).map(r => ({
        sql:  'INSERT OR IGNORE INTO nav_history (scheme_code, nav_date, nav) VALUES (?,?,?)',
        args: [scheme_code, r.date, parseFloat(r.nav)],
      })),
      'write'
    );
  }

  await exec('UPDATE fund_nav_map SET synced_at = ? WHERE fund_id = ?', [new Date().toISOString(), fundId]);
  return rows.length;
}

// ─── POST /api/nav/confirm/:fundId — confirm (or change) a mapping ────────────
router.post('/confirm/:fundId', requireAdmin, async (req, res) => {
  const { fundId } = req.params;
  const { scheme_code, scheme_name } = req.body;
  if (!scheme_code || !scheme_name) return res.status(400).json({ error: 'scheme_code and scheme_name required' });

  try {
    await exec(
      `INSERT OR REPLACE INTO fund_nav_map (fund_id, scheme_code, scheme_name, confirmed) VALUES (?,?,?,1)`,
      [fundId, scheme_code, scheme_name]
    );
    logger.ok(`nav confirm — fund=${fundId}  scheme=${scheme_code}  "${scheme_name}"`);

    // Auto-sync immediately after confirming — no manual sync step needed
    try {
      const nav_rows = await syncFundNav(fundId, scheme_code);
      logger.ok(`nav confirm+sync — fund=${fundId}  ${nav_rows} rows`);
      res.json({ fund_id: parseInt(fundId), scheme_code, scheme_name, confirmed: 1, nav_rows });
    } catch (syncErr) {
      // Confirm succeeded even if sync fails — report both
      logger.warn(`nav confirm — sync failed for fund=${fundId}: ${syncErr.message}`);
      res.json({ fund_id: parseInt(fundId), scheme_code, scheme_name, confirmed: 1, nav_rows: 0, sync_error: syncErr.message });
    }
  } catch (err) {
    logger.error('POST /api/nav/confirm failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/nav/sync/:fundId — fetch + store full NAV history ──────────────
router.post('/sync/:fundId', requireAdmin, async (req, res) => {
  const { fundId } = req.params;
  try {
    const mapping = await q1('SELECT scheme_code, scheme_name FROM fund_nav_map WHERE fund_id = ?', [fundId]);
    if (!mapping) return res.status(404).json({ error: 'No mapping found for this fund — run auto-match or confirm first' });

    logger.info(`nav sync — fund=${fundId}  scheme=${mapping.scheme_code}`);
    const nav_rows = await syncFundNav(fundId, mapping.scheme_code);
    if (!nav_rows) return res.status(404).json({ error: 'No NAV data returned from mfapi.in' });

    logger.ok(`nav sync — fund=${fundId}  ${nav_rows} rows`);
    res.json({ fund_id: parseInt(fundId), scheme_code: mapping.scheme_code, nav_rows });
  } catch (err) {
    logger.error('POST /api/nav/sync failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/nav/sync-all — sync all confirmed mappings ─────────────────────
router.post('/sync-all', requireAdmin, async (req, res) => {
  try {
    const mappings = await q('SELECT fund_id, scheme_code FROM fund_nav_map WHERE confirmed = 1');
    logger.info(`nav sync-all — ${mappings.length} confirmed mapping(s)`);
    const results = [];
    for (const m of mappings) {
      try {
        const nav_rows = await syncFundNav(m.fund_id, m.scheme_code);
        results.push({ fund_id: m.fund_id, nav_rows, ok: true });
      } catch (e) {
        results.push({ fund_id: m.fund_id, ok: false, error: e.message });
      }
    }
    res.json(results);
  } catch (err) {
    logger.error('POST /api/nav/sync-all failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/nav/sync-latest — manually trigger the daily sync job ──────────
router.post('/sync-latest', requireAdmin, async (req, res) => {
  try {
    logger.info('nav sync-latest — triggered manually via Admin UI');
    // Run in background so the request returns immediately
    runNavSync()
      .then(() => logger.ok('nav sync-latest — completed'))
      .catch(e => logger.error('nav sync-latest — failed:', e.message));

    res.json({ ok: true, message: 'NAV sync started — this runs in the background and may take a few minutes.' });
  } catch (err) {
    logger.error('nav sync-latest trigger failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/nav/mapping/:fundId — remove NAV mapping for a fund ──────────
router.delete('/mapping/:fundId', requireAdmin, async (req, res) => {
  const { fundId } = req.params;
  try {
    const mapping = await q1('SELECT scheme_code FROM fund_nav_map WHERE fund_id = ?', [fundId]);
    if (!mapping) return res.status(404).json({ error: 'No mapping found for this fund' });

    // Remove mapping (keep nav_history — scheme_code may be shared)
    await exec('DELETE FROM fund_nav_map WHERE fund_id = ?', [fundId]);

    logger.ok(`NAV mapping removed for fund ${fundId} (was scheme ${mapping.scheme_code})`);
    res.json({ ok: true, fund_id: Number(fundId) });
  } catch (err) {
    logger.error('DELETE /api/nav/mapping/:fundId failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/nav/:fundId — NAV history for a fund (public, auth only) ────────
router.get('/:fundId', async (req, res) => {
  try {
    const mapping = await q1('SELECT scheme_code, scheme_name FROM fund_nav_map WHERE fund_id = ?', [req.params.fundId]);
    if (!mapping) return res.json({ mapped: false });

    const history = await q(
      'SELECT nav_date, nav FROM nav_history WHERE scheme_code = ? ORDER BY nav_date ASC',
      [mapping.scheme_code]
    );

    res.json({ mapped: true, scheme_code: mapping.scheme_code, scheme_name: mapping.scheme_name, history });
  } catch (err) {
    logger.error('GET /api/nav/:fundId failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
