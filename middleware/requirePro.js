import { getDb } from '../db/connection.js';

/**
 * Middleware: requires an active Pro subscription.
 * Returns 403 with { error, upgrade: true } if the user is on Free.
 * Must be used after requireAuth (req.auth.userId must exist).
 */
export async function requirePro(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Admin always has full access
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && req.auth?.sessionClaims?.email === adminEmail) return next();

    const r = await getDb().execute({
      sql:  'SELECT plan, status, current_end FROM subscriptions WHERE user_id = ?',
      args: [userId],
    });
    const sub = r.rows[0] ?? null;

    // No row → free tier
    if (!sub || sub.plan !== 'pro') {
      return res.status(403).json({ error: 'Pro subscription required', upgrade: true });
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (sub.current_end && sub.current_end < now) {
      return res.status(403).json({ error: 'Pro subscription has expired', upgrade: true });
    }

    next();
  } catch (err) {
    next(err);
  }
}
