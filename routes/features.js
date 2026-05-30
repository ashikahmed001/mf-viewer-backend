import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import logger from '../logger.js';

const router = Router();

async function q(sql, args = []) {
  const r = await getDb().execute({ sql, args });
  return Array.from(r.rows);
}
async function exec(sql, args = []) {
  return getDb().execute({ sql, args });
}

// ─── GET /api/features — all flags + system settings (public) ────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await q('SELECT key, label, description, category, required_plan FROM feature_flags ORDER BY category, label');
    const setting = await q('SELECT value FROM app_settings WHERE key = ?', ['payments_enabled']);
    const paymentsEnabled = setting[0]?.value !== 'false';
    res.json({ flags: rows, paymentsEnabled });
  } catch (err) {
    logger.error('GET /api/features failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/features/payments — toggle payments on/off (admin only) ──────
router.patch('/payments', requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  try {
    await exec(
      `INSERT INTO app_settings (key, value) VALUES ('payments_enabled', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(enabled)]
    );
    logger.ok(`payments_enabled → ${enabled}`);
    res.json({ paymentsEnabled: enabled });
  } catch (err) {
    logger.error('PATCH /api/features/payments failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/features/:key — update required_plan (admin only) ────────────
router.patch('/:key', requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { required_plan } = req.body;
  if (!['free', 'pro'].includes(required_plan)) {
    return res.status(400).json({ error: 'required_plan must be "free" or "pro"' });
  }
  try {
    await exec('UPDATE feature_flags SET required_plan = ? WHERE key = ?', [required_plan, key]);
    logger.ok(`feature flag — ${key} → ${required_plan}`);
    res.json({ key, required_plan });
  } catch (err) {
    logger.error('PATCH /api/features failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
