import yahooFinance from 'yahoo-finance2';
import { getDb } from '../db/connection.js';
import logger from '../logger.js';


// ─── Minimal CSV parser (handles quoted fields) ───────────────────────────────
function parseCsvLine(line) {
  const values = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      values.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  values.push(cur.trim());
  return values;
}

function parseCsv(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]));
  });
}

// ─── Sync state (in-memory, reset on restart) ─────────────────────────────────
export let syncState = {
  status:      'idle',   // 'idle' | 'running' | 'done' | 'error'
  phase:       null,     // 'fetching' | 'upserting' | 'enriching' | 'done'
  progress:    0,
  total:       0,
  message:     '',
  startedAt:   null,
  completedAt: null,
  error:       null,
  counts:      { total: 0, nifty50: 0, nifty500: 0, with_market_cap: 0 },
};

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// NSE EQUITY_L.csv: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
async function fetchNseEquityMaster() {
  const text = await fetchText('https://archives.nseindia.com/content/equities/EQUITY_L.csv');
  const rows  = parseCsv(text);
  return rows
    .filter(r => r['SERIES'] === 'EQ')
    .map(r => ({
      isin:       r['ISIN NUMBER'],
      symbol_nse: r['SYMBOL'],
      name:       r['NAME OF COMPANY'],
      face_value: parseFloat(r['FACE VALUE']) || null,
    }))
    .filter(r => r.isin && r.symbol_nse);
}

// NIFTY index CSVs: Company Name, Industry, Symbol, Series, ISIN Code
async function fetchNiftyIndex(url) {
  const text = await fetchText(url);
  const rows  = parseCsv(text);
  return rows
    .map(r => ({
      isin:     (r['ISIN Code'] || '').trim(),
      symbol:   (r['Symbol'] || '').trim(),
      industry: (r['Industry'] || '').trim(),
    }))
    .filter(r => r.isin);
}

// Fetch market caps via yahoo-finance2 (handles auth/crumb internally)
async function fetchMarketCaps(symbols) {
  const results  = {};
  const BATCH    = 20;
  const DELAY_MS = 800;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);

    await Promise.allSettled(batch.map(async symbol => {
      try {
        const quote = await yahooFinance.quote(`${symbol}.NS`, { fields: ['marketCap'] });
        if (quote?.marketCap) {
          results[symbol] = Math.round(quote.marketCap / 1e7); // ₹ → crores
        }
      } catch {
        // skip — symbol may not exist on Yahoo or be delisted
      }
    }));

    const hits = batch.filter(s => results[s]).length;
    logger.dim(`[stocks-sync] Batch ${i}–${i + batch.length}: ${hits}/${batch.length} caps`);
    syncState.progress = Math.min(i + BATCH, symbols.length);

    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  return results;
}

function capCategory(crores) {
  if (!crores) return null;
  if (crores >= 20000) return 'large';
  if (crores >=  5000) return 'mid';
  if (crores >=   500) return 'small';
  return 'micro';
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function runStocksSync() {
  if (syncState.status === 'running') throw new Error('Sync already in progress');

  syncState = {
    status:    'running',
    phase:     'fetching',
    progress:  0,
    total:     0,
    message:   'Fetching NSE equity master…',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error:     null,
    counts:    { total: 0, nifty50: 0, nifty500: 0, with_market_cap: 0 },
  };

  _doSync().catch(err => {
    logger.error('[stocks-sync] Failed:', err.message);
    syncState = { ...syncState, status: 'error', error: err.message };
  });
}

// ─── Internal sync logic ──────────────────────────────────────────────────────
async function _doSync() {
  const db = getDb();

  // ── Phase 1: NSE equity master ───────────────────────────────────────────
  logger.dim('[stocks-sync] Fetching NSE equity master…');
  const equities = await fetchNseEquityMaster();
  logger.ok(`[stocks-sync] ${equities.length} EQ-series stocks loaded`);

  // ── Phase 2: NIFTY index constituents ────────────────────────────────────
  syncState.message = 'Fetching NIFTY 50 & 500 constituents…';
  logger.dim('[stocks-sync] Fetching NIFTY 50 & 500…');

  const [nifty50, nifty500] = await Promise.all([
    fetchNiftyIndex('https://archives.nseindia.com/content/indices/ind_nifty50list.csv'),
    fetchNiftyIndex('https://archives.nseindia.com/content/indices/ind_nifty500list.csv'),
  ]);
  logger.ok(`[stocks-sync] NIFTY 50: ${nifty50.length}  NIFTY 500: ${nifty500.length}`);

  const nifty50Set  = new Set(nifty50.map(r => r.isin));
  const nifty500Set = new Set(nifty500.map(r => r.isin));

  // Build sector map — NIFTY 500 has best coverage, NIFTY 50 fills gaps
  const sectorMap = {};
  for (const r of [...nifty500, ...nifty50]) {
    if (r.isin && r.industry) sectorMap[r.isin] = r.industry;
  }

  // ── Phase 3: Upsert all stocks ────────────────────────────────────────────
  syncState.phase   = 'upserting';
  syncState.message = `Upserting ${equities.length} stocks into DB…`;
  syncState.total   = equities.length;
  syncState.progress = 0;

  const BATCH = 100;
  for (let i = 0; i < equities.length; i += BATCH) {
    const chunk = equities.slice(i, i + BATCH);
    const stmts = chunk.map(s => ({
      sql: `
        INSERT INTO stocks (isin, symbol_nse, name, sector, industry, face_value, is_nifty50, is_nifty500, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(isin) DO UPDATE SET
          symbol_nse     = excluded.symbol_nse,
          name           = excluded.name,
          sector         = COALESCE(excluded.sector, stocks.sector),
          industry       = COALESCE(excluded.industry, stocks.industry),
          face_value     = excluded.face_value,
          is_nifty50     = excluded.is_nifty50,
          is_nifty500    = excluded.is_nifty500,
          last_synced_at = excluded.last_synced_at
      `,
      args: [
        s.isin, s.symbol_nse, s.name,
        sectorMap[s.isin] ?? null,
        sectorMap[s.isin] ?? null,
        s.face_value,
        nifty50Set.has(s.isin)  ? 1 : 0,
        nifty500Set.has(s.isin) ? 1 : 0,
      ],
    }));
    await db.batch(stmts, 'write');
    syncState.progress = Math.min(i + BATCH, equities.length);
  }

  // ── Phase 4: Enrich NIFTY 500 with market cap via Yahoo Finance ───────────
  const nifty500Symbols = equities
    .filter(s => nifty500Set.has(s.isin))
    .map(s => s.symbol_nse);

  syncState.phase   = 'enriching';
  syncState.message = `Fetching market caps for ${nifty500Symbols.length} NIFTY 500 stocks…`;
  syncState.total   = nifty500Symbols.length;
  syncState.progress = 0;

  logger.dim(`[stocks-sync] Enriching ${nifty500Symbols.length} symbols via Yahoo Finance…`);
  const caps = await fetchMarketCaps(nifty500Symbols);
  logger.ok(`[stocks-sync] Got market caps for ${Object.keys(caps).length} / ${nifty500Symbols.length} symbols`);

  // Write market caps in batches
  const capStmts = Object.entries(caps).map(([sym, cap]) => ({
    sql:  `UPDATE stocks SET market_cap = ?, market_cap_cat = ?, last_synced_at = datetime('now') WHERE symbol_nse = ?`,
    args: [cap, capCategory(cap), sym],
  }));
  for (let i = 0; i < capStmts.length; i += BATCH) {
    await db.batch(capStmts.slice(i, i + BATCH), 'write');
  }

  // ── Finalise ──────────────────────────────────────────────────────────────
  const countRow = (await db.execute(
    `SELECT COUNT(*) AS total,
            SUM(is_nifty50)  AS n50,
            SUM(is_nifty500) AS n500,
            SUM(CASE WHEN market_cap IS NOT NULL THEN 1 ELSE 0 END) AS ncap
     FROM stocks`
  )).rows[0];

  syncState = {
    ...syncState,
    status:      'done',
    phase:       'done',
    message:     'Sync complete',
    completedAt: new Date().toISOString(),
    counts: {
      total:           Number(countRow.total),
      nifty50:         Number(countRow.n50),
      nifty500:        Number(countRow.n500),
      with_market_cap: Number(countRow.ncap),
    },
  };

  // Persist last-sync timestamp
  await db.execute({
    sql:  `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('stocks_last_sync', datetime('now'))`,
    args: [],
  });

  logger.ok(
    `[stocks-sync] Done — total=${countRow.total}  nifty50=${countRow.n50}  nifty500=${countRow.n500}  caps=${countRow.ncap}`
  );
}
