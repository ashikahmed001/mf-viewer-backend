import { Router } from 'express';
import { createReadStream, statSync } from 'fs';
import { createGzip } from 'zlib';
import { getDb, getLocalDbPath } from '../db/connection.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { invalidate, cacheStats, cacheKeys, isCacheEnabled, setCacheEnabled } from '../cache.js';
import logger from '../logger.js';
import uploadRouter from './upload.js';
import { syncState, runStocksSync } from '../jobs/stocksSync.js';

const router = Router();

// All admin routes are protected by requireAdmin
router.use(requireAdmin);

// Upload / extraction import routes (/upload/single, /upload/batch, /import)
router.use(uploadRouter);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isEquityIsin(isin) {
  return /^INE[A-Z0-9]{4}01[0-9A-Z]{3}$/.test(isin);
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

// ─── ISIN Issues ─────────────────────────────────────────────────────────────
router.get('/isin-issues', async (req, res) => {
  try {
    const rows = await q(`
      SELECT
        SUBSTR(h.isin, 1, 7)          AS company_code,
        h.isin,
        h.stock_name,
        COUNT(*)                       AS row_count,
        MIN(e.report_month)            AS first_month,
        MAX(e.report_month)            AS last_month
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      GROUP BY h.isin
      ORDER BY company_code, h.isin
    `);

    const byCode = {};
    for (const r of rows) {
      if (!isEquityIsin(r.isin)) continue;
      if (!byCode[r.company_code]) byCode[r.company_code] = [];
      byCode[r.company_code].push(r);
    }

    const issues = Object.entries(byCode)
      .filter(([, arr]) => arr.length > 1)
      .map(([company_code, isins]) => ({ company_code, isins }))
      .sort((a, b) => a.isins[0].stock_name.localeCompare(b.isins[0].stock_name));

    res.json(issues);
  } catch (err) {
    logger.error('admin/isin-issues:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Apply ISIN Remap ─────────────────────────────────────────────────────────
router.post('/isin-remap', async (req, res) => {
  const { old_isin, new_isin } = req.body;
  if (!old_isin || !new_isin) return res.status(400).json({ error: 'old_isin and new_isin required' });
  if (old_isin === new_isin) return res.status(400).json({ error: 'old and new ISIN are the same' });

  try {
    const nameRow = await q1('SELECT stock_name FROM holdings WHERE isin = ? LIMIT 1', [new_isin]);
    const canonicalName = nameRow?.stock_name;
    if (!canonicalName) return res.status(404).json({ error: `New ISIN ${new_isin} not found in holdings` });

    const countRow = await q1('SELECT COUNT(*) AS n FROM holdings WHERE isin = ?', [old_isin]);
    const oldCount = Number(countRow?.n ?? 0);
    if (oldCount === 0) return res.status(404).json({ error: `Old ISIN ${old_isin} not found in holdings` });

    // Move non-duplicate rows then delete remaining
    const moveResult = await exec(`
      UPDATE holdings SET isin = ?, stock_name = ?
      WHERE isin = ?
        AND extraction_id NOT IN (SELECT extraction_id FROM holdings WHERE isin = ?)
    `, [new_isin, canonicalName, old_isin, new_isin]);

    const deleteResult = await exec('DELETE FROM holdings WHERE isin = ?', [old_isin]);

    const moved   = Number(moveResult.rowsAffected ?? 0);
    const deleted = Number(deleteResult.rowsAffected ?? 0);

    logger.ok(`Admin ISIN remap: ${old_isin} → ${new_isin}  moved=${moved}  dupes_deleted=${deleted}`);
    res.json({ old_isin, new_isin, canonical_name: canonicalName, moved, duplicates_deleted: deleted, total_before: oldCount });
  } catch (err) {
    logger.error('admin/isin-remap:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Name Issues ──────────────────────────────────────────────────────────────
router.get('/name-issues', async (req, res) => {
  try {
    const rows = await q(`
      SELECT
        h.isin,
        h.stock_name,
        COUNT(*)            AS row_count,
        MIN(e.report_month) AS first_month,
        MAX(e.report_month) AS last_month
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      GROUP BY h.isin, h.stock_name
      ORDER BY h.isin, MAX(e.report_month) DESC
    `);

    const byIsin = {};
    for (const r of rows) {
      if (!byIsin[r.isin]) byIsin[r.isin] = [];
      byIsin[r.isin].push(r);
    }

    const issues = Object.entries(byIsin)
      .filter(([, arr]) => arr.length > 1)
      .map(([isin, names]) => ({ isin, names }))
      .sort((a, b) => b.names.length - a.names.length);

    res.json(issues);
  } catch (err) {
    logger.error('admin/name-issues:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Apply Name Fix ──────────────────────────────────────────────────────────
router.post('/name-fix', async (req, res) => {
  const { isin, canonical_name } = req.body;
  if (!isin || !canonical_name) return res.status(400).json({ error: 'isin and canonical_name required' });

  try {
    const result = await exec('UPDATE holdings SET stock_name = ? WHERE isin = ?', [canonical_name, isin]);
    const rows_updated = Number(result.rowsAffected ?? 0);
    logger.ok(`Admin name fix: ${isin} → "${canonical_name}"  rows=${rows_updated}`);
    res.json({ isin, canonical_name, rows_updated });
  } catch (err) {
    logger.error('admin/name-fix:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /admin/name-fix-batch — fix multiple ISINs in one request ───────────
router.post('/name-fix-batch', async (req, res) => {
  const { fixes } = req.body; // [{ isin, canonical_name }, ...]
  if (!Array.isArray(fixes) || fixes.length === 0)
    return res.status(400).json({ error: 'fixes array is required' });

  try {
    const db = getDb();
    let total_rows = 0;
    const results = [];

    // Run all UPDATEs in parallel — each is a single indexed query, fast
    await Promise.all(fixes.map(async ({ isin, canonical_name }) => {
      if (!isin || !canonical_name) return;
      const r = await db.execute({
        sql:  'UPDATE holdings SET stock_name = ? WHERE isin = ?',
        args: [canonical_name, isin],
      });
      const rows_updated = Number(r.rowsAffected ?? 0);
      total_rows += rows_updated;
      results.push({ isin, canonical_name, rows_updated });
    }));

    logger.ok(`Admin name-fix-batch: ${fixes.length} ISINs, ${total_rows} rows updated`);
    res.json({ fixed: results.length, total_rows, results });
  } catch (err) {
    logger.error('admin/name-fix-batch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Overlap ISIN Scanner ────────────────────────────────────────────────────
router.get('/scan-overlapping', async (req, res) => {
  try {
    const rows = await q(`
      SELECT
        SUBSTR(h.isin, 1, 7)          AS company_code,
        h.isin,
        h.stock_name,
        COUNT(*)                       AS months,
        MIN(e.report_month)            AS first_month,
        MAX(e.report_month)            AS last_month
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      GROUP BY h.isin
    `);

    const equityRows = rows.filter(r => isEquityIsin(r.isin));
    const byCode = {};
    for (const r of equityRows) {
      if (!byCode[r.company_code]) byCode[r.company_code] = [];
      byCode[r.company_code].push(r);
    }

    const candidates = [];
    for (const [, isins] of Object.entries(byCode)) {
      if (isins.length < 2) continue;
      isins.sort((a, b) => a.first_month.localeCompare(b.first_month));
      for (let i = 0; i < isins.length - 1; i++) {
        for (let j = i + 1; j < isins.length; j++) {
          const old_r = isins[i], new_r = isins[j];
          if (new_r.first_month <= old_r.first_month) continue;
          candidates.push({
            old_isin: old_r.isin, new_isin: new_r.isin,
            stock_name: old_r.stock_name,
            old_first: old_r.first_month, old_last: old_r.last_month, old_months: old_r.months,
            new_first: new_r.first_month, new_last: new_r.last_month, new_months: new_r.months,
            overlapping: new_r.first_month <= old_r.last_month,
          });
        }
      }
    }

    candidates.sort((a, b) => a.stock_name.localeCompare(b.stock_name));
    res.json(candidates);
  } catch (err) {
    logger.error('admin/scan-overlapping:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fund List ────────────────────────────────────────────────────────────────
router.get('/funds', async (req, res) => {
  try {
    const funds = await q(`
      SELECT
        f.id,
        f.name,
        COUNT(DISTINCT e.id)           AS extraction_count,
        MIN(e.report_month)            AS first_month,
        MAX(e.report_month)            AS last_month,
        SUM(h_count.cnt)               AS total_holdings
      FROM funds f
      LEFT JOIN extractions e ON e.fund_id = f.id
      LEFT JOIN (
        SELECT extraction_id, COUNT(*) AS cnt FROM holdings GROUP BY extraction_id
      ) h_count ON h_count.extraction_id = e.id
      GROUP BY f.id
      ORDER BY f.name
    `);
    res.json(funds);
  } catch (err) {
    logger.error('admin/funds:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fund Months ─────────────────────────────────────────────────────────────
router.get('/funds/:id/months', async (req, res) => {
  try {
    const fund = await q1('SELECT id, name FROM funds WHERE id = ?', [req.params.id]);
    if (!fund) return res.status(404).json({ error: 'Fund not found' });
    const rows = await q('SELECT report_month FROM extractions WHERE fund_id = ? ORDER BY report_month', [req.params.id]);
    res.json({ id: fund.id, name: fund.name, months: rows.map(r => r.report_month) });
  } catch (err) {
    logger.error('admin/funds/months:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── List extractions for a fund (with holding count) ────────────────────────
router.get('/funds/:id/extractions', async (req, res) => {
  try {
    const fund = await q1('SELECT id, name FROM funds WHERE id = ?', [req.params.id]);
    if (!fund) return res.status(404).json({ error: 'Fund not found' });
    const rows = await q(`
      SELECT e.id, e.report_month,
             COUNT(h.id) AS holding_count
      FROM extractions e
      LEFT JOIN holdings h ON h.extraction_id = e.id
      WHERE e.fund_id = ?
      GROUP BY e.id
      ORDER BY e.report_month DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    logger.error('admin/funds/extractions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk delete extractions (MUST be before /extractions/:id) ───────────────
router.delete('/extractions/bulk', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  try {
    const statements = [
      ...ids.map(id => ({ sql: 'DELETE FROM holdings WHERE extraction_id = ?', args: [id] })),
      ...ids.map(id => ({ sql: 'DELETE FROM extractions WHERE id = ?', args: [id] })),
    ];
    await getDb().batch(statements, 'write');
    logger.ok(`Admin bulk extraction delete: ${ids.length} extractions`);
    invalidate('*');
    res.json({ deleted: ids.length });
  } catch (err) {
    logger.error('admin/extractions/bulk-delete:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete a single extraction + its holdings ────────────────────────────────
router.delete('/extractions/:id', async (req, res) => {
  const extId = parseInt(req.params.id, 10);
  if (!extId) return res.status(400).json({ error: 'Invalid extraction id' });
  try {
    const ext = await q1('SELECT id, fund_id, report_month FROM extractions WHERE id = ?', [extId]);
    if (!ext) return res.status(404).json({ error: `Extraction ${extId} not found` });
    const countRow = await q1('SELECT COUNT(*) AS cnt FROM holdings WHERE extraction_id = ?', [extId]);
    await getDb().batch([
      { sql: 'DELETE FROM holdings WHERE extraction_id = ?', args: [extId] },
      { sql: 'DELETE FROM extractions WHERE id = ?', args: [extId] },
    ], 'write');
    logger.ok(`Admin extraction delete: id=${extId} month=${ext.report_month} fund=${ext.fund_id} holdings=${countRow.cnt}`);
    invalidate('*');
    res.json({ deleted: true, extraction_id: extId, report_month: ext.report_month, holdings_deleted: Number(countRow.cnt) });
  } catch (err) {
    logger.error('admin/extractions/delete:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Rename Fund ──────────────────────────────────────────────────────────────
router.put('/funds/:id/rename', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  try {
    const existing = await q1('SELECT id, name FROM funds WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: `Fund ${id} not found` });

    await exec('UPDATE funds SET name = ? WHERE id = ?', [name.trim(), id]);
    logger.ok(`Admin fund rename: [${id}] "${existing.name}" → "${name.trim()}"`);
    invalidate('/api/funds');  // bust funds list + fund detail cache
    res.json({ id, old_name: existing.name, new_name: name.trim() });
  } catch (err) {
    logger.error('admin/funds/rename:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Merge Funds ──────────────────────────────────────────────────────────────
router.post('/funds/merge', async (req, res) => {
  const { source_id, target_id } = req.body;
  if (!source_id || !target_id) return res.status(400).json({ error: 'source_id and target_id required' });
  if (source_id === target_id) return res.status(400).json({ error: 'source and target are the same fund' });

  try {
    const [source, target] = await Promise.all([
      q1('SELECT id, name FROM funds WHERE id = ?', [source_id]),
      q1('SELECT id, name FROM funds WHERE id = ?', [target_id]),
    ]);
    if (!source) return res.status(404).json({ error: `Source fund ${source_id} not found` });
    if (!target) return res.status(404).json({ error: `Target fund ${target_id} not found` });

    // Find target months to detect conflicts
    const targetMonthRows = await q('SELECT report_month FROM extractions WHERE fund_id = ?', [target_id]);
    const targetMonths = targetMonthRows.map(r => r.report_month);

    let deletedExtractions = 0;

    if (targetMonths.length > 0) {
      // Find conflicting source extractions
      const ph = targetMonths.map(() => '?').join(',');
      const conflicting = await q(
        `SELECT id FROM extractions WHERE fund_id = ? AND report_month IN (${ph})`,
        [source_id, ...targetMonths]
      );

      // Delete conflicting holdings + extractions via batch
      if (conflicting.length > 0) {
        const statements = conflicting.flatMap(({ id }) => [
          { sql: 'DELETE FROM holdings WHERE extraction_id = ?', args: [id] },
          { sql: 'DELETE FROM extractions WHERE id = ?', args: [id] },
        ]);
        await getDb().batch(statements, 'write');
        deletedExtractions = conflicting.length;
      }
    }

    // Re-point remaining source extractions to target, then delete source fund
    const moveResult = await exec('UPDATE extractions SET fund_id = ? WHERE fund_id = ?', [target_id, source_id]);
    await exec('DELETE FROM funds WHERE id = ?', [source_id]);

    const moved = Number(moveResult.rowsAffected ?? 0);
    logger.ok(`Admin fund merge: "${source.name}" → "${target.name}"  moved=${moved}  deleted_conflicts=${deletedExtractions}`);
    res.json({
      source: { id: source_id, name: source.name },
      target: { id: target_id, name: target.name },
      extractions_moved: moved,
      conflicting_deleted: deletedExtractions,
    });
  } catch (err) {
    logger.error('admin/funds/merge:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk delete funds ────────────────────────────────────────────────────────
router.delete('/funds/bulk', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  try {
    let totalExtractions = 0;
    for (const fundId of ids) {
      const exts = await q('SELECT id FROM extractions WHERE fund_id = ?', [fundId]);
      if (exts.length > 0) {
        const statements = [
          ...exts.map(({ id }) => ({ sql: 'DELETE FROM holdings WHERE extraction_id = ?', args: [id] })),
          ...exts.map(({ id }) => ({ sql: 'DELETE FROM extractions WHERE id = ?', args: [id] })),
        ];
        await getDb().batch(statements, 'write');
        totalExtractions += exts.length;
      }
      await exec('DELETE FROM fund_nav_map WHERE fund_id = ?', [fundId]);
      await exec('DELETE FROM funds WHERE id = ?', [fundId]);
    }
    logger.ok(`Admin bulk fund delete: ${ids.length} funds, ${totalExtractions} extractions`);
    invalidate('*');
    res.json({ deleted: ids.length, extractions_deleted: totalExtractions });
  } catch (err) {
    logger.error('admin/funds/bulk-delete:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk delete extractions ──────────────────────────────────────────────────
router.delete('/extractions/bulk', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  try {
    const statements = [
      ...ids.map(id => ({ sql: 'DELETE FROM holdings WHERE extraction_id = ?', args: [id] })),
      ...ids.map(id => ({ sql: 'DELETE FROM extractions WHERE id = ?', args: [id] })),
    ];
    await getDb().batch(statements, 'write');
    logger.ok(`Admin bulk extraction delete: ${ids.length} extractions`);
    invalidate('*');
    res.json({ deleted: ids.length });
  } catch (err) {
    logger.error('admin/extractions/bulk-delete:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete a fund + all its extractions + holdings ──────────────────────────
router.delete('/funds/:id', async (req, res) => {
  const fundId = parseInt(req.params.id, 10);
  if (!fundId) return res.status(400).json({ error: 'Invalid fund id' });

  try {
    const fund = await q1('SELECT id, name FROM funds WHERE id = ?', [fundId]);
    if (!fund) return res.status(404).json({ error: `Fund ${fundId} not found` });

    // Get all extraction IDs for this fund
    const extractions = await q('SELECT id FROM extractions WHERE fund_id = ?', [fundId]);

    if (extractions.length > 0) {
      // Delete all holdings for every extraction, then the extractions themselves
      const statements = [
        ...extractions.map(({ id }) => ({ sql: 'DELETE FROM holdings WHERE extraction_id = ?', args: [id] })),
        ...extractions.map(({ id }) => ({ sql: 'DELETE FROM extractions WHERE id = ?', args: [id] })),
      ];
      await getDb().batch(statements, 'write');
    }

    // Also clean up related tables
    await exec('DELETE FROM fund_nav_map WHERE fund_id = ?', [fundId]);
    await exec('DELETE FROM funds WHERE id = ?', [fundId]);

    logger.ok(`Admin fund delete: "${fund.name}" (id=${fundId}) — ${extractions.length} extractions removed`);
    invalidate('*');
    res.json({ deleted: true, fund_id: fundId, name: fund.name, extractions_deleted: extractions.length });
  } catch (err) {
    logger.error('admin/funds/delete:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fund Continuity Report ───────────────────────────────────────────────────
router.get('/fund-gaps', async (req, res) => {
  try {
    const funds = await q(`
      SELECT f.id, f.name, GROUP_CONCAT(e.report_month, '|') AS months_raw
      FROM funds f
      LEFT JOIN extractions e ON e.fund_id = f.id
      GROUP BY f.id
      ORDER BY f.name
    `);

    const today = new Date();

    function monthsBetween(start, end) {
      const result = [];
      const cur  = new Date(start);
      const last = new Date(end);
      while (cur <= last) {
        result.push(cur.toISOString().slice(0, 7) + '-01');
        cur.setMonth(cur.getMonth() + 1);
      }
      return result;
    }

    const report = funds.map(f => {
      const actual = f.months_raw ? f.months_raw.split('|').sort() : [];

      if (actual.length === 0) {
        return { id: f.id, name: f.name, actual_months: [], expected_months: [], gaps: [], gap_count: 0, coverage_pct: 0, first_month: null, last_month: null, months_since_last: null, status: 'empty' };
      }

      const first    = actual[0];
      const last     = actual[actual.length - 1];
      const expected = monthsBetween(first, last);
      const actualSet = new Set(actual);
      const gaps     = expected.filter(m => !actualSet.has(m));

      const coverage_pct = expected.length > 0
        ? Math.round((actual.length / expected.length) * 100) : 100;

      const lastDate = new Date(last);
      const months_since_last =
        (today.getFullYear() - lastDate.getFullYear()) * 12 +
        (today.getMonth() - lastDate.getMonth());

      let status;
      if (gaps.length === 0 && months_since_last <= 2) status = 'ok';
      else if (gaps.length === 0 && months_since_last > 2) status = 'stale';
      else if (gaps.length <= 2) status = 'minor';
      else status = 'major';

      return { id: f.id, name: f.name, actual_months: actual, expected_months: expected, gaps, gap_count: gaps.length, coverage_pct, first_month: first, last_month: last, months_since_last, status };
    });

    logger.ok(`admin/fund-gaps  →  ${report.length} funds  gaps=${report.filter(r => r.gap_count > 0).length}`);
    res.json(report);
  } catch (err) {
    logger.error('admin/fund-gaps:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/cache — view cache stats + live keys
router.get('/cache', (req, res) => {
  res.json({ ...cacheStats(), keys: cacheKeys() });
});

// DELETE /admin/cache — manually bust everything
router.delete('/cache', (req, res) => {
  invalidate('*');
  logger.ok('Admin: cache cleared manually');
  res.json({ cleared: true });
});

// GET /admin/counts — lightweight summary counts for all tab badges
router.get('/counts', async (req, res) => {
  try {
    const [isinRows, nameRows, navRows, gapRows] = await Promise.all([
      // ISIN issues: groups with more than one ISIN per company code
      q(`SELECT COUNT(*) AS n FROM (
           SELECT SUBSTR(isin,1,7) AS code FROM holdings
           WHERE isin REGEXP '^INE[A-Z0-9]{4}01[0-9A-Z]{3}$'
           GROUP BY code HAVING COUNT(DISTINCT isin) > 1
         )`),
      // Name issues: ISINs with more than one distinct stock_name
      q(`SELECT COUNT(*) AS n FROM (
           SELECT isin FROM holdings
           GROUP BY isin HAVING COUNT(DISTINCT stock_name) > 1
         )`),
      // NAV unmapped: funds with no scheme_code
      q(`SELECT COUNT(*) AS n FROM funds f
         LEFT JOIN fund_nav_map m ON m.fund_id = f.id
         WHERE m.scheme_code IS NULL`),
      // Data continuity gaps: funds with missing months
      q(`SELECT COUNT(DISTINCT fund_id) AS n FROM (
           WITH months AS (
             SELECT fund_id, report_month,
               LAG(report_month) OVER (PARTITION BY fund_id ORDER BY report_month) AS prev_month
             FROM extractions
           )
           SELECT fund_id FROM months
           WHERE prev_month IS NOT NULL
             AND CAST(STRFTIME('%m', report_month) AS INTEGER) -
                 CAST(STRFTIME('%m', prev_month)  AS INTEGER) > 1
             AND STRFTIME('%Y', report_month) = STRFTIME('%Y', prev_month)
         )`),
    ]);

    res.json({
      isin:        Number(isinRows[0]?.n ?? 0),
      names:       Number(nameRows[0]?.n ?? 0),
      nav_unmapped: Number(navRows[0]?.n ?? 0),
      continuity:  Number(gapRows[0]?.n ?? 0),
    });
  } catch (err) {
    logger.error('admin/counts:', err.message);
    // Return zeros on error so the UI still loads
    res.json({ isin: 0, names: 0, nav_unmapped: 0, continuity: 0 });
  }
});

// ─── Backup ───────────────────────────────────────────────────────────────────

// GET /admin/backup/status — last triggered time
router.get('/backup/status', async (req, res) => {
  try {
    const row = await q1(`SELECT value FROM app_settings WHERE key = 'backup_last_triggered'`);
    res.json({ last_triggered_at: row?.value ?? null });
  } catch (err) {
    logger.error('admin/backup/status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/backup/now — flush WAL so Litestream syncs immediately
router.post('/backup/now', async (req, res) => {
  try {
    // PRAGMA wal_checkpoint(TRUNCATE) flushes all WAL frames to the main DB file
    // Litestream detects the checkpoint and syncs the updated DB to R2
    const result = await getDb().execute('PRAGMA wal_checkpoint(TRUNCATE)');
    const row = result.rows[0];
    const busy        = Number(row?.busy        ?? 0);
    const log         = Number(row?.log         ?? 0);
    const checkpointed = Number(row?.checkpointed ?? 0);

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await getDb().execute({
      sql:  `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('backup_last_triggered', ?)`,
      args: [now],
    });

    logger.ok(`Admin backup: wal_checkpoint(TRUNCATE) busy=${busy} log=${log} checkpointed=${checkpointed}`);
    res.json({ ok: true, busy, log, checkpointed, triggered_at: now });
  } catch (err) {
    logger.error('admin/backup/now:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/backup/download — checkpoint WAL then stream the .db file
router.get('/backup/download', async (req, res) => {
  try {
    const dbPath = getLocalDbPath();
    if (!dbPath) {
      return res.status(400).json({ error: 'Database download is only available in local SQLite mode' });
    }

    // Flush WAL before reading so the file is consistent
    await getDb().execute('PRAGMA wal_checkpoint(TRUNCATE)');

    const stat = statSync(dbPath);
    const filename = `mf_portfolio_${new Date().toISOString().slice(0, 10)}.db.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // No Content-Length — size unknown after compression

    const gzip = createGzip({ level: 6 });
    createReadStream(dbPath).pipe(gzip).pipe(res);
    logger.ok(`Admin backup/download: streaming gzip ${dbPath} (${(stat.size / 1024 / 1024).toFixed(1)} MB raw)`);
  } catch (err) {
    logger.error('admin/backup/download:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stocks List ─────────────────────────────────────────────────────────────

// GET /admin/stocks?q=&cap=&index=&page=&limit=
router.get('/stocks', async (req, res) => {
  try {
    const search  = (req.query.q     || '').trim();
    const cap     = req.query.cap    || '';   // 'large' | 'mid' | 'small' | 'micro'
    const index   = req.query.index  || '';   // 'nifty50' | 'nifty500'
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset  = (page - 1) * limit;

    const conditions = [];
    const args       = [];

    if (search) {
      conditions.push(`(UPPER(symbol_nse) LIKE UPPER(?) OR UPPER(name) LIKE UPPER(?))`);
      args.push(`%${search}%`, `%${search}%`);
    }
    if (cap)   { conditions.push(`market_cap_cat = ?`); args.push(cap); }
    if (index === 'nifty50')  { conditions.push(`is_nifty50 = 1`); }
    if (index === 'nifty500') { conditions.push(`is_nifty500 = 1`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, countRow] = await Promise.all([
      q(`SELECT isin, symbol_nse, name, sector, industry, market_cap, market_cap_cat,
                face_value, is_nifty50, is_nifty500, last_synced_at
         FROM stocks ${where}
         ORDER BY CASE WHEN market_cap IS NULL THEN 1 ELSE 0 END,
                  market_cap DESC, name ASC
         LIMIT ? OFFSET ?`, [...args, limit, offset]),
      q1(`SELECT COUNT(*) AS total FROM stocks ${where}`, args),
    ]);

    res.json({
      rows,
      total:   Number(countRow?.total ?? 0),
      page,
      limit,
      pages:   Math.ceil(Number(countRow?.total ?? 0) / limit),
    });
  } catch (err) {
    logger.error('admin/stocks:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stocks Sync ─────────────────────────────────────────────────────────────

// GET /admin/stocks/status — current sync state + DB counts
router.get('/stocks/status', async (req, res) => {
  try {
    const [lastSyncRow, countRow] = await Promise.all([
      q1(`SELECT value FROM app_settings WHERE key = 'stocks_last_sync'`),
      q1(`SELECT COUNT(*) AS total,
                 SUM(is_nifty50)  AS n50,
                 SUM(is_nifty500) AS n500,
                 SUM(CASE WHEN market_cap IS NOT NULL THEN 1 ELSE 0 END) AS ncap
          FROM stocks`),
    ]);
    res.json({
      sync:          syncState,
      last_synced_at: lastSyncRow?.value ?? null,
      db_counts: {
        total:           Number(countRow?.total  ?? 0),
        nifty50:         Number(countRow?.n50    ?? 0),
        nifty500:        Number(countRow?.n500   ?? 0),
        with_market_cap: Number(countRow?.ncap   ?? 0),
      },
    });
  } catch (err) {
    logger.error('admin/stocks/status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/stocks/sync — trigger on-demand sync (fires async, returns immediately)
router.post('/stocks/sync', (req, res) => {
  try {
    runStocksSync();
    res.json({ started: true });
  } catch (err) {
    // "Sync already in progress" comes back as 409
    res.status(409).json({ error: err.message });
  }
});

// GET /admin/cache/enabled — returns current enabled flag
router.get('/cache/enabled', (req, res) => {
  res.json({ enabled: isCacheEnabled() });
});

// PATCH /admin/cache/enabled — toggle cache on/off
router.patch('/cache/enabled', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  setCacheEnabled(enabled);
  logger.ok(`Admin: cache ${enabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ enabled: isCacheEnabled() });
});

export default router;
