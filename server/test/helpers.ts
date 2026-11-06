import pg from "pg";
import { TEST_DATABASE_URL } from "./global-setup.js";

export function testPool(max = 10) {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max });
}

/**
 * Inserts a business with one staff member and one 60-minute service (the staff member does that service);
 * returns their ids. `settings` are merged over `gap_min`.
 */
export async function seedBusiness(
  pool: pg.Pool,
  opts: { gapMin?: number; settings?: Record<string, unknown> } = {},
) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const { rows: [biz] } = await pool.query(
    `INSERT INTO businesses (name, username, password_hash, goes_to_customer, settings)
     VALUES ($1, $2, 'x', true, $3) RETURNING id`,
    [`Test ${suffix}`, `test_${suffix}`, { gap_min: opts.gapMin ?? 30, ...opts.settings }],
  );
  const businessId = biz.id as string;
  const serviceId = await addService(pool, businessId, 'صيانة ثلاجة', 60);
  const staffId = await addStaff(pool, businessId, 'محمود', [serviceId]);
  return { businessId, staffId, serviceId };
}

export async function addService(pool: pg.Pool, businessId: string, nameAr: string, durationMin: number) {
  const { rows: [row] } = await pool.query(
    "INSERT INTO services (business_id, name_ar, duration_min) VALUES ($1, $2, $3) RETURNING id",
    [businessId, nameAr, durationMin],
  );
  return row.id as string;
}

export async function addStaff(pool: pg.Pool, businessId: string, nameAr: string, serviceIds: string[]) {
  const { rows: [row] } = await pool.query(
    "INSERT INTO staff (business_id, name_ar) VALUES ($1, $2) RETURNING id",
    [businessId, nameAr],
  );
  for (const serviceId of serviceIds) {
    await pool.query("INSERT INTO staff_services (staff_id, service_id) VALUES ($1, $2)", [row.id, serviceId]);
  }
  return row.id as string;
}

export async function addZone(pool: pg.Pool, businessId: string, nameAr: string, staffIds: string[]) {
  const { rows: [row] } = await pool.query(
    "INSERT INTO zones (business_id, name_ar) VALUES ($1, $2) RETURNING id",
    [businessId, nameAr],
  );
  for (const staffId of staffIds) {
    await pool.query("INSERT INTO staff_zones (staff_id, zone_id) VALUES ($1, $2)", [staffId, row.id]);
  }
  return row.id as string;
}

/** Jordan's default week: Saturday–Thursday 09:00–18:00, Friday off. Weekday 0 = Sunday … 6 = Saturday. */
export async function setDefaultHours(pool: pg.Pool, staffId: string, days = [6, 0, 1, 2, 3, 4], from = "09:00", to = "18:00") {
  for (const weekday of days) {
    await pool.query(
      "INSERT INTO working_hours (staff_id, weekday, start_local, end_local) VALUES ($1, $2, $3, $4)",
      [staffId, weekday, from, to],
    );
  }
}
