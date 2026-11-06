import type pg from "pg";
import { signWebhook } from "./sign.js";
import { assertResolvesPublic } from "./url.js";

/** Seconds to wait after failed attempt 1, 2, 3 … (the 10th failure is final): about 22 hours in total. */
const RETRY_DELAYS_S = [5, 30, 120, 600, 1800, 3600, 10800, 21600, 43200];
const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
const LEASE = "2 minutes"; // a claimed delivery is not picked up again by another worker for this long

export interface DeliveryOptions {
  /** Tests and local development only: allow http and private/local addresses. */
  allowLocal?: boolean;
  timeoutMs?: number;
  batch?: number;
}

export interface DeliveryResult {
  delivered: number;
  /** Failed, but will be tried again later. */
  retried: number;
  /** Failed for good (out of attempts, or nowhere to send). */
  failed: number;
}

function describeError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError" || e.name === "AbortError") return `timeout after ${timeoutMs} ms`;
  if (e.cause?.code) return `${e.message ?? "request failed"} (${e.cause.code})`;
  return e.message ?? "request failed";
}

/** One POST to the business's webhook URL. Throws if it does not end in a 2xx. */
async function post(url: string, secret: string, deliveryId: string, payload: unknown, o: Required<Pick<DeliveryOptions, "allowLocal" | "timeoutMs">>) {
  if (!o.allowLocal) await assertResolvesPublic(new URL(url).hostname);
  const body = JSON.stringify(payload);
  const messageId = `msg_${deliveryId}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual", // never follow a redirect to somewhere we did not validate
    signal: AbortSignal.timeout(o.timeoutMs),
    headers: {
      "content-type": "application/json",
      "user-agent": "Mawid-Webhooks/1",
      "webhook-id": messageId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook(secret, messageId, timestamp, body),
    },
    body,
  });
  await res.body?.cancel().catch(() => undefined);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
}

/** Sends every webhook event that is due. Several workers (or several calls at once) never send the same event twice. */
export async function deliverDue(pool: pg.Pool, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  const o = { allowLocal: options.allowLocal ?? false, timeoutMs: options.timeoutMs ?? 10_000 };
  const result: DeliveryResult = { delivered: 0, retried: 0, failed: 0 };

  // Claim a batch by pushing its next_attempt_at forward (a lease), so nobody else takes it while we send.
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '${LEASE}'
      WHERE d.id IN (SELECT id FROM webhook_deliveries
                      WHERE status = 'pending' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at, created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.business_id, d.payload, d.attempt, d.created_at`,
    [options.batch ?? 20],
  );
  rows.sort((a, b) => a.created_at - b.created_at || String(a.id).localeCompare(String(b.id)));

  for (const row of rows) {
    const { rows: [biz] } = await pool.query("SELECT webhook_url, webhook_secret FROM businesses WHERE id = $1", [row.business_id]);
    const attempt = row.attempt + 1;

    let error: string | null = null;
    let final = false;
    if (!biz?.webhook_url || !biz.webhook_secret) {
      error = "no webhook URL";
      final = true;
    } else {
      try {
        await post(biz.webhook_url, biz.webhook_secret, row.id, row.payload, o);
      } catch (err) {
        error = describeError(err, o.timeoutMs);
      }
    }

    if (error === null) {
      await pool.query("UPDATE webhook_deliveries SET status = 'delivered', attempt = $2, last_error = NULL WHERE id = $1", [row.id, attempt]);
      result.delivered++;
    } else if (final || attempt >= MAX_ATTEMPTS) {
      await pool.query("UPDATE webhook_deliveries SET status = 'failed', attempt = $2, last_error = $3 WHERE id = $1", [row.id, attempt, error]);
      result.failed++;
    } else {
      await pool.query(
        "UPDATE webhook_deliveries SET attempt = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1",
        [row.id, attempt, error, RETRY_DELAYS_S[attempt - 1]],
      );
      result.retried++;
    }
  }
  return result;
}

/** Runs deliverDue every `intervalMs` (never two runs at once). `stop()` waits for the run in progress. */
export function startWebhookWorker(pool: pg.Pool, options: DeliveryOptions & { intervalMs?: number } = {}) {
  let busy = false;
  let running: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    running = deliverDue(pool, options)
      .catch((err) => console.error("webhook worker:", (err as Error).message))
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs ?? 2000);
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
