import { Router } from 'express';
import logger from '../logger.js';
import { withCache } from '../cache.js';
import {
  getHoldings, getHoldingsSummary, getDistinctIndustries, getStockTrend,
  getExtractionById, getCrossFundAnalysis, getRisingConviction, getOverlapMatrix,
  getOverlapTrend, getSectorDrift, getHiddenGems, getEntryExitTimeline,
  getMonthlyDiff, searchStocks, getStockTracker, getAllFundsNewEntries,
  getFundChurnRates, getSectorRotationCalendar, getStockDiscoveryChain,
  getConcentrationScores, getBlendedHoldings, getStockPeers, getMonthRangeDiff,
} from '../db/queries.js';

const router = Router();

// GET /api/extractions/:id/holdings
router.get('/:id/holdings', async (req, res) => {
  try {
    const { sort, order, industry, search } = req.query;
    logger.info(
      `GET /api/extractions/${req.params.id}/holdings` +
      (sort     ? `  sort=${sort}:${order || 'desc'}` : '') +
      (industry ? `  industry="${industry}"` : '') +
      (search   ? `  search="${search}"` : '')
    );

    const extraction = await getExtractionById(req.params.id);
    if (!extraction) {
      logger.warn(`Holdings request — extraction id=${req.params.id} not found`);
      return res.status(404).json({ error: 'Extraction not found' });
    }

    const [holdings, industries] = await Promise.all([
      getHoldings(req.params.id, { sort, order, industry, search }),
      getDistinctIndustries(req.params.id),
    ]);

    if (extraction.confidence_label === 'Low') {
      logger.warn(`Serving LOW-confidence extraction id=${req.params.id} (score=${extraction.confidence_score}%)`);
    }

    logger.ok(`Holdings  extraction=${req.params.id}  returned=${holdings.length}  industries=${industries.length}`);
    res.json({ extraction, holdings, industries });
  } catch (err) {
    logger.error(`GET /api/extractions/${req.params.id}/holdings failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/extractions/:id/holdings/summary — extractions are immutable; cache 24h
router.get('/:id/holdings/summary', withCache('24h'), async (req, res) => {
  try {
    logger.info(`GET /api/extractions/${req.params.id}/holdings/summary`);

    const extraction = await getExtractionById(req.params.id);
    if (!extraction) {
      logger.warn(`Summary request — extraction id=${req.params.id} not found`);
      return res.status(404).json({ error: 'Extraction not found' });
    }

    const summary = await getHoldingsSummary(req.params.id);
    logger.ok(`Summary  extraction=${req.params.id}  total_holdings=${summary.totals?.holding_count}  industries=${summary.industryBreakdown.length}`);
    res.json({ extraction, ...summary });
  } catch (err) {
    logger.error(`GET /api/extractions/${req.params.id}/holdings/summary failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/extractions/trend/:fundId/:isin — per stock per fund, cache 1h
router.get('/trend/:fundId/:isin', withCache('24h'), async (req, res) => {
  try {
    const { fundId, isin } = req.params;
    logger.info(`GET trend  fund=${fundId}  isin=${isin}`);
    const trend = await getStockTrend(fundId, isin);
    logger.ok(`Trend  fund=${fundId}  isin=${isin}  →  ${trend.length} data point(s)`);
    res.json(trend);
  } catch (err) {
    logger.error(`GET trend/${req.params.fundId}/${req.params.isin} failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/cross-fund — heavy CTE across all funds, cache 1h
router.get('/cross-fund', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/cross-fund');
    const data = await getCrossFundAnalysis();
    logger.ok(`cross-fund  →  ${data.length} stocks`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/cross-fund failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/overlap-matrix — pairwise CTE across all funds, cache 1h
router.get('/overlap-matrix', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/overlap-matrix');
    const data = await getOverlapMatrix();
    logger.ok(`overlap-matrix  →  ${data.funds.length} funds  ${data.pairs.length} pairs`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/overlap-matrix failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/rising-conviction — window function over all funds, cache 1h
router.get('/rising-conviction', withCache('24h'), async (req, res) => {
  try {
    const lookback  = Math.min(Math.max(parseInt(req.query.window) || 6, 3), 12);
    const direction = req.query.direction === 'losing' ? 'losing' : 'rising';
    logger.info(`GET /api/holdings/rising-conviction  window=${lookback}  direction=${direction}`);
    const data = await getRisingConviction(lookback, direction);
    logger.ok(`rising-conviction[${direction}]  →  ${data.length} positions`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/rising-conviction failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/overlap-trend — per fund pair, cache 1h
router.get('/overlap-trend', withCache('24h'), async (req, res) => {
  try {
    const fundAId = parseInt(req.query.fund_a);
    const fundBId = parseInt(req.query.fund_b);
    if (!fundAId || !fundBId) return res.status(400).json({ error: 'fund_a and fund_b are required' });
    logger.info(`GET /api/holdings/overlap-trend  fund_a=${fundAId}  fund_b=${fundBId}`);
    const data = await getOverlapTrend(fundAId, fundBId);
    logger.ok(`overlap-trend  →  ${data.length} month(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/overlap-trend failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/sector-drift/:fundId — per fund, cache 1h
router.get('/sector-drift/:fundId', withCache('24h'), async (req, res) => {
  try {
    logger.info(`GET /api/holdings/sector-drift/${req.params.fundId}`);
    const data = await getSectorDrift(parseInt(req.params.fundId));
    logger.ok(`sector-drift  →  ${data.months.length} month(s)  ${data.industries.length} sector(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/sector-drift failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/hidden-gems — cross-fund, cache 1h
router.get('/hidden-gems', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/hidden-gems');
    const data = await getHiddenGems();
    logger.ok(`hidden-gems  →  ${data.length} position(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/hidden-gems failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/entry-exit/:fundId — per fund, cache 1h
router.get('/entry-exit/:fundId', withCache('24h'), async (req, res) => {
  try {
    const fundId = parseInt(req.params.fundId);
    logger.info(`GET /api/holdings/entry-exit/${fundId}`);
    const data = await getEntryExitTimeline(fundId);
    logger.ok(`entry-exit  fund=${fundId}  →  ${data.length} holding-month(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/entry-exit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/monthly-diff/:fundId?month_a=YYYY-MM&month_b=YYYY-MM
router.get('/monthly-diff/:fundId', async (req, res) => {
  try {
    const fundId = parseInt(req.params.fundId);
    const { month_a, month_b } = req.query;
    if (!month_a || !month_b) return res.status(400).json({ error: 'month_a and month_b are required' });
    logger.info(`GET /api/holdings/monthly-diff/${fundId}  ${month_a}→${month_b}`);
    const data = await getMonthlyDiff(fundId, month_a, month_b);
    logger.ok(`monthly-diff  fund=${fundId}  →  ${data.length} rows`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/monthly-diff failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/stock-search?q=hdfc
router.get('/stock-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    logger.info(`GET /api/holdings/stock-search  q="${q}"`);
    const data = await searchStocks(q);
    logger.ok(`stock-search  q="${q}"  →  ${data.length} results`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/stock-search failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/stock-tracker/:isin — per ISIN across all funds, cache 1h
router.get('/stock-tracker/:isin', withCache('24h'), async (req, res) => {
  try {
    const isin = decodeURIComponent(req.params.isin);
    logger.info(`GET /api/holdings/stock-tracker/${isin}`);
    const data = await getStockTracker(isin);
    logger.ok(`stock-tracker  isin=${isin}  →  ${data.length} holding-months`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/stock-tracker failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/new-entries — cross-fund, cache 1h
router.get('/new-entries', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/new-entries');
    const data = await getAllFundsNewEntries();
    logger.ok(`new-entries  →  ${data.length} stocks`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/new-entries failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/churn-rates — cross-fund, cache 1h
router.get('/churn-rates', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/churn-rates');
    const data = await getFundChurnRates();
    logger.ok(`churn-rates  →  ${data.length} fund-month(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/churn-rates failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/sector-rotation — cross-fund, cache 1h
router.get('/sector-rotation', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/sector-rotation');
    const data = await getSectorRotationCalendar();
    logger.ok(`sector-rotation  →  ${data.length} rows`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/sector-rotation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/discovery-chain — cross-fund, cache 1h
router.get('/discovery-chain', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/discovery-chain');
    const data = await getStockDiscoveryChain();
    logger.ok(`discovery-chain  →  ${data.length} stock-month(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/discovery-chain failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/concentration — cross-fund, cache 1h
router.get('/concentration', withCache('24h'), async (req, res) => {
  try {
    logger.info('GET /api/holdings/concentration');
    const data = await getConcentrationScores();
    logger.ok(`concentration  →  ${data.length} fund-month(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/concentration failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/blend?funds=1,2,3
router.get('/blend', async (req, res) => {
  try {
    const raw = req.query.funds ?? '';
    const fundIds = raw.split(',').map(Number).filter(n => n > 0);
    if (!fundIds.length) return res.status(400).json({ error: 'funds param required' });
    logger.info(`GET /api/holdings/blend  funds=[${fundIds}]`);
    const data = await getBlendedHoldings(fundIds);
    logger.ok(`blend  funds=[${fundIds}]  →  ${data.length} holding rows`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/blend failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/stock-peers/:isin
router.get('/stock-peers/:isin', async (req, res) => {
  try {
    const isin = decodeURIComponent(req.params.isin);
    logger.info(`GET /api/holdings/stock-peers/${isin}`);
    const data = await getStockPeers(isin);
    logger.ok(`stock-peers  isin=${isin}  →  ${data.length} peer(s)`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/stock-peers failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/holdings/multi-month-range/:fundId?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/multi-month-range/:fundId', async (req, res) => {
  try {
    const { fundId } = req.params;
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query params are required' });
    }
    logger.info(`GET /api/holdings/multi-month-range/${fundId}  start=${start}  end=${end}`);
    const data = await getMonthRangeDiff(fundId, start, end);
    if (!data || data.extractions.length < 2) {
      return res.status(404).json({ error: 'Not enough extractions in range' });
    }
    res.json(data);
  } catch (err) {
    logger.error('GET /api/holdings/multi-month-range failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
