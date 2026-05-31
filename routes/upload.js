import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/connection.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { invalidate } from '../cache.js';
import logger from '../logger.js';

const router = Router();
router.use(requireAdmin);

const EXTRACTOR_URL   = process.env.EXTRACTOR_URL  || 'https://mf-portfolio-extractor.fly.dev';
const EXTRACT_PATH    = process.env.EXTRACTOR_PATH || '/extract';

// Multer: memory storage, 20 MB per file, 20 files max
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls)$/i)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are allowed'));
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertFund(name) {
  const db = getDb();
  const existing = await db.execute({ sql: 'SELECT id FROM funds WHERE name = ?', args: [name.trim()] });
  if (existing.rows[0]) return Number(existing.rows[0].id);
  const now = new Date().toISOString();
  const r = await db.execute({ sql: 'INSERT INTO funds (name, created_at) VALUES (?, ?)', args: [name.trim(), now] });
  return Number(r.lastInsertRowid);
}

async function getConflict(fundId, reportMonth) {
  // reportMonth may be 'YYYY-MM' or 'YYYY-MM-01'
  const month = reportMonth.slice(0, 7) + '-01';
  const db = getDb();
  const r = await db.execute({
    sql: 'SELECT id, holding_count FROM extractions WHERE fund_id = ? AND report_month = ?',
    args: [fundId, month],
  });
  return r.rows[0] ?? null;
}

async function deleteExtractionById(id) {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM holdings   WHERE extraction_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM extractions WHERE id = ?',           args: [id] });
}

async function callExtractorSingle(fileBuffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimetype }), filename);
  const res = await fetch(`${EXTRACTOR_URL}${EXTRACT_PATH}`, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Extractor returned ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── POST /api/admin/upload/single ───────────────────────────────────────────
router.post('/single', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await callExtractorSingle(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json(result);
  } catch (err) {
    logger.error('upload/single:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ─── POST /api/admin/upload/batch ────────────────────────────────────────────
// Calls single-file extractor in parallel for each file, streams SSE progress.
router.post('/batch', upload.array('files', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const files = req.files;
  send('start', { total: files.length, files: files.map(f => f.originalname) });

  // Process in parallel (cap concurrency at 3)
  const CONCURRENCY = 3;
  let idx = 0;

  async function worker() {
    while (idx < files.length) {
      const i = idx++;
      const file = files[i];
      send('progress', { file: file.originalname, index: i, status: 'processing' });
      try {
        const result = await callExtractorSingle(file.buffer, file.originalname, file.mimetype);
        send('result', { file: file.originalname, index: i, status: 'done', result });
      } catch (err) {
        send('result', { file: file.originalname, index: i, status: 'error', error: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  send('done', { total: files.length });
  res.end();
});

// ─── POST /api/admin/import ──────────────────────────────────────────────────
// Validates and persists an (edited) extraction draft to the DB.
router.post('/import', async (req, res) => {
  const { fund_name, report_month, source_file, confidence, holdings, notes, replace } = req.body;

  if (!fund_name?.trim())  return res.status(400).json({ error: 'fund_name is required' });
  if (!report_month)       return res.status(400).json({ error: 'report_month is required' });
  if (!Array.isArray(holdings) || holdings.length === 0)
    return res.status(400).json({ error: 'holdings array is required and must not be empty' });

  const monthDate = report_month.slice(0, 7) + '-01';

  try {
    const db = getDb();

    // 1. Upsert fund
    const fundId = await upsertFund(fund_name);

    // 2. Check conflict
    const conflict = await getConflict(fundId, report_month);
    if (conflict && !replace) {
      return res.status(409).json({
        conflict: true,
        existing_id:            Number(conflict.id),
        existing_holding_count: Number(conflict.holding_count),
        fund_id:                fundId,
        month:                  monthDate,
      });
    }

    // 3. Delete old extraction if replacing
    if (conflict && replace) {
      await deleteExtractionById(Number(conflict.id));
    }

    // 4. Insert extraction record
    const now = new Date().toISOString();
    const exResult = await db.execute({
      sql: `INSERT INTO extractions
              (fund_id, report_month, source_file, extracted_at, confidence_score, confidence_label, holding_count, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        fundId, monthDate, source_file || '',
        now,
        confidence?.score ?? 100,
        confidence?.label ?? 'high',
        holdings.length,
        notes || '',
      ],
    });
    const extractionId = Number(exResult.lastInsertRowid);

    // 5. Bulk-insert holdings (one at a time — Turso doesn't support batch VALUES)
    for (const h of holdings) {
      await db.execute({
        sql: `INSERT INTO holdings (extraction_id, stock_name, isin, quantity, market_value, pct_nav, industry, rating)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          extractionId,
          h.stock_name || '',
          h.isin       || '',
          h.quantity       ?? null,
          h.market_value   ?? null,
          h.pct_nav        ?? null,
          h.industry       || null,
          h.rating         || null,
        ],
      });
    }

    // 6. Bust all caches
    invalidate('*');

    logger.info(`Imported extraction ${extractionId} for "${fund_name}" (${monthDate}) — ${holdings.length} holdings`);

    res.json({
      ok:            true,
      extraction_id: extractionId,
      fund_id:       fundId,
      fund_name:     fund_name.trim(),
      holding_count: holdings.length,
    });
  } catch (err) {
    logger.error('import:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
