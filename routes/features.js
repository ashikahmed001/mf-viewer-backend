import { Router } from 'express';
import { getAuth } from '@clerk/express';
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

// ─── GET /api/features — all global flags + system settings (public) ─────────
router.get('/', async (req, res) => {
  try {
    const rows = await q(
      'SELECT key, label, description, category, required_plan, enabled FROM feature_flags ORDER BY category, label'
    );
    const setting = await q('SELECT value FROM app_settings WHERE key = ?', ['payments_enabled']);
    const paymentsEnabled = setting[0]?.value !== 'false';
    res.json({ flags: rows, paymentsEnabled });
  } catch (err) {
    logger.error('GET /api/features failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/features/my-overrides — current user's overrides (authenticated) ─
router.get('/my-overrides', async (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) return res.json({ overrides: [] });
  try {
    const rows = await q(
      'SELECT feature_key, enabled, required_plan FROM user_feature_overrides WHERE user_id = ?',
      [userId]
    );
    res.json({ overrides: rows });
  } catch (err) {
    logger.error('GET /api/features/my-overrides failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/features/overrides — all user overrides (admin only) ────────────
router.get('/overrides', requireAdmin, async (req, res) => {
  try {
    const rows = await q(
      `SELECT ufo.user_id, ufo.feature_key, ufo.enabled, ufo.required_plan, ufo.updated_at
       FROM user_feature_overrides ufo
       ORDER BY ufo.user_id, ufo.feature_key`
    );
    const byUser = {};
    for (const row of rows) {
      if (!byUser[row.user_id]) byUser[row.user_id] = [];
      byUser[row.user_id].push(row);
    }
    res.json({ overrides: byUser });
  } catch (err) {
    logger.error('GET /api/features/overrides failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/features/overrides/:userId/:key — set user override (admin) ─────
router.put('/overrides/:userId/:key', requireAdmin, async (req, res) => {
  const { userId, key } = req.params;
  const { enabled, required_plan } = req.body;

  if (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean or null' });
  }
  if (required_plan !== undefined && required_plan !== null && !['free', 'pro'].includes(required_plan)) {
    return res.status(400).json({ error: 'required_plan must be "free", "pro", or null' });
  }

  try {
    await exec(
      `INSERT INTO user_feature_overrides (user_id, feature_key, enabled, required_plan, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, feature_key) DO UPDATE SET
         enabled       = excluded.enabled,
         required_plan = excluded.required_plan,
         updated_at    = excluded.updated_at`,
      [userId, key, enabled === null ? null : (enabled ? 1 : 0), required_plan ?? null]
    );
    logger.ok(`feature override — user=${userId} key=${key} enabled=${enabled} plan=${required_plan}`);
    res.json({ userId, key, enabled, required_plan });
  } catch (err) {
    logger.error('PUT /api/features/overrides failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/features/overrides/:userId/:key — remove user override (admin) ─
router.delete('/overrides/:userId/:key', requireAdmin, async (req, res) => {
  const { userId, key } = req.params;
  try {
    await exec(
      'DELETE FROM user_feature_overrides WHERE user_id = ? AND feature_key = ?',
      [userId, key]
    );
    logger.ok(`feature override removed — user=${userId} key=${key}`);
    res.json({ ok: true });
  } catch (err) {
    logger.error('DELETE /api/features/overrides failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/features/payments — toggle payments on/off (admin only) ───────
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

// ─── PATCH /api/features/:key — update required_plan and/or enabled (admin) ───
router.patch('/:key', requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { required_plan, enabled } = req.body;

  if (required_plan !== undefined && !['free', 'pro'].includes(required_plan)) {
    return res.status(400).json({ error: 'required_plan must be "free" or "pro"' });
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }

  try {
    if (required_plan !== undefined) {
      await exec('UPDATE feature_flags SET required_plan = ? WHERE key = ?', [required_plan, key]);
      logger.ok(`feature flag — ${key} required_plan → ${required_plan}`);
    }
    if (enabled !== undefined) {
      await exec('UPDATE feature_flags SET enabled = ? WHERE key = ?', [enabled ? 1 : 0, key]);
      logger.ok(`feature flag — ${key} enabled → ${enabled}`);
    }
    const rows = await q('SELECT key, required_plan, enabled FROM feature_flags WHERE key = ?', [key]);
    res.json(rows[0] ?? { key, required_plan, enabled });
  } catch (err) {
    logger.error('PATCH /api/features/:key failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
