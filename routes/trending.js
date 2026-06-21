import { Router } from 'express';
import logger from '../logger.js';

const router = Router();
const MFAPI = 'https://api.mfapi.in/mf';

// ─── In-memory cache ──────────────────────────────────────────────────────────
let cache = null;
let cachedAt = 0;
const TTL = 6 * 60 * 60 * 1000; // 6 hours

// ─── AMC name prefixes to include (all major Indian AMCs) ────────────────────
const MAJOR_AMCS = [
  'HDFC', 'ICICI Prudential', 'SBI', 'Axis', 'Kotak', 'Nippon India',
  'Mirae Asset', 'DSP', 'Tata', 'Franklin Templeton', 'Motilal Oswal',
  'UTI', 'quant', 'Canara Robeco', 'Parag Parikh', 'Aditya Birla Sun Life',
  'Bandhan', 'JM Financial', '360 ONE', 'Edelweiss', 'WhiteOak',
  'Navi', 'Mahindra Manulife', 'Invesco India', 'PGIM India', 'Sundaram',
  'Union', 'LIC MF', 'Baroda BNP', 'Groww', 'Helios', 'Samco', 'ITI',
  'NJ', 'Zerodha',
];

// Keywords that identify non-equity/non-hybrid schemes to exclude
const EXCLUDE_KEYWORDS = [
  'liquid', 'overnight', 'ultra short', 'low duration', 'short duration',
  'medium duration', 'long duration', 'dynamic bond', 'gilt',
  'banking and psu', 'corporate bond', 'credit risk', 'money market',
  'floating rate', 'arbitrage', 'fund of fund', ' fof ', 'exchange traded',
  ' etf', 'fixed maturity', 'capital protection', 'interval fund',
  'conservative hybrid',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`mfapi.in ${res.status} for ${url}`);
  return res.json();
}

// Parse "DD-MM-YYYY" → Date
function parseNavDate(str) {
  const [d, m, y] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Find the NAV value on or just before targetDate; data is newest-first
function navOnDate(data, targetDate) {
  for (const row of data) {
    const d = parseNavDate(row.date);
    if (d <= targetDate) return parseFloat(row.nav);
  }
  return null;
}

function pct(current, past) {
  if (past == null || past <= 0) return null;
  return +((current - past) / past * 100).toFixed(2);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Run promises with max concurrency
async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await tasks[idx](); }
      catch { results[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── Core computation ─────────────────────────────────────────────────────────

async function computeTrending() {
  logger.info('trending — fetching scheme list from mfapi.in…');
  const allSchemes = await fetchJson(MFAPI);
  logger.info(`trending — ${allSchemes.length} total schemes`);

  // Filter: Direct Growth + major AMC + exclude debt/liquid etc.
  const filtered = allSchemes.filter(s => {
    const name = s.schemeName.toLowerCase();
    if (!name.includes('direct'))  return false;
    if (!name.includes('growth'))  return false;
    if (name.includes('idcw') || name.includes('dividend') || name.includes('bonus')) return false;
    if (EXCLUDE_KEYWORDS.some(kw => name.includes(kw))) return false;
    return MAJOR_AMCS.some(amc => s.schemeName.toLowerCase().startsWith(amc.toLowerCase()));
  });

  logger.info(`trending — ${filtered.length} schemes after filtering`);

  const now = new Date();
  const targets = {
    '1w':  daysAgo(7),
    '1m':  daysAgo(30),
    '3m':  daysAgo(90),
    '6m':  daysAgo(180),
    '1y':  daysAgo(365),
  };

  const tasks = filtered.map(scheme => async () => {
    try {
      const data = await fetchJson(`${MFAPI}/${scheme.schemeCode}`);
      if (!data?.data?.length) return null;

      const navData = data.data; // newest-first
      const current = parseFloat(navData[0].nav);
      if (isNaN(current) || current <= 0) return null;

      // Need at least 30 days of history to be meaningful
      if (navData.length < 25) return null;

      const returns = {};
      for (const [key, date] of Object.entries(targets)) {
        const past = navOnDate(navData, date);
        returns[key] = pct(current, past);
      }

      // Skip funds with no 1M return (too new or data gap)
      if (returns['1m'] == null) return null;

      // ── Score 1: Momentum ──────────────────────────────────────────────────
      // Recency-weighted return (1M × 0.4 + 3M × 0.35 + 6M × 0.25)
      const r1m = returns['1m'] ?? 0;
      const r3m = returns['3m'] ?? r1m;
      const r6m = returns['6m'] ?? r3m;
      const rawMomentum = r1m * 0.4 + r3m * 0.35 + r6m * 0.25;

      // ── Monthly returns for consistency + risk-adj ─────────────────────────
      const monthlyRets = [];
      for (let m = 1; m <= 12; m++) {
        const start = navOnDate(navData, daysAgo(m * 30));
        const end   = navOnDate(navData, daysAgo((m - 1) * 30));
        if (start != null && end != null && start > 0) {
          monthlyRets.push((end - start) / start * 100);
        }
      }

      // ── Score 2: Acceleration ──────────────────────────────────────────────
      // Annualised 3M return minus 1Y return — picking-up-pace signal
      const ann3m = returns['3m'] != null
        ? (Math.pow(1 + returns['3m'] / 100, 365 / 90) - 1) * 100
        : null;
      const rawAcceleration = (ann3m != null && returns['1y'] != null)
        ? ann3m - returns['1y']
        : null;

      // ── Score 3: Consistency ───────────────────────────────────────────────
      // % of the last 12 months with positive returns → raw 0-100
      const rawConsistency = monthlyRets.length >= 6
        ? (monthlyRets.filter(r => r > 0).length / monthlyRets.length) * 100
        : null;

      // ── Score 4: Recovery ──────────────────────────────────────────────────
      // 1M gain minus any 6M drawdown (rewards bounce-back)
      const rawRecovery = returns['1m'] != null
        ? returns['1m'] - Math.min(0, returns['6m'] ?? 0)
        : null;

      // ── Score 5: Risk-adjusted ─────────────────────────────────────────────
      // 6M return / stddev of monthly returns (Sharpe-like)
      let rawRiskAdj = null;
      if (monthlyRets.length >= 6 && returns['6m'] != null) {
        const mean = monthlyRets.reduce((s, r) => s + r, 0) / monthlyRets.length;
        const variance = monthlyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / monthlyRets.length;
        const stddev = Math.sqrt(variance);
        if (stddev > 0.01) rawRiskAdj = returns['6m'] / stddev;
      }

      // Category from meta (e.g. "Equity Scheme - Large Cap Fund")
      const meta = data.meta ?? {};
      const rawCategory = meta.scheme_category ?? 'Other';

      // Post-filter: drop anything that's debt/liquid/money-market by category
      const rawCatLower = rawCategory.toLowerCase();
      const EXCLUDE_CATS = ['debt scheme', 'liquid', 'overnight', 'money market', 'gilt',
        'arbitrage', 'fund of funds', 'exchange traded', 'fixed maturity', 'interval',
        'capital protection', 'infrastructure debt'];
      if (EXCLUDE_CATS.some(kw => rawCatLower.includes(kw))) return null;

      // Shorten: "Equity Scheme - Large Cap Fund" → "Large Cap"
      let category = rawCategory
        .replace(/^(Equity Scheme|Hybrid Scheme|Solution Oriented Scheme|Other Scheme)\s*-\s*/i, '')
        .replace(/ Fund$/i, '')
        .replace(/ Scheme$/i, '')
        .trim() || 'Other';

      // Override mfapi.in's often-wrong scheme_category using the fund name as ground truth.
      // SEBI-defined category keywords are embedded in every fund's official name.
      const sn = scheme.schemeName.toLowerCase();
      if (sn.includes('small cap'))                                     category = 'Small Cap';
      else if (sn.includes('mid cap') && sn.includes('large'))         category = 'Large & Mid Cap';
      else if (sn.includes('mid cap'))                                  category = 'Mid Cap';
      else if (sn.includes('large cap'))                                category = 'Large Cap';
      else if (sn.includes('multi cap'))                                category = 'Multi Cap';
      else if (sn.includes('flexi cap') || sn.includes('flexi-cap'))   category = 'Flexi Cap';
      else if (sn.includes('elss') || sn.includes('tax saver') || sn.includes('tax saving')) category = 'ELSS';
      else if (sn.includes('focused'))                                  category = 'Focused';
      else if (sn.includes('value') && !sn.includes('balanced'))       category = 'Value';
      else if (sn.includes('contra'))                                   category = 'Contra';
      else if (sn.includes('dividend yield'))                           category = 'Dividend Yield';
      else if (sn.includes('aggressive hybrid') || (sn.includes('balanced') && sn.includes('advantage'))) category = 'Aggressive Hybrid';
      else if (sn.includes('equity savings'))                           category = 'Equity Savings';
      else if (sn.includes('fund of fund') || sn.includes('fof') || sn.includes('overseas') || sn.includes('global') || sn.includes('international') || sn.includes('taiwan') || sn.includes('china') || sn.includes('korea') || sn.includes('japan') || sn.includes('nasdaq') || sn.includes('s&p') || sn.includes('europe') || sn.includes('us equity')) category = 'FoF / Overseas';
      else if (sn.includes('momentum') || sn.includes('quant') || sn.includes('esg') || sn.includes('nifty') || sn.includes('sensex') || sn.includes('index') || sn.includes('banking') || sn.includes('pharma') || sn.includes('healthcare') || sn.includes('technology') || sn.includes('tech') || sn.includes('infra') || sn.includes('defence') || sn.includes('energy') || sn.includes('consumption') || sn.includes('manufacturing') || sn.includes('psu') || sn.includes('ipo') || sn.includes('special') || sn.includes('opportunit') || sn.includes('thematic') || sn.includes('sector')) category = 'Sectoral / Thematic';

      const schemeType = meta.scheme_type ?? '';
      const fundHouse  = meta.fund_house  ?? '';

      return {
        scheme_code: String(scheme.schemeCode),
        scheme_name: data.meta?.scheme_name ?? scheme.schemeName,
        fund_house:  fundHouse,
        category,
        scheme_type: schemeType,
        nav:         +current.toFixed(4),
        nav_date:    navData[0].date,
        returns,
        rawScores: {
          momentum:     rawMomentum,
          acceleration: rawAcceleration,
          consistency:  rawConsistency,
          recovery:     rawRecovery,
          riskAdj:      rawRiskAdj,
        },
      };
    } catch {
      return null;
    }
  });

  // Fetch with concurrency = 50
  logger.info('trending — fetching NAV histories…');
  const raw = await pool(tasks, 50);
  const funds = raw.filter(Boolean);

  logger.info(`trending — computed returns for ${funds.length} funds`);

  // ── Normalize each score to 0–10 using min-max across all funds ──────────
  function normalizeScores(funds, key) {
    const vals = funds
      .map(f => f.rawScores[key])
      .filter(v => v != null && isFinite(v));
    if (vals.length < 2) {
      funds.forEach(f => {
        if (!f.scores) f.scores = {};
        f.scores[key] = null;
      });
      return;
    }
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min;
    funds.forEach(f => {
      if (!f.scores) f.scores = {};
      const v = f.rawScores[key];
      f.scores[key] = (v == null || !isFinite(v))
        ? null
        : range > 0 ? +((v - min) / range * 10).toFixed(2) : 5;
    });
  }

  ['momentum', 'acceleration', 'consistency', 'recovery', 'riskAdj']
    .forEach(k => normalizeScores(funds, k));

  // Clean up raw scores from response
  funds.forEach(f => { delete f.rawScores; });

  // Unique categories for filter chips
  const categories = [...new Set(funds.map(f => f.category))].sort();

  // Return all funds unsorted — frontend handles sorting & filtering per tab
  return { funds, categories, total: funds.length, computedAt: new Date().toISOString() };
}

// ─── GET /api/trending ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const stale = !cache || Date.now() - cachedAt > TTL;

    if (stale || forceRefresh) {
      logger.info('trending — computing fresh data…');
      cache    = await computeTrending();
      cachedAt = Date.now();
      logger.ok(`trending — cached ${cache.total} funds`);
    } else {
      logger.info('trending — serving from cache');
    }

    res.json({ ...cache, cached: !stale, cacheAge: Math.round((Date.now() - cachedAt) / 60000) });
  } catch (err) {
    logger.error('GET /api/trending failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Called from server.js after boot to warm the cache in the background
export async function prewarmTrending() {
  if (cache && Date.now() - cachedAt < TTL) return; // already warm
  logger.info('trending — pre-warming cache in background…');
  try {
    cache    = await computeTrending();
    cachedAt = Date.now();
    logger.ok(`trending — pre-warm done (${cache.total} funds)`);
  } catch (err) {
    logger.error('trending — pre-warm failed:', err.message);
  }
}

// Refresh every 5.5 hours so the cache never goes cold between TTL cycles
const REFRESH_INTERVAL = 5.5 * 60 * 60 * 1000;
setInterval(async () => {
  logger.info('trending — scheduled background refresh…');
  try {
    const fresh = await computeTrending();
    cache    = fresh;
    cachedAt = Date.now();
    logger.ok(`trending — background refresh done (${cache.total} funds)`);
  } catch (err) {
    logger.error('trending — background refresh failed:', err.message);
  }
}, REFRESH_INTERVAL);

export default router;
