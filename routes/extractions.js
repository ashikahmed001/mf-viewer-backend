import { Router } from 'express';
import logger from '../logger.js';
import { getExtractionById } from '../db/queries.js';

const router = Router();

// GET /api/extractions/:id
router.get('/:id', async (req, res) => {
  try {
    logger.info(`GET /api/extractions/${req.params.id}`);
    const extraction = await getExtractionById(req.params.id);
    if (!extraction) {
      logger.warn(`Extraction id=${req.params.id} not found`);
      return res.status(404).json({ error: 'Extraction not found' });
    }
    logger.ok(`Extraction id=${req.params.id}  fund="${extraction.fund_name}"  month=${extraction.report_month}  confidence=${extraction.confidence_label}`);
    res.json(extraction);
  } catch (err) {
    logger.error(`GET /api/extractions/${req.params.id} failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
