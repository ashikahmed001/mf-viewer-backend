import { createClient } from '@libsql/client';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client;
let _localDbPath = null;

export function getLocalDbPath() {
  return _localDbPath; // null if running against Turso
}

export function getDb() {
  if (!client) {
    const useLocal = process.env.LOCAL === 'true' || process.argv.includes('--local');

    let url, authToken;

    if (useLocal) {
      const dbPath = path.resolve(__dirname, '..', process.env.DB_PATH || './data/mf_portfolio');
      _localDbPath = dbPath;
      url = `file:${dbPath}`;
      logger.db(`Using local SQLite  ${dbPath}`);
    } else {
      url       = process.env.TURSO_DATABASE_URL;
      authToken = process.env.TURSO_AUTH_TOKEN;
      if (!url) throw new Error('TURSO_DATABASE_URL is not set — run with LOCAL=true to use local DB');
      logger.db(`Connecting to Turso  ${url}`);
    }

    client = createClient({ url, authToken });
    logger.ok(useLocal ? 'Local SQLite ready' : 'Turso client ready');
  }
  return client;
}

// Run once at startup to ensure NAV tables exist
export async function runMigrations() {
  const db = getDb();
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS feature_flags (
      key           TEXT NOT NULL PRIMARY KEY,
      label         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      category      TEXT NOT NULL DEFAULT 'general',
      required_plan TEXT NOT NULL DEFAULT 'free',
      enabled       INTEGER NOT NULL DEFAULT 1
    );

    INSERT OR IGNORE INTO feature_flags (key, label, description, category, required_plan) VALUES
      ('feed',              'Activity Feed',           'Portfolio change feed across all funds',          'pages',    'free'),
      ('funds_list',        'Funds List',              'View all your mutual funds',                      'pages',    'free'),
      ('holdings_table',    'Holdings Table',          'Monthly holdings with search & filter',           'pages',    'free'),
      ('industry_chart',    'Industry Pie Chart',      'Industry allocation breakdown per extraction',    'charts',   'free'),
      ('top_holdings_chart','Top Holdings Bar Chart',  'Top 10 holdings by % NAV',                       'charts',   'free'),
      ('stock_trend',       'Stock % NAV Trend',       'Track a stock''s weight over time within a fund','charts',   'pro'),
      ('nav_history',       'NAV History Chart',       'Full NAV price history from mfapi.in',           'charts',   'pro'),
      ('compare_months',    'Month Comparison',        'Side-by-side diff between two months',           'analysis', 'pro'),
      ('cross_fund',        'Cross-Fund Analysis',     'See which stocks appear across multiple funds',   'analysis', 'pro'),
      ('overlap_matrix',    'Overlap Matrix',          'Pairwise portfolio overlap between all funds',    'analysis', 'pro'),
      ('rising_conviction', 'Rising Conviction',       'Stocks with increasing weight across funds',      'analysis', 'pro'),
      ('sector_drift',      'Sector Drift',            'How sector allocations shift month to month',     'analysis', 'pro'),
      ('hidden_gems',       'Hidden Gems',             'Stocks held by few funds but with high weight',   'analysis', 'pro'),
      ('entry_exit',        'Entry & Exit Timeline',   'When stocks entered or exited the portfolio',     'analysis', 'pro'),
      ('stock_tracker',     'Stock Tracker',           'Track a specific stock across all your funds',    'analysis', 'pro'),
      ('blended_portfolio', 'Blended Portfolio',       'Combine multiple funds into one virtual portfolio','analysis','pro'),
      ('churn_rates',       'Churn Rates',             'Portfolio turnover rates per fund',               'analysis', 'pro'),
      ('sector_rotation',   'Sector Rotation Calendar','See sector weightings change month by month',     'analysis', 'pro'),
      ('discovery_chain',   'Discovery Chain',         'Which fund first picked up a stock',              'analysis', 'pro'),
      ('rolling_returns',   'Rolling Returns',         'Point-in-time and rolling return charts per fund', 'analysis', 'pro'),
      ('trending_scores',   'Trending Funds',          '5-dimensional score analysis for trending equity funds', 'analysis', 'pro');

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id          TEXT     NOT NULL PRIMARY KEY,
      plan             TEXT     NOT NULL DEFAULT 'free',
      status           TEXT     NOT NULL DEFAULT 'active',
      billing_cycle    TEXT,
      razorpay_sub_id  TEXT,
      razorpay_plan_id TEXT,
      current_start    INTEGER,
      current_end      INTEGER,
      created_at       DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at       DATETIME NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fund_nav_map (
      fund_id       INTEGER NOT NULL PRIMARY KEY,
      scheme_code   TEXT    NOT NULL,
      scheme_name   TEXT    NOT NULL,
      confirmed     INTEGER NOT NULL DEFAULT 0,
      synced_at     DATETIME,
      FOREIGN KEY (fund_id) REFERENCES funds(id)
    );

    CREATE TABLE IF NOT EXISTS nav_history (
      scheme_code TEXT NOT NULL,
      nav_date    TEXT NOT NULL,
      nav         REAL NOT NULL,
      PRIMARY KEY (scheme_code, nav_date)
    );

    CREATE INDEX IF NOT EXISTS ix_nav_history_scheme ON nav_history (scheme_code);

    -- ─── Performance indexes ────────────────────────────────────────────────
    -- holdings: most queried table (100k+ rows)

    -- Primary lookup — every single holdings query filters by extraction_id
    CREATE INDEX IF NOT EXISTS ix_holdings_extraction_id
      ON holdings (extraction_id);

    -- Sorted listings — ORDER BY pct_nav DESC (default view, summary top-10)
    CREATE INDEX IF NOT EXISTS ix_holdings_extraction_pct_nav
      ON holdings (extraction_id, pct_nav DESC);

    -- Cross-fund / overlap / stock tracker — lookup by ISIN across extractions
    CREATE INDEX IF NOT EXISTS ix_holdings_isin
      ON holdings (isin);

    -- Overlap matrix & trend — paired lookup (extraction_id, isin) for set operations
    CREATE INDEX IF NOT EXISTS ix_holdings_extraction_isin
      ON holdings (extraction_id, isin);

    -- Industry filter in holdings table view
    CREATE INDEX IF NOT EXISTS ix_holdings_extraction_industry
      ON holdings (extraction_id, industry);

    -- extractions: fund_id lookups + month-range queries
    CREATE INDEX IF NOT EXISTS ix_extractions_fund_id
      ON extractions (fund_id);

    -- Rising conviction / feed — ROW_NUMBER() OVER PARTITION BY fund_id ORDER BY report_month DESC
    CREATE INDEX IF NOT EXISTS ix_extractions_fund_month
      ON extractions (fund_id, report_month DESC);

    -- Multi-month range queries: WHERE report_month BETWEEN ? AND ?
    CREATE INDEX IF NOT EXISTS ix_extractions_report_month
      ON extractions (report_month);

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payments_enabled', 'false');
    INSERT OR IGNORE INTO app_settings (key, value) VALUES ('cache_enabled',    'true');

    CREATE TABLE IF NOT EXISTS user_feature_overrides (
      user_id       TEXT NOT NULL,
      feature_key   TEXT NOT NULL,
      enabled       INTEGER,      -- NULL = inherit global, 1 = on, 0 = off
      required_plan TEXT,         -- NULL = inherit global, 'free' | 'pro'
      created_at    DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at    DATETIME NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, feature_key)
    );

    CREATE TABLE IF NOT EXISTS stocks (
      isin           TEXT PRIMARY KEY,
      symbol_nse     TEXT,
      symbol_bse     TEXT,
      name           TEXT NOT NULL,
      sector         TEXT,
      industry       TEXT,
      market_cap     REAL,        -- in ₹ crores
      market_cap_cat TEXT,        -- 'large' | 'mid' | 'small' | 'micro'
      face_value     REAL,
      is_nifty50     INTEGER NOT NULL DEFAULT 0,
      is_nifty500    INTEGER NOT NULL DEFAULT 0,
      is_sensex      INTEGER NOT NULL DEFAULT 0,
      last_synced_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS ix_stocks_symbol_nse ON stocks (symbol_nse);
    CREATE INDEX IF NOT EXISTS ix_stocks_isin       ON stocks (isin);
    CREATE INDEX IF NOT EXISTS ix_stocks_nifty50    ON stocks (is_nifty50) WHERE is_nifty50 = 1;
    CREATE INDEX IF NOT EXISTS ix_stocks_nifty500   ON stocks (is_nifty500) WHERE is_nifty500 = 1;
  `);
  // ALTER TABLE statements can't use IF NOT EXISTS — run separately and ignore "duplicate column" errors
  const safeMigrations = [
    `ALTER TABLE feature_flags ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
  ];
  for (const sql of safeMigrations) {
    try { await db.execute(sql); } catch { /* column already exists — safe to ignore */ }
  }

  logger.ok('DB migrations applied');
}
