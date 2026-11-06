import { DateTime } from "luxon";
import type pg from "pg";
import { hashPassword } from "../auth/passwords.js";
import { CatalogError } from "../catalog/catalog.js";
import { seedSampleData } from "./sample.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PLATFORM_TIMEZONE = "Asia/Amman"; // months on the dashboard are Amman months

export interface MonthCounts {
  total: number;
  confirmed: number;
  cancelled: number;
  completed: number;
  no_show: number;
}

export interface BusinessSummary extends MonthCounts {
  id: string;
  name: string;
  username: string;
  active: boolean;
  is_test: boolean;
  goes_to_customer: boolean;
  staff_label_ar: string;
  staff_label_en: string;
  timezone: string;
  must_change_password: boolean;
  api_key_last4: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  created_at: Date;
}

/** From the first moment of the month to the first moment of the next one, in Amman time. */
export function monthRange(month: string): { from: Date; to: Date } {
  const start = DateTime.fromISO(`${month}-01`, { zone: PLATFORM_TIMEZONE });
  return { from: start.toJSDate(), to: start.plus({ months: 1 }).toJSDate() };
}

/** Businesses with the number of bookings made in the month, by their status now. Never includes password hashes or full keys. */
export async function listBusinesses(
  pool: pg.Pool,
  range: { from: Date; to: Date },
  filter: { id?: string; includeTest: boolean },
): Promise<BusinessSummary[]> {
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.username, b.active, b.is_test, b.goes_to_customer, b.staff_label_ar, b.staff_label_en, b.timezone,
            b.must_change_password, b.api_key_last4, b.webhook_url, b.webhook_secret, b.created_at,
            count(bk.id)::int AS total,
            (count(*) FILTER (WHERE bk.status = 'confirmed'))::int AS confirmed,
            (count(*) FILTER (WHERE bk.status = 'cancelled'))::int AS cancelled,
            (count(*) FILTER (WHERE bk.status = 'completed'))::int AS completed,
            (count(*) FILTER (WHERE bk.status = 'no_show'))::int AS no_show
       FROM businesses b
       LEFT JOIN bookings bk ON bk.business_id = b.id AND bk.created_at >= $1 AND bk.created_at < $2
      WHERE ($3 OR NOT b.is_test) AND ($4::uuid IS NULL OR b.id = $4)
      GROUP BY b.id
      ORDER BY b.name, b.id`,
    [range.from, range.to, filter.includeTest, filter.id ?? null],
  );
  return rows;
}

export async function getBusinessSummary(pool: pg.Pool, id: string, range: { from: Date; to: Date }): Promise<BusinessSummary | null> {
  if (!UUID.test(id)) return null;
  return (await listBusinesses(pool, range, { id, includeTest: true }))[0] ?? null;
}

export interface NewBusiness {
  name: string;
  username: string;
  password: string;
  goes_to_customer: boolean;
  staff_label_ar: string;
  staff_label_en: string;
  is_test: boolean;
}

/** Creates the business and its owner login (the owner must change the password at the first login). A test business gets sample data. */
export async function createBusiness(pool: pg.Pool, input: NewBusiness): Promise<string> {
  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(
      `INSERT INTO businesses (name, username, password_hash, goes_to_customer, staff_label_ar, staff_label_en, is_test)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.name, input.username, passwordHash, input.goes_to_customer, input.staff_label_ar, input.staff_label_en, input.is_test],
    );
    if (input.is_test) await seedSampleData(client, row.id, input.goes_to_customer);
    await client.query("COMMIT");
    return row.id;
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505") {
      throw new CatalogError("INVALID_INPUT", "username is already taken", [{ path: "username", message: "is already taken" }]);
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface BusinessPatch {
  name?: string;
  username?: string;
  goes_to_customer?: boolean;
  staff_label_ar?: string;
  staff_label_en?: string;
  active?: boolean;
}

export async function updateBusiness(pool: pg.Pool, id: string, patch: BusinessPatch): Promise<boolean> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return true;
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", "); // keys are fixed by the route's schema
  try {
    const { rowCount } = await pool.query(`UPDATE businesses SET ${sets} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
    return (rowCount ?? 0) > 0;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new CatalogError("INVALID_INPUT", "username is already taken", [{ path: "username", message: "is already taken" }]);
    }
    throw err;
  }
}

/** New temporary password: the owner must change it at the next login. */
export async function resetOwnerPassword(pool: pg.Pool, id: string, password: string): Promise<boolean> {
  const { rowCount } = await pool.query("UPDATE businesses SET password_hash = $2, must_change_password = true WHERE id = $1", [
    id,
    await hashPassword(password),
  ]);
  return (rowCount ?? 0) > 0;
}

export async function deleteBusiness(pool: pg.Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM businesses WHERE id = $1", [id]); // everything that belongs to it goes with it
  return (rowCount ?? 0) > 0;
}

/** Wipes a test business's data (bookings, staff, services, zones, days off, events) and fills in the sample data again. */
export async function resetTestData(pool: pg.Pool, id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [b] } = await client.query("SELECT goes_to_customer FROM businesses WHERE id = $1 FOR UPDATE", [id]);
    for (const table of ["webhook_deliveries", "idempotency_keys", "bookings", "days_off", "staff", "services", "zones"]) {
      await client.query(`DELETE FROM ${table} WHERE business_id = $1`, [id]);
    }
    await seedSampleData(client, id, b.goes_to_customer);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
