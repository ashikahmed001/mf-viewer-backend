import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/connection.js';
import { invalidate } from '../cache.js';
import logger from '../logger.js';

const router = Router();

const EXTRACTOR_URL   = process.env.EXTRACTOR_URL || 'https://mf-portfolio-extractor.fly.dev';
const SINGLE_PATH     = '/extract';
const BATCH_PATH      = '/extract/batch';

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
  const res = await fetch(`${EXTRACTOR_URL}${SINGLE_PATH}`, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Extractor returned ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── POST /api/admin/upload/single ───────────────────────────────────────────
router.post('/upload/single', upload.single('file'), async (req, res) => {
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
// Proxies files to /extract/batch SSE endpoint and normalises events to our
// standard format: start | progress | result | done | error
router.post('/upload/batch', upload.array('files', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

  // Set SSE headers before anything can fail
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const files = req.files;
  send('start', { total: files.length, files: files.map(f => f.originalname) });

  try {
    // Build multipart FormData for the batch endpoint
    const form = new FormData();
    for (const f of files) {
      form.append('files', new Blob([f.buffer], { type: f.mimetype }), f.originalname);
    }

    const upstream = await fetch(`${EXTRACTOR_URL}${BATCH_PATH}`, { method: 'POST', body: form });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => upstream.statusText);
      send('error', { error: `Extractor returned ${upstream.status}: ${text}` });
      return res.end();
    }

    // Parse the upstream SSE stream and normalise each event
    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let completedCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop(); // keep incomplete trailing chunk

      for (const chunk of chunks) {
        if (!chunk.trim()) continue;

        // Extract optional event name and data line
        const eventName = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        const dataStr   = chunk.match(/^data:\s*(.+)$/m)?.[1]?.trim();
        if (!dataStr) continue;

        let parsed;
        try { parsed = JSON.parse(dataStr); } catch { continue; }

        // ── Normalise to our standard events ──────────────────────────────────
        // Pattern A: upstream sends a completed result (has 'holdings' array)
        if (Array.isArray(parsed?.holdings)) {
          completedCount++;
          send('result', {
            file:   parsed.source_file || `file_${completedCount}`,
            index:  completedCount - 1,
            status: 'done',
            result: parsed,
          });
          continue;
        }

        // Pattern B: upstream sends a progress/status update
        if (parsed?.status === 'processing' || parsed?.status === 'started') {
          send('progress', {
            file:   parsed.file || parsed.filename || parsed.source_file || '',
            status: 'processing',
          });
          continue;
        }

        // Pattern C: upstream sends an error for a specific file
        if (parsed?.error || parsed?.status === 'error') {
          send('result', {
            file:   parsed.file || parsed.filename || '',
            status: 'error',
            error:  parsed.error || parsed.message || 'Extraction failed',
          });
          continue;
        }

        // Pattern D: upstream sends its own done/complete event
        if (parsed?.status === 'done' || parsed?.status === 'complete' || eventName === 'done') {
          // Don't forward yet — we send our own 'done' below
          continue;
        }

        // Fallback: forward raw data as-is so nothing is silently dropped
        logger.debug('batch SSE unknown event:', JSON.stringify(parsed).slice(0, 120));
      }
    }

    send('done', { total: files.length, completed: completedCount });
  } catch (err) {
    logger.error('upload/batch:', err.message);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
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
