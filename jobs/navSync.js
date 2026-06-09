/**
 * NAV Auto-Sync Job
 * Runs daily at 8:00 PM IST (14:30 UTC) via node-cron — after mfapi.in publishes the day's NAV.
 *
 * Daily run: "latest-only" mode — fetches the most recent NAV entry for each fund
 * (fast, ~1 API call per fund instead of downloading full history again).
 *
 * Full sync (runNavSync) is still available for manual triggers / initial population.
 */

import cron from 'node-cron';
import { getDb } from '../db/connection.js';
import logger from '../logger.js';

const MFAPI = 'https://api.mfapi.in/mf';

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`mfapi.in returned ${res.status}`);
  return res.json();
}

// ─── Full sync (downloads entire history, used for initial sync / manual trigger) ──
export async function runNavSync() {
  const db = getDb();
  const { rows } = await db.execute('SELECT fund_id, scheme_code FROM fund_nav_map WHERE confirmed = 1');
  const mappings = Array.from(rows);

  if (!mappings.length) {
    logger.info('nav-sync job — no confirmed mappings, skipping');
    return;
  }

  logger.info(`nav-sync job — full sync for ${mappings.length} fund(s)`);
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

  logger.ok(`nav-sync job — full sync done. ${added} new rows added, ${failed} failure(s)`);
}

// ─── Latest-only sync (fast daily path — only inserts the most recent NAV row) ──
async function runLatestNavSync() {
  const db = getDb();
  const { rows } = await db.execute('SELECT fund_id, scheme_code FROM fund_nav_map WHERE confirmed = 1');
  const mappings = Array.from(rows);

  if (!mappings.length) {
    logger.info('nav-sync daily — no confirmed mappings, skipping');
    return;
  }

  logger.info(`nav-sync daily — latest-only sync for ${mappings.length} fund(s)`);
  let added = 0, skipped = 0, failed = 0;

  for (const m of mappings) {
    try {
      // /mf/{code}/latest returns just the most recent NAV entry — fast
      const data = await fetchJson(`${MFAPI}/${m.scheme_code}/latest`);
      const entry = data?.data?.[0];
      if (!entry?.date || !entry?.nav) { skipped++; continue; }

      const result = await db.execute({
        sql:  'INSERT OR IGNORE INTO nav_history (scheme_code, nav_date, nav) VALUES (?,?,?)',
        args: [m.scheme_code, entry.date, parseFloat(entry.nav)],
      });
      added += result.rowsAffected ?? 0;

      await db.execute({
        sql:  'UPDATE fund_nav_map SET synced_at = ? WHERE fund_id = ?',
        args: [new Date().toISOString(), m.fund_id],
      });
    } catch (e) {
      logger.warn(`nav-sync daily — failed for scheme=${m.scheme_code}: ${e.message}`);
      failed++;
    }
  }

  logger.ok(`nav-sync daily — done. ${added} new rows added, ${skipped} already current, ${failed} failure(s)`);
}

/**
 * Schedule the daily sync job using node-cron.
 * Fires at 20:00 IST = 14:30 UTC every day.
 * Also runs a catch-up on boot if today's sync was missed (last sync > 20h ago and past 14:30 UTC).
 */
export function scheduleNavSync() {
  // node-cron expression: minute hour day month weekday
  // 14:30 UTC daily
  cron.schedule('30 14 * * *', async () => {
    logger.info('nav-sync daily — cron fired (14:30 UTC)');
    await runLatestNavSync().catch(e => logger.error('nav-sync daily cron crashed:', e.message));
  }, { timezone: 'UTC' });

  logger.info('nav-sync job — scheduled via cron at 14:30 UTC daily');

  // Boot-time catch-up: run if it's past 14:30 UTC today and last sync was >20h ago
  async function bootCatchUp() {
    try {
      const now = new Date();
      const todaySyncTime = new Date();
      todaySyncTime.setUTCHours(14, 30, 0, 0);

      if (now < todaySyncTime) {
        logger.info('nav-sync boot — sync window not yet reached today, skipping catch-up');
        return;
      }

      const { rows } = await getDb().execute(
        `SELECT MAX(synced_at) as last FROM fund_nav_map WHERE confirmed = 1`
      );
      const lastSync = rows[0]?.last ? new Date(rows[0].last) : null;
      const hoursSince = lastSync ? (now - lastSync) / 3600000 : Infinity;

      if (hoursSince > 20) {
        logger.info(`nav-sync boot — catching up (last sync ${Math.round(hoursSince)}h ago)`);
        await runLatestNavSync().catch(e => logger.error('nav-sync boot catch-up failed:', e.message));
      } else {
        logger.info(`nav-sync boot — already synced ${Math.round(hoursSince)}h ago, no catch-up needed`);
      }
    } catch (e) {
      logger.warn('nav-sync boot catch-up check failed:', e.message);
    }
  }

  bootCatchUp();
}
