import type pg from "pg";
import { issueApiKey } from "../src/auth/apiKey.js";
import { addZone, seedBusiness, setDefaultHours } from "./helpers.js";

export const PEPPER = "test-pepper-not-a-secret";
export const SECRET = "test-slot-secret-not-a-secret";

/** Saturday 7 Nov 2026, 03:00 Amman → "tomorrow" is Sunday 8 Nov (a working day). */
export const BASE = new Date("2026-11-07T00:00:00Z");

/** A business that goes to customers: one technician, service "صيانة ثلاجة" (alias "ثلاجة"), zone "الهاشمي الشمالي", an API key. */
export async function shop(pool: pg.Pool) {
  const ids = await seedBusiness(pool);
  await setDefaultHours(pool, ids.staffId);
  await pool.query("UPDATE services SET aliases = ARRAY['ثلاجة', 'براد'] WHERE id = $1", [ids.serviceId]);
  const zoneId = await addZone(pool, ids.businessId, "الهاشمي الشمالي", [ids.staffId]);
  await pool.query("UPDATE zones SET visit_fee_jod = 10 WHERE id = $1", [zoneId]);
  const key = await issueApiKey(pool, ids.businessId, PEPPER);
  return { ...ids, zoneId, key };
}
export type Shop = Awaited<ReturnType<typeof shop>>;

/** A business with nothing in it yet (no staff, services or zones) and an API key. */
export async function bareShop(pool: pg.Pool, opts: { goesToCustomer?: boolean } = {}) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const { rows: [biz] } = await pool.query(
    "INSERT INTO businesses (name, username, password_hash, goes_to_customer) VALUES ($1, $2, 'x', $3) RETURNING id",
    [`Bare ${suffix}`, `bare_${suffix}`, opts.goesToCustomer ?? true],
  );
  const key = await issueApiKey(pool, biz.id, PEPPER);
  return { businessId: biz.id as string, key };
}

export const auth = (key: string) => ({ authorization: `Bearer ${key}` });
export const customer = { customer_name: "سامر", customer_phone: "0795550100" };
