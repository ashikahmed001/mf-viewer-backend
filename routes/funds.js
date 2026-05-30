import { Router } from 'express';
import logger from '../logger.js';
import { getAllFunds, getFundById, getExtractionsByFund, compareExtractions } from '../db/queries.js';

const router = Router();

// GET /api/funds
router.get('/', async (req, res) => {
  try {
    logger.info('GET /api/funds — listing all funds');
    const funds = await getAllFunds();
    logger.ok(`Returning ${funds.length} fund(s)`);
    res.json(funds);
  } catch (err) {
    logger.error('GET /api/funds failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/funds/:id
router.get('/:id', async (req, res) => {
  try {
    logger.info(`GET /api/funds/${req.params.id}`);
    const fund = await getFundById(req.params.id);
    if (!fund) {
      logger.warn(`Fund id=${req.params.id} not found`);
      return res.status(404).json({ error: 'Fund not found' });
    }
    logger.ok(`Found fund "${fund.name}"`);
    res.json(fund);
  } catch (err) {
    logger.error(`GET /api/funds/${req.params.id} failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/funds/:id/extractions
router.get('/:id/extractions', async (req, res) => {
  try {
    logger.info(`GET /api/funds/${req.params.id}/extractions`);
    const fund = await getFundById(req.params.id);
    if (!fund) {
      logger.warn(`Fund id=${req.params.id} not found`);
      return res.status(404).json({ error: 'Fund not found' });
    }
    const extractions = await getExtractionsByFund(req.params.id);
    logger.ok(`"${fund.name}" — ${extractions.length} extraction(s)`);
    res.json(extractions);
  } catch (err) {
    logger.error(`GET /api/funds/${req.params.id}/extractions failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/funds/:id/compare?months[]=YYYY-MM&months[]=YYYY-MM
router.get('/:id/compare', async (req, res) => {
  try {
    let months = req.query['months[]'] || req.query.months;
    if (!months) {
      logger.warn('compare — missing months[] param');
      return res.status(400).json({ error: 'Provide months[] query params' });
    }
    if (!Array.isArray(months)) months = [months];
    if (months.length !== 2) {
      logger.warn(`compare — expected 2 months, got ${months.length}`);
      return res.status(400).json({ error: 'Exactly two months required' });
    }

    const normalize = (m) => m.length === 7 ? m + '-01' : m;
    const [m1, m2] = months.map(normalize);
    logger.info(`GET /api/funds/${req.params.id}/compare  "${m1}" vs "${m2}"`);

    const result = await compareExtractions(req.params.id, m1, m2);
    if (!result) {
      logger.warn(`compare — extraction(s) not found for fund=${req.params.id} months=${m1},${m2}`);
      return res.status(404).json({ error: 'Could not find extractions for one or both months' });
    }
    res.json(result);
  } catch (err) {
    logger.error(`GET /api/funds/${req.params.id}/compare failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
