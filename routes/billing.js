import { Router } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { getDb } from '../db/connection.js';
import { requireAuth } from '../middleware/requireAuth.js';
import logger from '../logger.js';

const router = Router();

// ─── Razorpay client (lazy, so missing keys don't crash at import) ─────────────
function getRazorpay() {
  const key_id     = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set in .env');
  return new Razorpay({ key_id, key_secret });
}

// ─── Plan IDs (set these after creating plans in Razorpay dashboard) ──────────
const PLANS = {
  monthly: process.env.RAZORPAY_PLAN_MONTHLY, // e.g. 'plan_XXXXXXXXXXXXXXXX'
  annual:  process.env.RAZORPAY_PLAN_ANNUAL,
};

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function q1(sql, args = []) {
  const r = await getDb().execute({ sql, args });
  return r.rows[0] ?? null;
}
async function exec(sql, args = []) {
  return getDb().execute({ sql, args });
}

// ─── GET /api/billing/status — current user's subscription ────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const sub = await q1('SELECT * FROM subscriptions WHERE user_id = ?', [userId]);

    if (!sub) return res.json({ plan: 'free', status: 'none' });

    // Check if a Pro subscription has expired
    const now = Math.floor(Date.now() / 1000);
    if (sub.plan === 'pro' && sub.current_end && sub.current_end < now) {
      await exec(
        `UPDATE subscriptions SET plan='free', status='expired', updated_at=datetime('now') WHERE user_id=?`,
        [userId]
      );
      return res.json({ plan: 'free', status: 'expired' });
    }

    res.json({
      plan:            sub.plan,
      status:          sub.status,
      billing_cycle:   sub.billing_cycle,
      current_end:     sub.current_end,
      razorpay_sub_id: sub.razorpay_sub_id,
    });
  } catch (err) {
    logger.error('GET /api/billing/status failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/billing/checkout — create a Razorpay subscription ──────────────
router.post('/checkout', requireAuth, async (req, res) => {
  const { cycle = 'monthly' } = req.body;
  if (!['monthly', 'annual'].includes(cycle)) {
    return res.status(400).json({ error: 'cycle must be monthly or annual' });
  }

  const planId = PLANS[cycle];
  if (!planId) {
    return res.status(503).json({ error: `Razorpay plan ID for '${cycle}' is not configured. Set RAZORPAY_PLAN_${cycle.toUpperCase()} in .env` });
  }

  try {
    const rz = getRazorpay();
    const sub = await rz.subscriptions.create({
      plan_id:         planId,
      total_count:     cycle === 'monthly' ? 120 : 10, // max months/years to charge
      quantity:        1,
      customer_notify: 1,
    });

    logger.ok(`billing checkout — user=${req.auth.userId}  cycle=${cycle}  sub=${sub.id}`);
    res.json({
      subscription_id: sub.id,
      short_url:       sub.short_url,
      razorpay_key:    process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    logger.error('POST /api/billing/checkout failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/billing/verify — called by frontend after Razorpay success ─────
// Verifies the payment signature and activates Pro.
router.post('/verify', requireAuth, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, cycle = 'monthly' } = req.body;

  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing Razorpay payment fields' });
  }

  try {
    // Verify HMAC signature
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const body   = razorpay_payment_id + '|' + razorpay_subscription_id;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== razorpay_signature) {
      logger.warn(`billing verify — signature mismatch  user=${req.auth.userId}`);
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Calculate expiry (30 days for monthly, 365 for annual)
    const now   = Math.floor(Date.now() / 1000);
    const days  = cycle === 'annual' ? 365 : 30;
    const expiry = now + days * 86400;

    const userId = req.auth.userId;
    await exec(
      `INSERT INTO subscriptions (user_id, plan, status, billing_cycle, razorpay_sub_id, razorpay_plan_id, current_start, current_end, updated_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         plan=excluded.plan, status=excluded.status, billing_cycle=excluded.billing_cycle,
         razorpay_sub_id=excluded.razorpay_sub_id, razorpay_plan_id=excluded.razorpay_plan_id,
         current_start=excluded.current_start, current_end=excluded.current_end,
         updated_at=datetime('now')`,
      [userId, 'pro', 'active', cycle, razorpay_subscription_id, PLANS[cycle], now, expiry]
    );

    logger.ok(`billing verify — Pro activated  user=${userId}  expires=${new Date(expiry * 1000).toISOString()}`);
    res.json({ plan: 'pro', status: 'active', current_end: expiry });
  } catch (err) {
    logger.error('POST /api/billing/verify failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/billing/webhook — Razorpay webhook (no auth, HMAC verified) ────
// Set this URL in Razorpay dashboard → Webhooks.
// Events handled: subscription.activated, subscription.charged, subscription.cancelled, subscription.expired
router.post('/webhook', express_raw_body, async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (secret) {
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (expected !== signature) {
      logger.warn('billing webhook — invalid signature');
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }
  }

  try {
    const event   = req.body;
    const subData = event?.payload?.subscription?.entity;
    if (!subData) return res.json({ ok: true });

    const rzSubId  = subData.id;
    const rzStatus = subData.status; // active | cancelled | expired | halted

    logger.info(`billing webhook — event=${event.event}  sub=${rzSubId}  status=${rzStatus}`);

    // Find our subscription row
    const sub = await q1('SELECT user_id FROM subscriptions WHERE razorpay_sub_id = ?', [rzSubId]);
    if (!sub) { logger.warn(`billing webhook — unknown sub ${rzSubId}`); return res.json({ ok: true }); }

    if (['cancelled', 'expired', 'halted'].includes(rzStatus)) {
      await exec(
        `UPDATE subscriptions SET plan='free', status=?, updated_at=datetime('now') WHERE razorpay_sub_id=?`,
        [rzStatus, rzSubId]
      );
      logger.ok(`billing webhook — downgraded user=${sub.user_id}  reason=${rzStatus}`);
    } else if (rzStatus === 'active' && subData.current_end) {
      await exec(
        `UPDATE subscriptions SET plan='pro', status='active', current_end=?, updated_at=datetime('now') WHERE razorpay_sub_id=?`,
        [subData.current_end, rzSubId]
      );
      logger.ok(`billing webhook — renewal confirmed user=${sub.user_id}`);
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('billing webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Middleware to capture raw body for webhook signature verification
function express_raw_body(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => { req.rawBody = data; req.body = JSON.parse(data || '{}'); next(); });
}

export default router;
