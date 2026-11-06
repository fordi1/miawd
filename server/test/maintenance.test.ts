import { afterAll, describe, expect, it } from "vitest";
import { cleanOldRows } from "../src/maintenance.js";
import { seedBusiness, testPool } from "./helpers.js";

const pool = testPool(3);
afterAll(() => pool.end());

const DAY = 24 * 3600 * 1000;
const now = new Date("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("housekeeping of old rows", () => {
  it("forgets idempotency keys after 24 hours and old finished webhook deliveries after 30 days, and nothing else", async () => {
    const { businessId } = await seedBusiness(pool);
    const key = (k: string, at: Date) =>
      pool.query("INSERT INTO idempotency_keys (business_id, key, request_hash, created_at) VALUES ($1, $2, 'h', $3)", [businessId, k, at]);
    await key("old", ago(25 * 3600 * 1000));
    await key("fresh", ago(23 * 3600 * 1000));

    const hook = (status: string, at: Date) =>
      pool.query("INSERT INTO webhook_deliveries (business_id, event, payload, status, created_at) VALUES ($1, 'booking.created', '{}', $2, $3)", [businessId, status, at]);
    await hook("delivered", ago(31 * DAY));
    await hook("failed", ago(31 * DAY));
    await hook("delivered", ago(29 * DAY));
    await hook("pending", ago(31 * DAY)); // still waiting to be sent: never deleted

    const removed = await cleanOldRows(pool, now);
    expect(removed.idempotencyKeys).toBeGreaterThanOrEqual(1);
    expect(removed.webhookDeliveries).toBeGreaterThanOrEqual(2);

    const keys = await pool.query("SELECT key FROM idempotency_keys WHERE business_id = $1", [businessId]);
    expect(keys.rows.map((r) => r.key)).toEqual(["fresh"]);
    const hooks = await pool.query("SELECT status, created_at FROM webhook_deliveries WHERE business_id = $1 ORDER BY status", [businessId]);
    expect(hooks.rows.map((r) => r.status)).toEqual(["delivered", "pending"]);
  });
});
