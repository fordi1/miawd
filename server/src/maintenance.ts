import type pg from "pg";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * Deletes what is no longer useful so the tables do not grow forever: idempotency keys after 24 hours (the promise
 * made in the API guide) and delivered or given-up webhook deliveries after 30 days. Waiting deliveries are never touched.
 */
export async function cleanOldRows(pool: pg.Pool, now: Date = new Date()) {
  const keys = await pool.query("DELETE FROM idempotency_keys WHERE created_at < $1", [new Date(now.getTime() - DAY)]);
  const hooks = await pool.query("DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < $1", [new Date(now.getTime() - 30 * DAY)]);
  return { idempotencyKeys: keys.rowCount ?? 0, webhookDeliveries: hooks.rowCount ?? 0 };
}

/** Runs the cleanup once at start and then every hour. A failed run is only logged; the next hour tries again. */
export function startMaintenance(pool: pg.Pool, log: (msg: string) => void = console.error) {
  const run = () => cleanOldRows(pool).catch((e) => log(`housekeeping failed: ${e instanceof Error ? e.message : String(e)}`));
  void run();
  const timer = setInterval(run, HOUR);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
