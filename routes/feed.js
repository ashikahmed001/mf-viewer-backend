import { Router } from 'express';
import logger from '../logger.js';
import { withCache } from '../cache.js';
import { getFeedData } from '../db/queries.js';

const router = Router();

// GET /api/feed?months=6 — heavy cross-fund query, cache 24h per months value
router.get('/', withCache('24h'), async (req, res) => {
  try {
    const lookback = Math.min(Math.max(parseInt(req.query.months) || 6, 2), 12);
    logger.info(`GET /api/feed  months=${lookback}`);
    const data = await getFeedData(lookback);
    logger.ok(`feed  →  ${data.length} months`);
    res.json(data);
  } catch (err) {
    logger.error('GET /api/feed failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
