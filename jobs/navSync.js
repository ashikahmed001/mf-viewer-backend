/**
 * NAV Auto-Sync Job
 * Runs daily at 8:00 PM IST (14:30 UTC) — after mfapi.in publishes the day's NAV.
 * Uses INSERT OR IGNORE so re-runs are safe and only new rows are added.
 */

import { getDb } from '../db/connection.js';
import logger from '../logger.js';

const MFAPI = 'https://api.mfapi.in/mf';

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`mfapi.in returned ${res.status}`);
  return res.json();
}

export async function runNavSync() {
  const db = getDb();
  const { rows } = await db.execute('SELECT fund_id, scheme_code FROM fund_nav_map WHERE confirmed = 1');
  const mappings = Array.from(rows);

  if (!mappings.length) {
    logger.info('nav-sync job — no confirmed mappings, skipping');
    return;
  }

  logger.info(`nav-sync job — syncing ${mappings.length} fund(s)`);
  let added = 0, failed = 0;

  for (const m of mappings) {
    try {
      const data = await fetchJson(`${MFAPI}/${m.scheme_code}`);
      const rows = data?.data ?? [];
      const CHUNK = 500;

      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        const result = await db.batch(
          batch.map(r => ({
            sql:  'INSERT OR IGNORE INTO nav_history (scheme_code, nav_date, nav) VALUES (?,?,?)',
            args: [m.scheme_code, r.date, parseFloat(r.nav)],
          })),
          'write'
        );
        added += result.reduce((sum, r) => sum + (r.rowsAffected ?? 0), 0);
      }

      await db.execute({
        sql:  'UPDATE fund_nav_map SET synced_at = ? WHERE fund_id = ?',
        args: [new Date().toISOString(), m.fund_id],
      });
    } catch (e) {
      logger.warn(`nav-sync job — failed for scheme=${m.scheme_code}: ${e.message}`);
      failed++;
    }
  }

  logger.ok(`nav-sync job — done. ${added} new rows added, ${failed} failure(s)`);
}

/**
 * Schedule the sync job.
 * Runs at 20:00 IST = 14:30 UTC daily.
 * Also runs once immediately on boot if it's past 14:30 UTC and
 * the last sync was more than 20 hours ago (catches restarts after downtime).
 */
export function scheduleNavSync() {
  const SYNC_HOUR_UTC   = 14;
  const SYNC_MINUTE_UTC = 30;

  function msUntilNextRun() {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(SYNC_HOUR_UTC, SYNC_MINUTE_UTC, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  function scheduleNext() {
    const delay = msUntilNextRun();
    const nextRun = new Date(Date.now() + delay);
    logger.info(`nav-sync job — next run at ${nextRun.toISOString()} (in ${Math.round(delay / 60000)} min)`);
    setTimeout(async () => {
      await runNavSync().catch(e => logger.error('nav-sync job crashed:', e.message));
      scheduleNext(); // reschedule for the next day
    }, delay);
  }

  // Boot-time catch-up: if it's past the sync window today and last sync was >20h ago, run now
  async function bootCatchUp() {
    try {
      const now = new Date();
      const todaySyncTime = new Date();
      todaySyncTime.setUTCHours(SYNC_HOUR_UTC, SYNC_MINUTE_UTC, 0, 0);

      if (now < todaySyncTime) return; // sync window hasn't passed yet today

      const { rows } = await getDb().execute(
        `SELECT MAX(synced_at) as last FROM fund_nav_map WHERE confirmed = 1`
      );
      const lastSync = rows[0]?.last ? new Date(rows[0].last) : null;
      const hoursSince = lastSync ? (now - lastSync) / 3600000 : Infinity;

      if (hoursSince > 20) {
        logger.info(`nav-sync job — catching up on boot (last sync ${Math.round(hoursSince)}h ago)`);
        await runNavSync().catch(e => logger.error('nav-sync boot catch-up failed:', e.message));
      }
    } catch (e) {
      logger.warn('nav-sync boot catch-up check failed:', e.message);
    }
  }

  bootCatchUp().then(scheduleNext);
}
