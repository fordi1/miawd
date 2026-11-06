import { createHmac, randomBytes } from "node:crypto";
import type pg from "pg";

/** The key is high-entropy random, so a keyed hash (HMAC with a server-side pepper) is enough and keeps lookups fast. */
export function hashApiKey(key: string, pepper: string): string {
  return createHmac("sha256", pepper).update(key).digest("hex");
}

/**
 * Creates a new key for the business, replacing (and so revoking) the old one.
 * The plaintext key is returned once; only its hash and last 4 characters are stored.
 */
export async function issueApiKey(pool: pg.Pool, businessId: string, pepper: string): Promise<string> {
  const { rows: [biz] } = await pool.query("SELECT is_test FROM businesses WHERE id = $1", [businessId]);
  if (!biz) throw new Error("Business not found");
  const key = `bk_${biz.is_test ? "test" : "live"}_${randomBytes(24).toString("base64url")}`;
  await pool.query("UPDATE businesses SET api_key_hash = $2, api_key_last4 = $3 WHERE id = $1", [
    businessId,
    hashApiKey(key, pepper),
    key.slice(-4),
  ]);
  return key;
}

export interface AuthedBusiness {
  id: string;
  name: string;
  timezone: string;
  goesToCustomer: boolean;
  settings: Record<string, unknown>;
}

/** Finds the active business that owns this key, or null. */
export async function authenticate(pool: pg.Pool, key: string, pepper: string): Promise<AuthedBusiness | null> {
  const { rows: [b] } = await pool.query(
    "SELECT id, name, timezone, goes_to_customer, settings FROM businesses WHERE api_key_hash = $1 AND active",
    [hashApiKey(key, pepper)],
  );
  return b ? { id: b.id, name: b.name, timezone: b.timezone, goesToCustomer: b.goes_to_customer, settings: b.settings ?? {} } : null;
}
