import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { clerkMiddleware } from '@clerk/express';

import logger from './logger.js';
import { runMigrations } from './db/connection.js';
import { scheduleNavSync } from './jobs/navSync.js';
import { requireAuth } from './middleware/requireAuth.js';
import navRouter from './routes/nav.js';
import billingRouter from './routes/billing.js';
import featuresRouter from './routes/features.js';
import adminRouter from './routes/admin.js';
import fundsRouter from './routes/funds.js';
import extractionsRouter from './routes/extractions.js';
import holdingsRouter from './routes/holdings.js';
import feedRouter from './routes/feed.js';

dotenv.config();

// Startup key check — visible in Railway logs
console.log('[boot] CLERK_SECRET_KEY     :', process.env.CLERK_SECRET_KEY     ? `sk_...${process.env.CLERK_SECRET_KEY.slice(-6)}`     : 'MISSING ❌');
console.log('[boot] CLERK_PUBLISHABLE_KEY:', process.env.CLERK_PUBLISHABLE_KEY ? `pk_...${process.env.CLERK_PUBLISHABLE_KEY.slice(-6)}` : 'MISSING ❌');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 4000;
const useLocal = process.env.LOCAL === 'true' || process.argv.includes('--local');
const DB_PATH  = useLocal
  ? path.resolve(__dirname, process.env.DB_PATH || './data/mf_portfolio')
  : (process.env.TURSO_DATABASE_URL || './data/mf_portfolio');

// ─── HTTP Request Logging (morgan) ───────────────────────────────────────────
// Custom token: response time coloured by speed
morgan.token('status-colored', (req, res) => {
  const s = res.statusCode;
  if (s >= 500) return `\x1b[31m${s}\x1b[0m`;
  if (s >= 400) return `\x1b[33m${s}\x1b[0m`;
  if (s >= 300) return `\x1b[36m${s}\x1b[0m`;
  return `\x1b[32m${s}\x1b[0m`;
});
morgan.token('rt-colored', (req, res) => {
  const ms = morgan['response-time'](req, res, 0);
  const n  = parseFloat(ms);
  if (n > 300) return `\x1b[31m${ms}ms\x1b[0m`;
  if (n > 100) return `\x1b[33m${ms}ms\x1b[0m`;
  return `\x1b[90m${ms}ms\x1b[0m`;
});

const morganFmt = '\x1b[34m\x1b[1mHTTP \x1b[0m  \x1b[2m:date[iso]\x1b[0m'
  + '  \x1b[1m:method\x1b[0m :url'
  + '  :status-colored'
  + '  :rt-colored'
  + '  \x1b[2m:res[content-length]b\x1b[0m';

app.use(morgan(morganFmt));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : '*',
  credentials: true,
}));
app.use(express.json());
// Explicitly pass keys so Railway env vars are always picked up correctly
app.use(clerkMiddleware({
  secretKey:      process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
}));

// ─── Routes ──────────────────────────────────────────────────────────────────

// Public — no auth required
app.get('/api/health', (req, res) => {
  logger.ok('Health check passed');
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Admin routes (requireAdmin is applied inside the router itself)
app.use('/api/admin',        requireAuth, adminRouter);

// Protected — all data routes require a valid Clerk session
app.use('/api/feed',         requireAuth, feedRouter);
app.use('/api/funds',        requireAuth, fundsRouter);
app.use('/api/extractions',  requireAuth, extractionsRouter);
app.use('/api/extractions',  requireAuth, holdingsRouter);
app.use('/api/holdings',     requireAuth, holdingsRouter);
app.use('/api/nav',          requireAuth, navRouter);
app.use('/api/billing',     billingRouter);   // webhook is public; other routes do auth internally
app.use('/api/features',    featuresRouter);  // GET is public; PATCH is admin-only

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  logger.warn(`404  ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err.message);
  if (err.stack) logger.dim(err.stack.split('\n').slice(1, 3).join(' '));
  res.status(500).json({ error: err.message });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
runMigrations()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      logger.banner(PORT, DB_PATH);
      scheduleNavSync(); // start daily NAV auto-sync job
    });
  })
  .catch(err => {
    logger.error('Failed to run DB migrations:', err.message);
    process.exit(1);
  });
