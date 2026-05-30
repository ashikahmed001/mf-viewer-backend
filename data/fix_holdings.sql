-- ============================================================
-- Holdings Data Quality Fixes
-- Run with: sqlite3 mf_portfolio < fix_holdings.sql
-- A backup has been saved as mf_portfolio.bak
-- ============================================================

BEGIN TRANSACTION;

-- ── FIX 1A: Trim leading/trailing spaces from stock names ──────────────────
-- Affects 1,191 rows
-- e.g. " HDFC Bank Limited" → "HDFC Bank Limited"
UPDATE holdings
SET stock_name = TRIM(stock_name)
WHERE stock_name != TRIM(stock_name);

-- ── FIX 1B: Strip ** and * restriction markers from stock names ────────────
-- Affects 2,535 rows
-- e.g. "HDFC Bank Limited **" → "HDFC Bank Limited"
-- e.g. "Canara Bank**"        → "Canara Bank"
UPDATE holdings
SET stock_name = TRIM(REPLACE(REPLACE(stock_name, '**', ''), ' *', ''))
WHERE stock_name LIKE '%**%' OR stock_name LIKE '% *';

-- ── FIX 1C: Normalize "Ltd." → "Limited" (optional, more aggressive) ───────
-- Uncomment if you want full name consolidation across funds
-- UPDATE holdings SET stock_name = REPLACE(stock_name, ' Ltd.', ' Limited')
--   WHERE stock_name LIKE '% Ltd.%';
-- UPDATE holdings SET stock_name = REPLACE(stock_name, ' Ltd ', ' Limited ')
--   WHERE stock_name LIKE '% Ltd %';

-- ── FIX 2: Delete F&O / futures / derivatives positions ────────────────────
-- Affects ~169 rows
-- These are "Long"/"Short" entries with contract codes like GAIL27032025
-- and NSE NIFTY option contracts — not equity holdings
DELETE FROM holdings
WHERE TRIM(UPPER(stock_name)) IN ('LONG', 'SHORT')
   OR (
        isin NOT LIKE 'IN%'
    AND isin NOT LIKE 'US%'
    AND isin NOT LIKE 'IE%'
    AND isin NOT LIKE 'XS%'
    AND isin NOT LIKE 'GB%'
    AND isin NOT LIKE 'NL%'
    AND isin NOT LIKE 'SG%'
    AND length(isin) = 12
   );

-- ── FIX 3: Delete garbled / misextracted rows ──────────────────────────────
-- Affects 108 rows
-- ISINs containing lowercase letters are not valid ISINs
-- (e.g. isin = "Construction" from a misaligned PDF parse)
DELETE FROM holdings
WHERE isin GLOB '*[a-z]*'
   OR length(isin) != 12;

-- ── FIX 4 (OPTIONAL): Delete bond/debenture holdings ──────────────────────
-- Affects ~1,600 rows
-- These are debt instruments from the same companies (HDFC Bank bonds,
-- NABARD debentures, state government bonds, etc.)
-- They have maturity dates in the name or coupon rates.
-- UNCOMMENT if your funds are equity-only and you don't want bonds:
--
-- DELETE FROM holdings
-- WHERE stock_name GLOB '*([0-9][0-9]/[0-9][0-9]/20[0-9][0-9])*'  -- has maturity date
--    OR stock_name GLOB '[0-9]*.[0-9][0-9]% *'                      -- starts with coupon %
--    OR (isin LIKE 'IN2%' AND length(isin) = 12)                    -- G-Secs
--    OR (isin LIKE 'IN3%' AND length(isin) = 12);                   -- State bonds

COMMIT;

-- ── Verify results ──────────────────────────────────────────────────────────
SELECT 'Total holdings remaining:' AS label, COUNT(*) AS value FROM holdings
UNION ALL
SELECT 'Distinct ISINs:', COUNT(DISTINCT isin) FROM holdings
UNION ALL
SELECT 'Distinct stock names:', COUNT(DISTINCT stock_name) FROM holdings
UNION ALL
SELECT 'Name variants remaining:', COUNT(*) FROM (
    SELECT stock_name FROM holdings
    WHERE stock_name LIKE '%**%' OR stock_name != TRIM(stock_name)
);
