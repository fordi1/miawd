import type pg from "pg";
import { normalizeArabic } from "../i18n/arabic.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Named {
  id: string;
  name_ar: string;
  name_en: string | null;
  aliases: string[];
}

/** By id, or by name / alias the way a customer would type it (see normalizeArabic). */
function pick<T extends Named>(rows: T[], input: string): T | null {
  const text = input.trim();
  if (UUID.test(text)) return rows.find((r) => r.id === text.toLowerCase()) ?? null;
  const wanted = normalizeArabic(text);
  if (!wanted) return null;
  return (
    rows.find((r) => [r.name_ar, r.name_en ?? "", ...r.aliases].some((n) => n && normalizeArabic(n) === wanted)) ?? null
  );
}

export interface ServiceRow extends Named {
  duration_min: number;
}
export interface ZoneRow extends Named {
  visit_fee_jod: string | null;
}

export async function findService(pool: pg.Pool, businessId: string, input: string): Promise<ServiceRow | null> {
  const { rows } = await pool.query(
    "SELECT id, name_ar, name_en, aliases, duration_min FROM services WHERE business_id = $1 AND active",
    [businessId],
  );
  return pick<ServiceRow>(rows, input);
}

export async function findZone(pool: pg.Pool, businessId: string, input: string): Promise<ZoneRow | null> {
  const { rows } = await pool.query(
    "SELECT id, name_ar, name_en, aliases, visit_fee_jod FROM zones WHERE business_id = $1 AND active",
    [businessId],
  );
  return pick<ZoneRow>(rows, input);
}

/** True if at least one active staff member covers the zone. */
export async function zoneIsCovered(pool: pg.Pool, zoneId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM staff_zones sz JOIN staff st ON st.id = sz.staff_id AND st.active WHERE sz.zone_id = $1 LIMIT 1",
    [zoneId],
  );
  return (rowCount ?? 0) > 0;
}
