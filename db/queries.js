import { getDb } from './connection.js';
import logger from '../logger.js';

// ─── Thin async wrappers ─────────────────────────────────────────────────────

async function query(label, sql, args = []) {
  const t0 = performance.now();
  const result = await getDb().execute({ sql, args });
  const rows = Array.from(result.rows);
  const ms = (performance.now() - t0).toFixed(1);
  logger.db(`${label}  →  ${rows.length} row(s)  \x1b[2m(${ms}ms)\x1b[0m`);
  return rows;
}

async function queryOne(label, sql, args = []) {
  const t0 = performance.now();
  const result = await getDb().execute({ sql, args });
  const row = result.rows[0] ?? null;
  const ms = (performance.now() - t0).toFixed(1);
  logger.db(`${label}  →  ${row ? '1 row' : 'not found'}  \x1b[2m(${ms}ms)\x1b[0m`);
  return row;
}

// ─── FUNDS ─────────────────────────────────────────────────────────────────

export async function getAllFunds() {
  return query('getAllFunds', `
    SELECT f.id, f.name, f.created_at, COUNT(e.id) AS extraction_count,
           MAX(e.report_month) AS last_month
    FROM funds f
    LEFT JOIN extractions e ON e.fund_id = f.id
    GROUP BY f.id
    ORDER BY f.name
  `);
}

export async function getFundById(id) {
  return queryOne(`getFundById(${id})`, `
    SELECT f.id, f.name, f.created_at, COUNT(e.id) AS extraction_count
    FROM funds f
    LEFT JOIN extractions e ON e.fund_id = f.id
    WHERE f.id = ?
    GROUP BY f.id
  `, [id]);
}

// ─── EXTRACTIONS ────────────────────────────────────────────────────────────

export async function getExtractionsByFund(fundId) {
  return query(`getExtractionsByFund(fund=${fundId})`, `
    SELECT e.id, e.fund_id, e.report_month, e.source_file,
           e.extracted_at, e.confidence_score, e.confidence_label,
           e.holding_count, e.notes
    FROM extractions e
    WHERE e.fund_id = ?
    ORDER BY e.report_month DESC
  `, [fundId]);
}

export async function getExtractionById(id) {
  return queryOne(`getExtractionById(${id})`, `
    SELECT e.*, f.name AS fund_name
    FROM extractions e
    JOIN funds f ON f.id = e.fund_id
    WHERE e.id = ?
  `, [id]);
}

// ─── HOLDINGS ───────────────────────────────────────────────────────────────

export async function getHoldings(extractionId, { sort = 'pct_nav', order = 'desc', industry, search } = {}) {
  const allowed_sorts = ['pct_nav', 'market_value', 'stock_name', 'quantity'];
  const safe_sort  = allowed_sorts.includes(sort) ? sort : 'pct_nav';
  const safe_order = order === 'asc' ? 'ASC' : 'DESC';

  const conditions = ['h.extraction_id = ?'];
  const args = [extractionId];

  if (industry) { conditions.push('h.industry = ?'); args.push(industry); }
  if (search)   { conditions.push('(h.stock_name LIKE ? OR h.isin LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }

  const filters = [industry && `industry="${industry}"`, search && `search="${search}"`].filter(Boolean).join(', ') || 'none';
  const label   = `getHoldings(extraction=${extractionId}, sort=${safe_sort} ${safe_order}, filters: ${filters})`;

  return query(label, `
    SELECT h.id, h.stock_name, h.isin, h.quantity, h.market_value, h.pct_nav, h.industry, h.rating,
           s.market_cap_cat
    FROM holdings h
    LEFT JOIN stocks s ON s.isin = h.isin
    WHERE ${conditions.join(' AND ')}
    ORDER BY h.${safe_sort} ${safe_order}
  `, args);
}

export async function getHoldingsSummary(extractionId) {
  logger.db(`getHoldingsSummary(extraction=${extractionId}) — running 3 queries`);
  const t0 = performance.now();

  const [top10Rows, industryRows, totalsRow] = await Promise.all([
    getDb().execute({
      sql: `SELECT h.stock_name, h.isin, h.pct_nav, h.market_value, h.industry, s.market_cap_cat
            FROM holdings h LEFT JOIN stocks s ON s.isin = h.isin
            WHERE h.extraction_id = ?
            ORDER BY h.pct_nav DESC LIMIT 10`,
      args: [extractionId],
    }),
    getDb().execute({
      sql: `SELECT COALESCE(industry,'Unknown') AS industry,
                   ROUND(SUM(pct_nav),4) AS total_pct_nav, COUNT(*) AS holding_count
            FROM holdings WHERE extraction_id = ?
            GROUP BY industry ORDER BY total_pct_nav DESC`,
      args: [extractionId],
    }),
    getDb().execute({
      sql: `SELECT COUNT(*) AS holding_count,
                   ROUND(SUM(market_value),2) AS total_market_value,
                   ROUND(SUM(pct_nav),4) AS total_pct_nav
            FROM holdings WHERE extraction_id = ?`,
      args: [extractionId],
    }),
  ]);

  const top10            = Array.from(top10Rows.rows);
  const industryBreakdown = Array.from(industryRows.rows);
  const totals           = totalsRow.rows[0] ?? null;

  const ms = (performance.now() - t0).toFixed(1);
  logger.db(`getHoldingsSummary  →  top10=${top10.length}, industries=${industryBreakdown.length}  \x1b[2m(${ms}ms)\x1b[0m`);

  return { top10, industryBreakdown, totals };
}

export async function getDistinctIndustries(extractionId) {
  const rows = await query(
    `getDistinctIndustries(extraction=${extractionId})`,
    `SELECT DISTINCT COALESCE(industry,'Unknown') AS industry FROM holdings WHERE extraction_id = ? ORDER BY industry`,
    [extractionId]
  );
  return rows.map(r => r.industry);
}

// ─── COMPARISON ─────────────────────────────────────────────────────────────

export async function compareExtractions(fundId, month1, month2) {
  logger.info(`compareExtractions  fund=${fundId}  "${month1}" vs "${month2}"`);

  const [e1, e2] = await Promise.all([
    queryOne('getEx1', `SELECT id FROM extractions WHERE fund_id = ? AND report_month = ?`, [fundId, month1]),
    queryOne('getEx2', `SELECT id FROM extractions WHERE fund_id = ? AND report_month = ?`, [fundId, month2]),
  ]);

  if (!e1) { logger.warn(`compareExtractions — no extraction found for month ${month1}`); return null; }
  if (!e2) { logger.warn(`compareExtractions — no extraction found for month ${month2}`); return null; }

  const holdingsMap = async (eid) => {
    const rows = await query('holdingsMap', `SELECT stock_name,isin,pct_nav,market_value,quantity,industry,rating FROM holdings WHERE extraction_id=?`, [eid]);
    const map = {};
    rows.forEach(r => { map[r.isin] = r; });
    return map;
  };

  const [h1, h2] = await Promise.all([holdingsMap(e1.id), holdingsMap(e2.id)]);
  const allIsins = new Set([...Object.keys(h1), ...Object.keys(h2)]);

  const newHoldings = [], exitedHoldings = [], weightChanges = [], navDrifters = [];
  for (const isin of allIsins) {
    if (h2[isin] && !h1[isin]) {
      newHoldings.push(h2[isin]);
    } else if (h1[isin] && !h2[isin]) {
      exitedHoldings.push(h1[isin]);
    } else if (h1[isin] && h2[isin]) {
      const qtyDelta = (h2[isin].quantity || 0) - (h1[isin].quantity || 0);
      const navDelta = (h2[isin].pct_nav  || 0) - (h1[isin].pct_nav  || 0);
      if (Math.abs(qtyDelta) > 0) {
        weightChanges.push({
          ...h2[isin],
          prev_pct_nav:      h1[isin].pct_nav,
          prev_quantity:     h1[isin].quantity,
          prev_market_value: h1[isin].market_value,
          qty_delta:         parseFloat(qtyDelta.toFixed(4)),
          nav_delta:         parseFloat(navDelta.toFixed(4)),
          action:            qtyDelta > 0 ? 'added' : 'trimmed',
        });
      } else if (Math.abs(navDelta) > 0) {
        navDrifters.push({
          ...h2[isin],
          prev_pct_nav:      h1[isin].pct_nav,
          prev_market_value: h1[isin].market_value,
          nav_delta:         parseFloat(navDelta.toFixed(6)),
          action:            'drifted',
        });
      }
    }
  }

  // ISIN-change detection
  const exitedByName = {};
  exitedHoldings.forEach((h, i) => { exitedByName[h.stock_name] = i; });
  const newIdxToRemove  = new Set();
  const exitIdxToRemove = new Set();

  newHoldings.forEach((h, ni) => {
    const ei = exitedByName[h.stock_name];
    if (ei !== undefined) {
      const old = exitedHoldings[ei];
      const qtyDelta = (h.quantity || 0) - (old.quantity || 0);
      const navDelta = (h.pct_nav  || 0) - (old.pct_nav  || 0);
      weightChanges.push({
        ...h,
        prev_pct_nav:      old.pct_nav,
        prev_quantity:     old.quantity,
        prev_market_value: old.market_value,
        prev_isin:         old.isin,
        qty_delta:         parseFloat(qtyDelta.toFixed(4)),
        nav_delta:         parseFloat(navDelta.toFixed(4)),
        action:            'isin_changed',
      });
      newIdxToRemove.add(ni);
      exitIdxToRemove.add(ei);
      logger.info(`compareExtractions — ISIN change: "${h.stock_name}"  ${old.isin} → ${h.isin}`);
    }
  });

  const filteredNew    = newHoldings.filter((_, i) => !newIdxToRemove.has(i));
  const filteredExited = exitedHoldings.filter((_, i) => !exitIdxToRemove.has(i));

  weightChanges.sort((a, b) => {
    if (a.action === 'isin_changed' && b.action !== 'isin_changed') return -1;
    if (b.action === 'isin_changed' && a.action !== 'isin_changed') return  1;
    return Math.abs(b.qty_delta) - Math.abs(a.qty_delta);
  });
  navDrifters.sort((a, b) => Math.abs(b.nav_delta) - Math.abs(a.nav_delta));

  logger.ok(`compareExtractions  →  new=${filteredNew.length}  exited=${filteredExited.length}  changed=${weightChanges.length}  drifted=${navDrifters.length}`);
  return { fund_id: parseInt(fundId), month1, month2, extraction1_id: e1.id, extraction2_id: e2.id, newHoldings: filteredNew, exitedHoldings: filteredExited, weightChanges, navDrifters };
}

// ─── MULTI-MONTH RANGE DIFF ─────────────────────────────────────────────────

export async function getMonthRangeDiff(fundId, startMonth, endMonth) {
  logger.info(`getMonthRangeDiff  fund=${fundId}  "${startMonth}" → "${endMonth}"`);

  const extractions = await query('getExtractions', `
    SELECT id, report_month
    FROM extractions
    WHERE fund_id = ? AND report_month >= ? AND report_month <= ?
    ORDER BY report_month ASC
  `, [fundId, startMonth, endMonth]);

  if (extractions.length < 2) {
    logger.warn(`getMonthRangeDiff — need at least 2 extractions, found ${extractions.length}`);
    return { fund_id: parseInt(fundId), transitions: [], extractions };
  }

  // Fetch all holdings for all extractions in range in one query
  const extIds = extractions.map(e => e.id);
  const ph = extIds.map(() => '?').join(',');
  const allRows = await query('allHoldings', `
    SELECT extraction_id, stock_name, isin, pct_nav, market_value, quantity, industry, rating
    FROM holdings WHERE extraction_id IN (${ph})
  `, extIds);

  // Group by extraction_id
  const holdingsByExt = {};
  for (const r of allRows) {
    if (!holdingsByExt[r.extraction_id]) holdingsByExt[r.extraction_id] = {};
    holdingsByExt[r.extraction_id][r.isin] = r;
  }

  const transitions = [];

  for (let i = 0; i < extractions.length - 1; i++) {
    const e1 = extractions[i];
    const e2 = extractions[i + 1];
    const h1 = holdingsByExt[e1.id] || {};
    const h2 = holdingsByExt[e2.id] || {};
    const allIsins = new Set([...Object.keys(h1), ...Object.keys(h2)]);

    const newHoldings = [], exitedHoldings = [], weightChanges = [], navDrifters = [];
    for (const isin of allIsins) {
      if (h2[isin] && !h1[isin]) {
        newHoldings.push(h2[isin]);
      } else if (h1[isin] && !h2[isin]) {
        exitedHoldings.push(h1[isin]);
      } else if (h1[isin] && h2[isin]) {
        const qtyDelta = (h2[isin].quantity || 0) - (h1[isin].quantity || 0);
        const navDelta = (h2[isin].pct_nav  || 0) - (h1[isin].pct_nav  || 0);
        if (Math.abs(qtyDelta) > 0) {
          weightChanges.push({
            ...h2[isin],
            prev_pct_nav:      h1[isin].pct_nav,
            prev_quantity:     h1[isin].quantity,
            prev_market_value: h1[isin].market_value,
            qty_delta:         parseFloat(qtyDelta.toFixed(4)),
            nav_delta:         parseFloat(navDelta.toFixed(4)),
            action:            qtyDelta > 0 ? 'added' : 'trimmed',
          });
        } else if (Math.abs(navDelta) > 0) {
          navDrifters.push({
            ...h2[isin],
            prev_pct_nav:      h1[isin].pct_nav,
            prev_market_value: h1[isin].market_value,
            nav_delta:         parseFloat(navDelta.toFixed(6)),
            action:            'drifted',
          });
        }
      }
    }

    // ISIN-change detection
    const exitedByName = {};
    exitedHoldings.forEach((h, idx) => { exitedByName[h.stock_name] = idx; });
    const newIdxToRemove  = new Set();
    const exitIdxToRemove = new Set();
    newHoldings.forEach((h, ni) => {
      const ei = exitedByName[h.stock_name];
      if (ei !== undefined) {
        const old = exitedHoldings[ei];
        const qtyDelta = (h.quantity || 0) - (old.quantity || 0);
        const navDelta = (h.pct_nav  || 0) - (old.pct_nav  || 0);
        weightChanges.push({
          ...h,
          prev_pct_nav:      old.pct_nav,
          prev_quantity:     old.quantity,
          prev_market_value: old.market_value,
          prev_isin:         old.isin,
          qty_delta:         parseFloat(qtyDelta.toFixed(4)),
          nav_delta:         parseFloat(navDelta.toFixed(4)),
          action:            'isin_changed',
        });
        newIdxToRemove.add(ni);
        exitIdxToRemove.add(ei);
      }
    });

    weightChanges.sort((a, b) => {
      if (a.action === 'isin_changed' && b.action !== 'isin_changed') return -1;
      if (b.action === 'isin_changed' && a.action !== 'isin_changed') return  1;
      return Math.abs(b.qty_delta) - Math.abs(a.qty_delta);
    });
    navDrifters.sort((a, b) => Math.abs(b.nav_delta) - Math.abs(a.nav_delta));

    transitions.push({
      fromMonth:      e1.report_month,
      toMonth:        e2.report_month,
      extraction1_id: e1.id,
      extraction2_id: e2.id,
      newHoldings:    newHoldings.filter((_, idx) => !newIdxToRemove.has(idx)),
      exitedHoldings: exitedHoldings.filter((_, idx) => !exitIdxToRemove.has(idx)),
      weightChanges,
      navDrifters,
    });
  }

  logger.ok(`getMonthRangeDiff  →  ${transitions.length} transitions`);
  return { fund_id: parseInt(fundId), startMonth, endMonth, extractions, transitions };
}

// ─── CROSS-FUND ANALYSIS ─────────────────────────────────────────────────────

export async function getCrossFundAnalysis() {
  logger.info('getCrossFundAnalysis — building high-conviction list');
  const t0 = performance.now();

  const rows = await query('getCrossFundAnalysis', `
    WITH latest AS (
      SELECT fund_id, MAX(report_month) AS max_month
      FROM extractions
      GROUP BY fund_id
    ),
    latest_exts AS (
      SELECT e.id AS ext_id, e.fund_id, f.name AS fund_name
      FROM extractions e
      JOIN funds f ON f.id = e.fund_id
      JOIN latest l ON l.fund_id = e.fund_id AND l.max_month = e.report_month
    ),
    ext_scale AS (
      SELECT extraction_id,
        CASE WHEN SUM(pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings
      GROUP BY extraction_id
    )
    SELECT
      h.stock_name,
      h.isin,
      h.industry,
      MAX(s.market_cap_cat)                                 AS market_cap_cat,
      COUNT(DISTINCT le.fund_id)                            AS fund_count,
      ROUND(AVG(h.pct_nav * es.scale), 4)                  AS avg_pct_nav,
      ROUND(SUM(COALESCE(h.market_value, 0)), 2)           AS total_market_value,
      GROUP_CONCAT(le.fund_name, '|||')                     AS fund_names_raw,
      GROUP_CONCAT(le.fund_name || '::' || ROUND(h.pct_nav * es.scale, 4), '|||') AS fund_allocs_raw
    FROM holdings h
    JOIN latest_exts le  ON le.ext_id = h.extraction_id
    JOIN ext_scale   es  ON es.extraction_id = h.extraction_id
    LEFT JOIN stocks s   ON s.isin = h.isin
    WHERE h.stock_name IS NOT NULL
      AND h.isin IS NOT NULL
      AND h.pct_nav IS NOT NULL
    GROUP BY h.isin
    ORDER BY fund_count DESC, avg_pct_nav DESC
  `);

  const ms = (performance.now() - t0).toFixed(1);
  logger.ok(`getCrossFundAnalysis  →  ${rows.length} unique stocks  \x1b[2m(${ms}ms)\x1b[0m`);

  return rows.map(r => ({
    ...r,
    fund_names: [...new Set(r.fund_names_raw.split('|||'))],
    fund_names_raw: undefined,
    fund_allocs: r.fund_allocs_raw
      ? r.fund_allocs_raw.split('|||').map(s => {
          const sep = s.lastIndexOf('::');
          return { name: s.slice(0, sep), pct: parseFloat(s.slice(sep + 2)) };
        })
      : [],
    fund_allocs_raw: undefined,
  }));
}

// ─── RISING CONVICTION ───────────────────────────────────────────────────────

export async function getRisingConviction(lookback = 6, direction = 'rising') {
  const lb = Math.min(Math.max(lookback, 3), 12);
  logger.info(`getRisingConviction — direction=${direction} lookback=${lb} months`);
  const t0 = performance.now();

  const rows = await query('getRisingConviction', `
    WITH fund_scale AS (
      SELECT e.fund_id,
        CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM extractions e
      JOIN holdings h ON h.extraction_id = e.id
      GROUP BY e.fund_id
    ),
    recent_months AS (
      SELECT e.id AS ext_id, e.fund_id, e.report_month,
             ROW_NUMBER() OVER (PARTITION BY e.fund_id ORDER BY e.report_month DESC) AS rn
      FROM extractions e
    )
    SELECT
      rm.fund_id,
      f.name                            AS fund_name,
      rm.report_month,
      h.stock_name,
      h.isin,
      h.industry,
      s.market_cap_cat,
      ROUND(h.pct_nav * fs.scale, 4)   AS pct
    FROM holdings h
    JOIN recent_months rm ON rm.ext_id = h.extraction_id
    JOIN fund_scale fs    ON fs.fund_id = rm.fund_id
    JOIN funds f          ON f.id = rm.fund_id
    LEFT JOIN stocks s    ON s.isin = h.isin
    WHERE rm.rn <= ?
      AND h.pct_nav IS NOT NULL
      AND h.isin IS NOT NULL
    ORDER BY rm.fund_id, h.isin, rm.report_month DESC
  `, [lb]);

  const map = new Map();
  for (const row of rows) {
    const key = `${row.fund_id}:${row.isin}`;
    if (!map.has(key)) {
      map.set(key, { fund_id: row.fund_id, fund_name: row.fund_name, stock_name: row.stock_name, isin: row.isin, industry: row.industry, market_cap_cat: row.market_cap_cat, months: [] });
    }
    map.get(key).months.push({ month: row.report_month, pct: row.pct });
  }

  const results = [];
  const MIN_DELTA = 0.01;
  const isMove = direction === 'rising'
    ? (a, b) => (a - b) >= MIN_DELTA
    : (a, b) => (b - a) >= MIN_DELTA;

  for (const [, entry] of map) {
    const { months } = entry;
    if (months.length < 2) continue;

    let streak = 0;
    for (let i = 0; i < months.length - 1; i++) {
      if (isMove(months[i].pct, months[i + 1].pct)) streak++;
      else break;
    }
    if (streak < 2) continue;

    let upCount = 0;
    for (let i = 0; i < months.length - 1; i++) {
      if (isMove(months[i].pct, months[i + 1].pct)) upCount++;
    }

    const latestPct = months[0].pct;
    const oldestPct = months[months.length - 1].pct;
    const gain      = parseFloat((latestPct - oldestPct).toFixed(4));

    if (direction === 'rising' && gain <= 0) continue;
    if (direction === 'losing' && gain >= 0) continue;

    results.push({
      fund_id:        entry.fund_id,
      fund_name:      entry.fund_name,
      stock_name:     entry.stock_name,
      isin:           entry.isin,
      industry:       entry.industry,
      market_cap_cat: entry.market_cap_cat,
      streak,
      up_count:     upCount,
      window_count: months.length,
      latest_pct:   latestPct,
      oldest_pct:   oldestPct,
      gain,
      pct_history:  months.slice().reverse().map(m => ({ month: m.month, pct: m.pct })),
    });
  }

  results.sort((a, b) =>
    b.streak - a.streak || (direction === 'rising' ? b.gain - a.gain : a.gain - b.gain)
  );

  const ms = (performance.now() - t0).toFixed(1);
  logger.ok(`getRisingConviction[${direction}]  →  ${results.length} positions  \x1b[2m(${ms}ms)\x1b[0m`);
  return results;
}

// ─── ACTIVITY FEED ───────────────────────────────────────────────────────────

export async function getFeedData(lookback = 6) {
  const lb = Math.min(Math.max(lookback, 2), 12);
  logger.info(`getFeedData — lookback=${lb} months`);
  const t0 = performance.now();

  const rows = await query('getFeedData', `
    WITH fund_scale AS (
      SELECT e.fund_id,
        CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM extractions e JOIN holdings h ON h.extraction_id = e.id
      GROUP BY e.fund_id
    ),
    recent AS (
      SELECT e.id AS ext_id, e.fund_id, e.report_month,
             ROW_NUMBER() OVER (PARTITION BY e.fund_id ORDER BY e.report_month DESC) AS rn
      FROM extractions e
    )
    SELECT rm.fund_id, f.name AS fund_name, rm.report_month,
           h.stock_name, h.isin, h.industry,
           s.market_cap_cat,
           ROUND(h.pct_nav * fs.scale, 4) AS pct,
           h.quantity, h.market_value
    FROM holdings h
    JOIN recent rm     ON rm.ext_id  = h.extraction_id
    JOIN fund_scale fs ON fs.fund_id = rm.fund_id
    JOIN funds f       ON f.id       = rm.fund_id
    LEFT JOIN stocks s ON s.isin     = h.isin
    WHERE rm.rn <= ?
      AND h.pct_nav  IS NOT NULL
      AND h.isin     IS NOT NULL
      AND h.isin NOT LIKE 'IN002%'
      AND h.isin NOT LIKE 'INCBLO%'
      AND h.isin NOT LIKE 'INF%'
    ORDER BY rm.fund_id, rm.report_month DESC, h.isin
  `, [lb + 1]);

  const fundData = new Map();
  for (const row of rows) {
    const fkey = row.fund_id;
    if (!fundData.has(fkey)) fundData.set(fkey, { fund_name: row.fund_name, months: new Map() });
    const fd = fundData.get(fkey);
    if (!fd.months.has(row.report_month)) fd.months.set(row.report_month, new Map());
    fd.months.get(row.report_month).set(row.isin, {
      stock_name: row.stock_name, isin: row.isin, industry: row.industry,
      market_cap_cat: row.market_cap_cat,
      pct: row.pct, quantity: row.quantity, market_value: row.market_value,
    });
  }

  const MIN_DELTA     = 0.05;
  const MIN_ENTRY_PCT = 0.05;
  const monthEvents   = new Map();

  for (const [fund_id, { fund_name, months }] of fundData) {
    const sortedMonths = [...months.keys()].sort((a, b) => b.localeCompare(a));
    for (let i = 0; i < sortedMonths.length - 1; i++) {
      const currMonth = sortedMonths[i];
      const prevMonth = sortedMonths[i + 1];
      const curr = months.get(currMonth);
      const prev = months.get(prevMonth);
      if (!monthEvents.has(currMonth)) monthEvents.set(currMonth, []);
      const events = monthEvents.get(currMonth);

      for (const [isin, h] of curr) {
        if (!prev.has(isin) && h.pct >= MIN_ENTRY_PCT)
          events.push({ type: 'new_entry', fund_id, fund_name, ...h, pct_nav: h.pct, prev_pct_nav: null, delta: h.pct });
      }
      for (const [isin, h] of prev) {
        if (!curr.has(isin) && h.pct >= MIN_ENTRY_PCT)
          events.push({ type: 'exit', fund_id, fund_name, ...h, pct_nav: null, prev_pct_nav: h.pct, delta: -h.pct });
      }
      for (const [isin, h] of curr) {
        if (prev.has(isin)) {
          const ph = prev.get(isin);
          const delta = parseFloat((h.pct - ph.pct).toFixed(4));
          if (Math.abs(delta) >= MIN_DELTA) {
            events.push({
              type: 'weight_change', action: delta > 0 ? 'added' : 'trimmed',
              fund_id, fund_name, ...h, pct_nav: h.pct, prev_pct_nav: ph.pct, delta,
              prev_quantity: ph.quantity,
              qty_delta: h.quantity != null && ph.quantity != null ? h.quantity - ph.quantity : null,
            });
          }
        }
      }
    }
  }

  const result = [];
  for (const [month, events] of [...monthEvents.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const newEntries    = events.filter(e => e.type === 'new_entry').sort((a, b) => b.pct_nav - a.pct_nav);
    const exits         = events.filter(e => e.type === 'exit').sort((a, b) => b.prev_pct_nav - a.prev_pct_nav);
    const weightChanges = events.filter(e => e.type === 'weight_change').sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const convMap = new Map();
    for (const e of [...newEntries, ...exits]) {
      const key = `${e.type}:${e.isin}`;
      if (!convMap.has(key)) convMap.set(key, []);
      convMap.get(key).push(e);
    }

    const isinDirections = new Map();
    for (const [key] of convMap) {
      const colonIdx = key.indexOf(':');
      const type = key.slice(0, colonIdx);
      const isin = key.slice(colonIdx + 1);
      if (!isinDirections.has(isin)) isinDirections.set(isin, new Set());
      isinDirections.get(isin).add(type);
    }
    const contradictoryIsins = new Set(
      [...isinDirections.entries()]
        .filter(([, types]) => types.has('new_entry') && types.has('exit'))
        .map(([isin]) => isin)
    );

    const convergence = [...convMap.values()]
      .filter(g => g.length >= 2 && !contradictoryIsins.has(g[0].isin))
      .map(g => ({
        type: g[0].type, stock_name: g[0].stock_name, isin: g[0].isin, industry: g[0].industry,
        fund_count: g.length, fund_names: g.map(e => e.fund_name), fund_ids: g.map(e => e.fund_id),
        avg_pct: parseFloat((g.reduce((s, e) => s + (e.pct_nav ?? e.prev_pct_nav ?? 0), 0) / g.length).toFixed(4)),
      }))
      .sort((a, b) => b.fund_count - a.fund_count);

    result.push({
      month,
      summary: {
        new_entries: newEntries.length, exits: exits.length, changes: weightChanges.length,
        total: events.length, funds_active: new Set(events.map(e => e.fund_id)).size,
        convergence: convergence.length,
      },
      convergence, new_entries: newEntries, exits, weight_changes: weightChanges,
    });
  }

  const capped = result.slice(0, lb);
  const ms = (performance.now() - t0).toFixed(1);
  logger.ok(`getFeedData  →  ${capped.length} months  \x1b[2m(${ms}ms)\x1b[0m`);
  return capped;
}

// ─── OVERLAP MATRIX ──────────────────────────────────────────────────────────

export async function getOverlapMatrix() {
  logger.info('getOverlapMatrix — computing pairwise NAV-weighted fund overlap');
  const t0 = performance.now();

  const rows = await query('getOverlapMatrix', `
    WITH latest AS (
      SELECT fund_id, MAX(report_month) AS max_month
      FROM extractions GROUP BY fund_id
    ),
    latest_exts AS (
      SELECT e.id AS ext_id, e.fund_id, e.report_month, f.name AS fund_name
      FROM extractions e
      JOIN funds f ON f.id = e.fund_id
      JOIN latest l ON l.fund_id = e.fund_id AND l.max_month = e.report_month
    ),
    ext_scale AS (
      SELECT extraction_id,
        CASE WHEN SUM(pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings GROUP BY extraction_id
    )
    SELECT le.fund_id, le.fund_name, le.report_month, h.isin, h.stock_name, h.industry,
           ROUND(h.pct_nav * es.scale, 4) AS pct
    FROM holdings h
    JOIN latest_exts le ON le.ext_id = h.extraction_id
    JOIN ext_scale   es ON es.extraction_id = h.extraction_id
    WHERE h.isin IS NOT NULL AND h.pct_nav IS NOT NULL
      AND h.isin NOT LIKE 'IN002%'
      AND h.isin NOT LIKE 'INCBLO%'
      AND h.isin NOT LIKE 'INF%'
    ORDER BY le.fund_id, pct DESC
  `);

  const fundsMap = new Map();
  for (const row of rows) {
    if (!fundsMap.has(row.fund_id)) {
      fundsMap.set(row.fund_id, { fund_id: row.fund_id, fund_name: row.fund_name, report_month: row.report_month, holdings: new Map() });
    }
    fundsMap.get(row.fund_id).holdings.set(row.isin, { stock_name: row.stock_name, industry: row.industry, pct: row.pct });
  }

  const fundList = [...fundsMap.values()];
  for (const f of fundList) {
    f.total_pct     = [...f.holdings.values()].reduce((s, h) => s + h.pct, 0);
    f.holding_count = f.holdings.size;
  }

  const pairs = [];
  for (let i = 0; i < fundList.length; i++) {
    for (let j = i + 1; j < fundList.length; j++) {
      const fA = fundList[i], fB = fundList[j];
      const shared = [], uniqueA = [], uniqueB = [];
      for (const [isin, hA] of fA.holdings) {
        if (fB.holdings.has(isin)) {
          const hB = fB.holdings.get(isin);
          shared.push({ isin, stock_name: hA.stock_name, industry: hA.industry, pct_a: hA.pct, pct_b: hB.pct, min_pct: parseFloat(Math.min(hA.pct, hB.pct).toFixed(4)) });
        } else {
          uniqueA.push({ isin, stock_name: hA.stock_name, industry: hA.industry, pct: hA.pct });
        }
      }
      for (const [isin, hB] of fB.holdings) {
        if (!fA.holdings.has(isin)) {
          uniqueB.push({ isin, stock_name: hB.stock_name, industry: hB.industry, pct: hB.pct });
        }
      }
      shared.sort((a, b) => b.min_pct - a.min_pct);
      uniqueA.sort((a, b) => b.pct - a.pct);
      uniqueB.sort((a, b) => b.pct - a.pct);
      const weightedOverlap = shared.reduce((s, h) => s + h.min_pct, 0);
      const overlapPctA = fA.total_pct > 0 ? (weightedOverlap / fA.total_pct) * 100 : 0;
      const overlapPctB = fB.total_pct > 0 ? (weightedOverlap / fB.total_pct) * 100 : 0;
      pairs.push({
        fund_a_id: fA.fund_id, fund_a_name: fA.fund_name,
        fund_b_id: fB.fund_id, fund_b_name: fB.fund_name,
        shared_count: shared.length,
        weighted_overlap: parseFloat(weightedOverlap.toFixed(4)),
        overlap_pct:      parseFloat(((overlapPctA + overlapPctB) / 2).toFixed(2)),
        overlap_pct_a:    parseFloat(overlapPctA.toFixed(2)),
        overlap_pct_b:    parseFloat(overlapPctB.toFixed(2)),
        shared_holdings:  shared,
        unique_a:         uniqueA,
        unique_b:         uniqueB,
      });
    }
  }

  const ms = (performance.now() - t0).toFixed(1);
  logger.ok(`getOverlapMatrix  →  ${fundList.length} funds  ${pairs.length} pairs  \x1b[2m(${ms}ms)\x1b[0m`);

  return {
    funds: fundList.map(f => ({ fund_id: f.fund_id, fund_name: f.fund_name, report_month: f.report_month, total_pct: parseFloat(f.total_pct.toFixed(2)), holding_count: f.holding_count })),
    pairs,
  };
}

// ─── OVERLAP TREND ───────────────────────────────────────────────────────────

export async function getOverlapTrend(fundAId, fundBId) {
  logger.info(`getOverlapTrend — fund_a=${fundAId}  fund_b=${fundBId}`);
  const t0 = performance.now();

  // Fetch all months where both funds have data, plus all their holdings — in 2 queries
  const months = await query('getOverlapTrendMonths', `
    SELECT e_a.report_month, e_a.id AS ext_a_id, e_b.id AS ext_b_id
    FROM extractions e_a
    JOIN extractions e_b ON e_b.fund_id = ? AND e_b.report_month = e_a.report_month
    WHERE e_a.fund_id = ?
    ORDER BY e_a.report_month ASC
  `, [fundBId, fundAId]);

  if (!months.length) return [];

  const extAIds = months.map(m => m.ext_a_id);
  const extBIds = months.map(m => m.ext_b_id);
  const allExtIds = [...extAIds, ...extBIds];
  const ph = allExtIds.map(() => '?').join(',');

  const holdingRows = await query('getOverlapTrendHoldings', `
    WITH ext_scale AS (
      SELECT extraction_id,
        CASE WHEN SUM(pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings
      WHERE extraction_id IN (${ph})
      GROUP BY extraction_id
    )
    SELECT h.extraction_id, h.isin, h.stock_name, h.industry, h.pct_nav, es.scale
    FROM holdings h
    JOIN ext_scale es ON es.extraction_id = h.extraction_id
    WHERE h.extraction_id IN (${ph})
      AND h.isin IS NOT NULL AND h.pct_nav IS NOT NULL
      AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
  `, [...allExtIds, ...allExtIds]);

  // Group by extraction_id
  const holdingsByExt = {};
  for (const r of holdingRows) {
    if (!holdingsByExt[r.extraction_id]) holdingsByExt[r.extraction_id] = new Map();
    holdingsByExt[r.extraction_id].set(r.isin, { ...r, pct: parseFloat((r.pct_nav * r.scale).toFixed(4)) });
  }

  const result = [];
  for (const m of months) {
    const holdingsA = holdingsByExt[m.ext_a_id] || new Map();
    const holdingsB = holdingsByExt[m.ext_b_id] || new Map();

    const shared = [];
    const uniqueA = [];
    const uniqueB = [];

    for (const [isin, hA] of holdingsA) {
      if (holdingsB.has(isin)) {
        const hB = holdingsB.get(isin);
        shared.push({ isin, stock_name: hA.stock_name, industry: hA.industry, pct_a: hA.pct, pct_b: hB.pct, min_pct: parseFloat(Math.min(hA.pct, hB.pct).toFixed(4)) });
      } else {
        uniqueA.push({ isin, stock_name: hA.stock_name, industry: hA.industry, pct: hA.pct });
      }
    }
    for (const [isin, hB] of holdingsB) {
      if (!holdingsA.has(isin)) {
        uniqueB.push({ isin, stock_name: hB.stock_name, industry: hB.industry, pct: hB.pct });
      }
    }
    shared.sort((a, b) => b.min_pct - a.min_pct);
    uniqueA.sort((a, b) => b.pct - a.pct);
    uniqueB.sort((a, b) => b.pct - a.pct);

    const totalA          = [...holdingsA.values()].reduce((s, h) => s + h.pct, 0);
    const totalB          = [...holdingsB.values()].reduce((s, h) => s + h.pct, 0);
    const weightedOverlap = shared.reduce((s, h) => s + h.min_pct, 0);
    const overlapPctA     = totalA > 0 ? (weightedOverlap / totalA) * 100 : 0;
    const overlapPctB     = totalB > 0 ? (weightedOverlap / totalB) * 100 : 0;

    result.push({
      month:           m.report_month,
      overlap_pct:     parseFloat(((overlapPctA + overlapPctB) / 2).toFixed(2)),
      overlap_pct_a:   parseFloat(overlapPctA.toFixed(2)),
      overlap_pct_b:   parseFloat(overlapPctB.toFixed(2)),
      shared_count:    shared.length,
      shared_holdings: shared,
      unique_a:        uniqueA,
      unique_b:        uniqueB,
    });
  }

  const ms = (performance.now() - t0).toFixed(1);
  logger.ok(`getOverlapTrend  →  ${result.length} month(s)  \x1b[2m(${ms}ms)\x1b[0m`);
  return result;
}

// ─── SECTOR DRIFT ────────────────────────────────────────────────────────────

export async function getSectorDrift(fundId) {
  logger.info(`getSectorDrift — fund=${fundId}`);

  const rows = await query('getSectorDrift', `
    WITH ext_scale AS (
      SELECT extraction_id,
        CASE WHEN SUM(pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings GROUP BY extraction_id
    )
    SELECT e.report_month,
           COALESCE(h.industry, 'Unknown') AS industry,
           ROUND(SUM(h.pct_nav * es.scale), 2) AS pct
    FROM holdings h
    JOIN extractions e  ON e.id = h.extraction_id
    JOIN ext_scale   es ON es.extraction_id = h.extraction_id
    WHERE e.fund_id = ?
      AND h.pct_nav IS NOT NULL
      AND h.isin NOT LIKE 'IN002%'
      AND h.isin NOT LIKE 'INCBLO%'
      AND h.isin NOT LIKE 'INF%'
      AND h.industry GLOB '[A-Za-z]*'
    GROUP BY e.report_month, industry
    ORDER BY e.report_month ASC, pct DESC
  `, [fundId]);

  const monthMap = new Map();
  const industrySet = new Set();
  for (const r of rows) {
    if (!monthMap.has(r.report_month)) monthMap.set(r.report_month, {});
    monthMap.get(r.report_month)[r.industry] = r.pct;
    industrySet.add(r.industry);
  }

  const months     = [...monthMap.keys()];
  const industries = [...industrySet];
  industries.sort((a, b) => {
    const avgA = months.reduce((s, m) => s + (monthMap.get(m)[a] || 0), 0) / months.length;
    const avgB = months.reduce((s, m) => s + (monthMap.get(m)[b] || 0), 0) / months.length;
    return avgB - avgA;
  });

  const series = months.map(month => {
    const entry = { month };
    for (const ind of industries) entry[ind] = monthMap.get(month)[ind] ?? 0;
    return entry;
  });

  logger.ok(`getSectorDrift  →  ${months.length} month(s)  ${industries.length} sector(s)`);
  return { series, industries, months };
}

// ─── HIDDEN GEMS ─────────────────────────────────────────────────────────────

export async function getHiddenGems() {
  logger.info('getHiddenGems');

  const rows = await query('getHiddenGems', `
    WITH latest AS (
      SELECT fund_id, MAX(report_month) AS max_month
      FROM extractions GROUP BY fund_id
    ),
    latest_exts AS (
      SELECT e.id AS ext_id, e.fund_id, e.report_month, f.name AS fund_name
      FROM extractions e
      JOIN funds    f ON f.id = e.fund_id
      JOIN latest   l ON l.fund_id = e.fund_id AND l.max_month = e.report_month
    ),
    ext_scale AS (
      SELECT extraction_id,
        CASE WHEN SUM(pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings GROUP BY extraction_id
    ),
    isin_fund_count AS (
      SELECT h.isin, COUNT(DISTINCT le.fund_id) AS fund_count
      FROM holdings h
      JOIN latest_exts le ON le.ext_id = h.extraction_id
      WHERE h.isin IS NOT NULL
        AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
      GROUP BY h.isin
    )
    SELECT h.isin, h.stock_name, h.industry,
           le.fund_id, le.fund_name, le.report_month,
           ROUND(h.pct_nav * es.scale, 4) AS pct,
           ifc.fund_count
    FROM holdings h
    JOIN latest_exts      le  ON le.ext_id = h.extraction_id
    JOIN ext_scale        es  ON es.extraction_id = h.extraction_id
    JOIN isin_fund_count  ifc ON ifc.isin = h.isin
    WHERE h.isin IS NOT NULL AND h.pct_nav IS NOT NULL
      AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
      AND ifc.fund_count = 1
    ORDER BY pct DESC
  `);

  logger.ok(`getHiddenGems  →  ${rows.length} unique position(s)`);
  return rows;
}

// ─── ENTRY / EXIT TIMELINE ───────────────────────────────────────────────────

export async function getEntryExitTimeline(fundId) {
  return query(`getEntryExitTimeline(fund=${fundId})`, `
    WITH sf AS (
      SELECT e.id,
        CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      WHERE e.fund_id = ?
      GROUP BY e.id
    )
    SELECT
      h.isin, h.stock_name, h.industry,
      e.report_month,
      ROUND(h.pct_nav * sf.scale, 4) AS pct_nav
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN sf           ON sf.id = e.id
    WHERE e.fund_id = ?
      AND h.isin IS NOT NULL
      AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
    ORDER BY h.isin, e.report_month
  `, [fundId, fundId]);
}

// ─── MONTHLY DIFF ────────────────────────────────────────────────────────────

export async function getMonthlyDiff(fundId, monthA, monthB) {
  return query(`getMonthlyDiff(fund=${fundId}, ${monthA}→${monthB})`, `
    WITH sf AS (
      SELECT e.id,
        CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      WHERE e.fund_id = ?
      GROUP BY e.id
    )
    SELECT
      h.isin, h.stock_name, h.industry,
      e.report_month,
      ROUND(h.pct_nav * sf.scale, 4) AS pct_nav
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN sf           ON sf.id = e.id
    WHERE e.fund_id = ?
      AND e.report_month IN (?, ?)
      AND h.isin IS NOT NULL
      AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
    ORDER BY e.report_month, h.pct_nav DESC
  `, [fundId, fundId, monthA, monthB]);
}

// ─── STOCK SEARCH ─────────────────────────────────────────────────────────────

export async function searchStocks(q) {
  const like = `%${q}%`;
  return query(`searchStocks("${q}")`, `
    SELECT h.isin, h.stock_name, h.industry, MAX(s.market_cap_cat) AS market_cap_cat,
      COUNT(DISTINCT e.fund_id) AS fund_count
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    LEFT JOIN stocks s ON s.isin = h.isin
    WHERE (h.stock_name LIKE ? OR h.isin LIKE ?)
      AND h.isin IS NOT NULL
      AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
    GROUP BY h.isin
    ORDER BY fund_count DESC, h.stock_name
    LIMIT 25
  `, [like, like]);
}

// ─── STOCK TRACKER ───────────────────────────────────────────────────────────

export async function getStockTracker(isin) {
  return query(`getStockTracker(isin=${isin})`, `
    WITH sf AS (
      SELECT e.id,
        CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      GROUP BY e.id
    ),
    fund_latest AS (
      SELECT fund_id, MAX(report_month) AS fund_latest_month
      FROM extractions GROUP BY fund_id
    )
    SELECT
      h.isin, h.stock_name, h.industry,
      e.fund_id, f.name AS fund_name,
      e.report_month,
      ROUND(h.pct_nav * sf.scale, 4) AS pct_nav,
      fl.fund_latest_month,
      s.symbol_nse
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN funds        f ON f.id = e.fund_id
    JOIN sf           ON sf.id = e.id
    JOIN fund_latest  fl ON fl.fund_id = e.fund_id
    LEFT JOIN stocks  s  ON s.isin = h.isin
    WHERE h.isin = ?
    ORDER BY f.name, e.report_month
  `, [isin]);
}

// ─── TREND ───────────────────────────────────────────────────────────────────

export async function getStockTrend(fundId, isin) {
  return query(`getStockTrend(fund=${fundId}, isin=${isin})`, `
    SELECT e.report_month, h.pct_nav, h.market_value, h.quantity
    FROM holdings h
    JOIN extractions e ON e.id = h.extraction_id
    WHERE e.fund_id = ? AND h.isin = ?
    ORDER BY e.report_month ASC
  `, [fundId, isin]);
}

// ─── ALL-FUNDS NEW ENTRIES ────────────────────────────────────────────────────

export async function getAllFundsNewEntries() {
  return query('getAllFundsNewEntries', `
    WITH sf AS (
      SELECT e.id, CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h JOIN extractions e ON h.extraction_id = e.id GROUP BY e.id
    ),
    latest AS (
      SELECT fund_id, MAX(report_month) AS report_month FROM extractions GROUP BY fund_id
    ),
    prev AS (
      SELECT e.fund_id, MAX(e.report_month) AS report_month
      FROM extractions e
      JOIN latest l ON l.fund_id = e.fund_id AND e.report_month < l.report_month
      GROUP BY e.fund_id
    ),
    latest_h AS (
      SELECT h.isin, h.stock_name, h.industry, e.fund_id, f.name AS fund_name,
             ROUND(h.pct_nav * sf.scale, 4) AS pct_nav
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      JOIN funds        f ON f.id = e.fund_id
      JOIN latest       l ON l.fund_id = e.fund_id AND e.report_month = l.report_month
      JOIN sf           ON sf.id = e.id
      WHERE h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
        AND h.isin IS NOT NULL
    ),
    prev_h AS (
      SELECT DISTINCT h.isin, e.fund_id
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      JOIN prev         p ON p.fund_id = e.fund_id AND e.report_month = p.report_month
    )
    SELECT lh.isin, lh.stock_name, lh.industry, MAX(s.market_cap_cat) AS market_cap_cat,
           COUNT(DISTINCT lh.fund_id)               AS fund_count,
           ROUND(SUM(lh.pct_nav), 4)                AS total_pct,
           GROUP_CONCAT(lh.fund_name || '|' || lh.pct_nav, ';;') AS fund_details
    FROM latest_h lh
    LEFT JOIN prev_h ph ON ph.isin = lh.isin AND ph.fund_id = lh.fund_id
    LEFT JOIN stocks s  ON s.isin  = lh.isin
    WHERE ph.isin IS NULL
    GROUP BY lh.isin, lh.stock_name, lh.industry
    ORDER BY fund_count DESC, total_pct DESC
  `);
}

// ─── FUND CHURN RATES ─────────────────────────────────────────────────────────

export async function getFundChurnRates() {
  const t0 = performance.now();

  const rows = await query('getFundChurnRates', `
    SELECT DISTINCT e.fund_id, f.name AS fund_name, e.report_month, h.isin
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN funds        f ON f.id = e.fund_id
    WHERE h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
      AND h.isin IS NOT NULL
    ORDER BY e.fund_id, e.report_month
  `);

  const fundMap = new Map();
  for (const { fund_id, fund_name, report_month, isin } of rows) {
    if (!fundMap.has(fund_id)) fundMap.set(fund_id, { fund_name, months: new Map() });
    const fm = fundMap.get(fund_id);
    if (!fm.months.has(report_month)) fm.months.set(report_month, new Set());
    fm.months.get(report_month).add(isin);
  }

  const result = [];
  for (const [fund_id, { fund_name, months }] of fundMap) {
    const sorted = [...months.keys()].sort();
    for (let i = 1; i < sorted.length; i++) {
      const curr = months.get(sorted[i]);
      const prev = months.get(sorted[i - 1]);
      let new_entries = 0, exits = 0;
      for (const isin of curr) if (!prev.has(isin)) new_entries++;
      for (const isin of prev) if (!curr.has(isin)) exits++;
      const holding_count = curr.size;
      const turnover_pct  = holding_count > 0 ? +((100 * (new_entries + exits) / holding_count).toFixed(1)) : 0;
      result.push({ fund_id, fund_name, report_month: sorted[i], holding_count, new_entries, exits, turnover_pct });
    }
  }

  result.sort((a, b) => a.fund_id - b.fund_id || a.report_month.localeCompare(b.report_month));
  const ms = (performance.now() - t0).toFixed(1);
  logger.db(`getFundChurnRates  →  ${result.length} fund-month(s)  \x1b[2m(${ms}ms)\x1b[0m`);
  return result;
}

// ─── SECTOR ROTATION CALENDAR ─────────────────────────────────────────────────

export async function getSectorRotationCalendar() {
  return query('getSectorRotationCalendar', `
    WITH sf AS (
      SELECT e.id, CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h JOIN extractions e ON h.extraction_id = e.id GROUP BY e.id
    )
    SELECT e.report_month, h.industry,
           ROUND(AVG(h.pct_nav * sf.scale), 2) AS avg_pct,
           COUNT(DISTINCT e.fund_id)            AS fund_count
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN sf           ON sf.id = e.id
    WHERE h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
      AND h.industry IS NOT NULL AND TRIM(h.industry) != ''
      AND h.industry GLOB '[A-Za-z]*'
    GROUP BY e.report_month, h.industry
    ORDER BY e.report_month, h.industry
  `);
}

// ─── STOCK DISCOVERY CHAIN ────────────────────────────────────────────────────

export async function getStockDiscoveryChain() {
  return query('getStockDiscoveryChain', `
    WITH sf AS (
      SELECT e.id, CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h JOIN extractions e ON h.extraction_id = e.id GROUP BY e.id
    ),
    monthly AS (
      SELECT h.isin, h.stock_name, h.industry, e.report_month,
             COUNT(DISTINCT e.fund_id)           AS fund_count,
             ROUND(AVG(h.pct_nav * sf.scale), 4) AS avg_pct
      FROM holdings h
      JOIN extractions e ON h.extraction_id = e.id
      JOIN sf           ON sf.id = e.id
      WHERE h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
        AND h.isin IS NOT NULL
      GROUP BY h.isin, h.stock_name, h.industry, e.report_month
    ),
    peaked AS (
      SELECT isin, MAX(fund_count) AS peak_funds, MIN(report_month) AS first_month
      FROM monthly GROUP BY isin
    )
    SELECT m.isin, m.stock_name, m.industry, m.report_month, m.fund_count, m.avg_pct,
           p.peak_funds, p.first_month
    FROM monthly m
    JOIN peaked p ON p.isin = m.isin
    WHERE p.peak_funds >= 2
    ORDER BY p.peak_funds DESC, m.isin, m.report_month
  `);
}

// ─── CONCENTRATION SCORES ─────────────────────────────────────────────────────

export async function getConcentrationScores() {
  return query('getConcentrationScores', `
    WITH sf AS (
      SELECT e.id, CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h JOIN extractions e ON h.extraction_id = e.id GROUP BY e.id
    )
    SELECT e.fund_id, f.name AS fund_name, e.report_month,
           COUNT(h.isin)                                          AS holding_count,
           ROUND(MAX(h.pct_nav * sf.scale), 2)                   AS top_holding_pct,
           ROUND(SUM((h.pct_nav * sf.scale) * (h.pct_nav * sf.scale)) / 100.0, 2) AS hhi
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN funds        f ON f.id = e.fund_id
    JOIN sf           ON sf.id = e.id
    WHERE h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
    GROUP BY e.fund_id, f.name, e.report_month
    ORDER BY e.fund_id, e.report_month
  `);
}

// ─── BLENDED HOLDINGS ────────────────────────────────────────────────────────

export async function getBlendedHoldings(fundIds) {
  if (!fundIds?.length) return [];
  const ph = fundIds.map(() => '?').join(',');
  return query(`getBlendedHoldings(funds=[${fundIds}])`, `
    WITH sf AS (
      SELECT e.id, CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h JOIN extractions e ON h.extraction_id = e.id GROUP BY e.id
    ),
    latest AS (
      SELECT fund_id, MAX(report_month) AS report_month
      FROM extractions WHERE fund_id IN (${ph}) GROUP BY fund_id
    )
    SELECT h.isin, h.stock_name, h.industry, e.fund_id, f.name AS fund_name,
           ROUND(h.pct_nav * sf.scale, 4) AS pct_nav, e.report_month
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN funds        f ON f.id = e.fund_id
    JOIN latest       l ON l.fund_id = e.fund_id AND e.report_month = l.report_month
    JOIN sf           ON sf.id = e.id
    WHERE e.fund_id IN (${ph})
      AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
      AND h.isin IS NOT NULL
    ORDER BY e.fund_id, h.pct_nav DESC
  `, [...fundIds, ...fundIds]);
}

// ─── STOCK PEERS ─────────────────────────────────────────────────────────────

export async function getStockPeers(isin) {
  return query(`getStockPeers(isin=${isin})`, `
    WITH sf AS (
      SELECT e.id, CASE WHEN SUM(h.pct_nav) < 2 THEN 100.0 ELSE 1.0 END AS scale
      FROM holdings h JOIN extractions e ON h.extraction_id = e.id GROUP BY e.id
    ),
    target_industry AS (
      SELECT industry FROM holdings
      WHERE isin = ? AND industry IS NOT NULL AND industry GLOB '[A-Za-z]*'
      LIMIT 1
    ),
    latest AS (
      SELECT fund_id, MAX(report_month) AS max_month FROM extractions GROUP BY fund_id
    )
    SELECT h.isin, h.stock_name,
           COUNT(DISTINCT e.fund_id) AS fund_count,
           ROUND(AVG(h.pct_nav * sf.scale), 2) AS avg_pct
    FROM holdings h
    JOIN extractions e ON h.extraction_id = e.id
    JOIN latest       l  ON l.fund_id = e.fund_id AND l.max_month = e.report_month
    JOIN sf           ON sf.id = e.id
    JOIN target_industry ti ON h.industry = ti.industry
    WHERE h.isin != ?
      AND h.isin NOT LIKE 'IN002%' AND h.isin NOT LIKE 'INCBLO%' AND h.isin NOT LIKE 'INF%'
      AND h.isin IS NOT NULL
    GROUP BY h.isin
    ORDER BY fund_count DESC, avg_pct DESC
    LIMIT 14
  `, [isin, isin]);
}
