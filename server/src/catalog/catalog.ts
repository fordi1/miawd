import type pg from "pg";
import { readRules } from "../bookings/rules.js";
import { generateWebhookSecret } from "../webhooks/sign.js";

export type CatalogErrorCode = "NOT_FOUND" | "INVALID_INPUT" | "HAS_UPCOMING_BOOKINGS";

export class CatalogError extends Error {
  constructor(
    public readonly code: CatalogErrorCode,
    message: string,
    public readonly fields?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

type Db = pg.Pool | pg.PoolClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (path: string, message: string) => new CatalogError("INVALID_INPUT", message, [{ path, message }]);

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

/** Refuses to switch something off while a confirmed visit that has not ended yet still depends on it. */
async function assertNoUpcoming(c: Db, businessId: string, column: "staff_id" | "service_id" | "zone_id", id: string, now: Date) {
  const { rowCount } = await c.query(
    `SELECT 1 FROM bookings WHERE business_id = $1 AND ${column} = $2 AND status = 'confirmed' AND ends_at > $3 LIMIT 1`,
    [businessId, id, now],
  );
  if ((rowCount ?? 0) > 0) {
    throw new CatalogError("HAS_UPCOMING_BOOKINGS", "It still has upcoming confirmed bookings; move or cancel them first");
  }
}

/** UPDATE with only the columns that were provided (column names are fixed in this file, never user input). */
async function updateColumns(c: Db, table: "staff" | "services" | "zones", businessId: string, id: string, cols: Record<string, unknown>) {
  const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
  await c.query(`UPDATE ${table} SET ${sets} WHERE business_id = $1 AND id = $2`, [businessId, id, ...entries.map(([, v]) => v)]);
}

// ---------------------------------------------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------------------------------------------

export interface WorkingInterval {
  weekday: number; // 0 = Sunday … 6 = Saturday
  start: string; // HH:mm
  end: string; // HH:mm
}

export interface StaffRecord {
  id: string;
  name_ar: string;
  name_en: string | null;
  phone: string | null;
  color: string;
  active: boolean;
  service_ids: string[];
  zone_ids: string[];
  hours: WorkingInterval[];
}

/** Saturday–Thursday 09:00–18:00 (SPEC §3.1). */
export const DEFAULT_HOURS: WorkingInterval[] = [6, 0, 1, 2, 3, 4].map((weekday) => ({ weekday, start: "09:00", end: "18:00" }));

const STAFF_SELECT = `
  SELECT st.id, st.name_ar, st.name_en, st.phone, st.color, st.active,
    COALESCE((SELECT array_agg(service_id::text ORDER BY service_id) FROM staff_services WHERE staff_id = st.id), '{}') AS service_ids,
    COALESCE((SELECT array_agg(zone_id::text ORDER BY zone_id) FROM staff_zones WHERE staff_id = st.id), '{}') AS zone_ids,
    COALESCE((SELECT json_agg(json_build_object('weekday', weekday, 'start', to_char(start_local, 'HH24:MI'), 'end', to_char(end_local, 'HH24:MI'))
                              ORDER BY weekday, start_local)
                FROM working_hours WHERE staff_id = st.id), '[]'::json) AS hours
    FROM staff st`;

async function readStaff(c: Db, businessId: string, id: string): Promise<StaffRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await c.query(`${STAFF_SELECT} WHERE st.business_id = $1 AND st.id = $2`, [businessId, id]);
  return rows[0] ?? null;
}

export const getStaff = (pool: pg.Pool, businessId: string, id: string) => readStaff(pool, businessId, id);

export async function listStaff(pool: pg.Pool, businessId: string, includeInactive: boolean): Promise<StaffRecord[]> {
  const { rows } = await pool.query(`${STAFF_SELECT} WHERE st.business_id = $1 AND ($2 OR st.active) ORDER BY st.created_at, st.id`, [
    businessId,
    includeInactive,
  ]);
  return rows;
}

/** Every id must be an existing row of this business. */
async function assertOwned(c: Db, table: "services" | "zones", businessId: string, ids: string[], field: string) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const { rows: [r] } = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1 AND id = ANY($2::uuid[])`, [businessId, unique]);
  if (r.n !== unique.length) throw invalid(field, "contains an id that does not exist in this business");
}

/** No interval may end before it starts, and two intervals of the same weekday may not overlap. */
function validateHours(hours: WorkingInterval[]) {
  const byDay = new Map<number, WorkingInterval[]>();
  for (const h of hours) {
    if (h.end <= h.start) throw invalid("hours", `end must be after start (weekday ${h.weekday}: ${h.start}–${h.end})`);
    byDay.set(h.weekday, [...(byDay.get(h.weekday) ?? []), h]);
  }
  for (const [weekday, list] of byDay) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.start < list[i - 1]!.end) throw invalid("hours", `intervals overlap on weekday ${weekday}`);
    }
  }
}

async function replaceHours(c: Db, staffId: string, hours: WorkingInterval[]) {
  await c.query("DELETE FROM working_hours WHERE staff_id = $1", [staffId]);
  if (hours.length === 0) return;
  await c.query(
    "INSERT INTO working_hours (staff_id, weekday, start_local, end_local) SELECT $1, * FROM unnest($2::smallint[], $3::time[], $4::time[])",
    [staffId, hours.map((h) => h.weekday), hours.map((h) => h.start), hours.map((h) => h.end)],
  );
}

async function replaceLinks(c: Db, table: "staff_services" | "staff_zones", staffId: string, ids: string[]) {
  const column = table === "staff_services" ? "service_id" : "zone_id";
  await c.query(`DELETE FROM ${table} WHERE staff_id = $1`, [staffId]);
  const unique = [...new Set(ids)];
  if (unique.length) await c.query(`INSERT INTO ${table} (staff_id, ${column}) SELECT $1, unnest($2::uuid[])`, [staffId, unique]);
}

export interface StaffInput {
  name_ar: string;
  name_en?: string | null;
  phone?: string | null; // E.164
  color?: string;
  service_ids?: string[];
  zone_ids?: string[];
  hours?: WorkingInterval[];
}

export function createStaff(pool: pg.Pool, businessId: string, input: StaffInput): Promise<StaffRecord> {
  return inTransaction(pool, async (c) => {
    const hours = input.hours ?? DEFAULT_HOURS;
    validateHours(hours);
    await assertOwned(c, "services", businessId, input.service_ids ?? [], "service_ids");
    await assertOwned(c, "zones", businessId, input.zone_ids ?? [], "zone_ids");

    const { rows: [row] } = await c.query(
      "INSERT INTO staff (business_id, name_ar, name_en, phone, color) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [businessId, input.name_ar, input.name_en ?? null, input.phone ?? null, input.color ?? "#4466F2"],
    );
    await replaceLinks(c, "staff_services", row.id, input.service_ids ?? []);
    await replaceLinks(c, "staff_zones", row.id, input.zone_ids ?? []);
    await replaceHours(c, row.id, hours);
    return (await readStaff(c, businessId, row.id))!;
  });
}

export interface StaffPatch {
  name_ar?: string;
  name_en?: string | null;
  phone?: string | null;
  color?: string;
  active?: boolean;
  service_ids?: string[];
  zone_ids?: string[];
}

export function updateStaff(pool: pg.Pool, businessId: string, id: string, patch: StaffPatch, now: Date): Promise<StaffRecord> {
  return inTransaction(pool, async (c) => {
    const current = UUID.test(id)
      ? (await c.query("SELECT active FROM staff WHERE id = $1 AND business_id = $2 FOR UPDATE", [id, businessId])).rows[0]
      : undefined;
    if (!current) throw new CatalogError("NOT_FOUND", "Staff member not found");

    if (patch.active === false && current.active) await assertNoUpcoming(c, businessId, "staff_id", id, now);
    if (patch.service_ids) await assertOwned(c, "services", businessId, patch.service_ids, "service_ids");
    if (patch.zone_ids) await assertOwned(c, "zones", businessId, patch.zone_ids, "zone_ids");

    await updateColumns(c, "staff", businessId, id, {
      name_ar: patch.name_ar, name_en: patch.name_en, phone: patch.phone, color: patch.color, active: patch.active,
    });
    if (patch.service_ids) await replaceLinks(c, "staff_services", id, patch.service_ids);
    if (patch.zone_ids) await replaceLinks(c, "staff_zones", id, patch.zone_ids);
    return (await readStaff(c, businessId, id))!;
  });
}

export function setStaffHours(pool: pg.Pool, businessId: string, id: string, hours: WorkingInterval[]): Promise<StaffRecord> {
  return inTransaction(pool, async (c) => {
    const found = UUID.test(id) ? (await c.query("SELECT 1 FROM staff WHERE id = $1 AND business_id = $2 FOR UPDATE", [id, businessId])).rowCount : 0;
    if (!found) throw new CatalogError("NOT_FOUND", "Staff member not found");
    validateHours(hours);
    await replaceHours(c, id, hours);
    return (await readStaff(c, businessId, id))!;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------------------------

export interface ServiceRecord {
  id: string;
  name_ar: string;
  name_en: string | null;
  aliases: string[];
  duration_min: number;
  active: boolean;
}
const SERVICE_COLS = "id, name_ar, name_en, aliases, duration_min, active";

export async function getService(db: Db, businessId: string, id: string): Promise<ServiceRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query(`SELECT ${SERVICE_COLS} FROM services WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return rows[0] ?? null;
}

export async function listServices(pool: pg.Pool, businessId: string, includeInactive: boolean): Promise<ServiceRecord[]> {
  const { rows } = await pool.query(
    `SELECT ${SERVICE_COLS} FROM services WHERE business_id = $1 AND ($2 OR active) ORDER BY created_at, id`,
    [businessId, includeInactive],
  );
  return rows;
}

export interface ServiceInput {
  name_ar: string;
  name_en?: string | null;
  aliases?: string[];
  duration_min: number;
}

export async function createService(pool: pg.Pool, businessId: string, input: ServiceInput): Promise<ServiceRecord> {
  const { rows: [r] } = await pool.query(
    `INSERT INTO services (business_id, name_ar, name_en, aliases, duration_min) VALUES ($1, $2, $3, $4, $5) RETURNING ${SERVICE_COLS}`,
    [businessId, input.name_ar, input.name_en ?? null, input.aliases ?? [], input.duration_min],
  );
  return r;
}

export type ServicePatch = Partial<ServiceInput> & { active?: boolean };

export function updateService(pool: pg.Pool, businessId: string, id: string, patch: ServicePatch, now: Date): Promise<ServiceRecord> {
  return inTransaction(pool, async (c) => {
    const current = UUID.test(id)
      ? (await c.query("SELECT active FROM services WHERE id = $1 AND business_id = $2 FOR UPDATE", [id, businessId])).rows[0]
      : undefined;
    if (!current) throw new CatalogError("NOT_FOUND", "Service not found");
    if (patch.active === false && current.active) await assertNoUpcoming(c, businessId, "service_id", id, now);
    await updateColumns(c, "services", businessId, id, { ...patch });
    return (await getService(c, businessId, id))!;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Zones (only for businesses that go to the customer)
// ---------------------------------------------------------------------------------------------------------------

export interface ZoneRecord {
  id: string;
  name_ar: string;
  name_en: string | null;
  aliases: string[];
  visit_fee_jod: string | null; // "10.000"
  active: boolean;
}
const ZONE_COLS = "id, name_ar, name_en, aliases, visit_fee_jod, active";

export async function getZone(db: Db, businessId: string, id: string): Promise<ZoneRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query(`SELECT ${ZONE_COLS} FROM zones WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return rows[0] ?? null;
}

export async function listZones(pool: pg.Pool, businessId: string, includeInactive: boolean): Promise<ZoneRecord[]> {
  const { rows } = await pool.query(`SELECT ${ZONE_COLS} FROM zones WHERE business_id = $1 AND ($2 OR active) ORDER BY created_at, id`, [
    businessId,
    includeInactive,
  ]);
  return rows;
}

export interface ZoneInput {
  name_ar: string;
  name_en?: string | null;
  aliases?: string[];
  visit_fee_jod?: number | null;
}

export async function createZone(pool: pg.Pool, businessId: string, input: ZoneInput): Promise<ZoneRecord> {
  const { rows: [biz] } = await pool.query("SELECT goes_to_customer FROM businesses WHERE id = $1", [businessId]);
  if (!biz?.goes_to_customer) throw invalid("business", "this business does not go to its customers, so it has no zones");
  const { rows: [r] } = await pool.query(
    `INSERT INTO zones (business_id, name_ar, name_en, aliases, visit_fee_jod) VALUES ($1, $2, $3, $4, $5) RETURNING ${ZONE_COLS}`,
    [businessId, input.name_ar, input.name_en ?? null, input.aliases ?? [], input.visit_fee_jod ?? null],
  );
  return r;
}

export type ZonePatch = Partial<ZoneInput> & { active?: boolean };

export function updateZone(pool: pg.Pool, businessId: string, id: string, patch: ZonePatch, now: Date): Promise<ZoneRecord> {
  return inTransaction(pool, async (c) => {
    const current = UUID.test(id)
      ? (await c.query("SELECT active FROM zones WHERE id = $1 AND business_id = $2 FOR UPDATE", [id, businessId])).rows[0]
      : undefined;
    if (!current) throw new CatalogError("NOT_FOUND", "Zone not found");
    if (patch.active === false && current.active) await assertNoUpcoming(c, businessId, "zone_id", id, now);
    await updateColumns(c, "zones", businessId, id, { ...patch });
    return (await getZone(c, businessId, id))!;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Days off (a whole business, or one staff member)
// ---------------------------------------------------------------------------------------------------------------

export interface DayOffRecord {
  id: string;
  staff_id: string | null;
  start_at: Date;
  end_at: Date;
  reason: string | null;
}
const DAY_OFF_COLS = "id, staff_id, lower(during) AS start_at, upper(during) AS end_at, reason";

export async function createDayOff(
  pool: pg.Pool,
  businessId: string,
  input: { staffId?: string | null; startsAt: Date; endsAt: Date; reason?: string | null },
): Promise<DayOffRecord> {
  if (input.endsAt <= input.startsAt) throw invalid("end_at", "must be after the start");
  if (input.staffId) {
    const ok = UUID.test(input.staffId) && ((await pool.query("SELECT 1 FROM staff WHERE id = $1 AND business_id = $2", [input.staffId, businessId])).rowCount ?? 0) > 0;
    if (!ok) throw invalid("staff_id", "no such staff member in this business");
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO days_off (business_id, staff_id, during, reason) VALUES ($1, $2, tstzrange($3, $4, '[)'), $5) RETURNING ${DAY_OFF_COLS}`,
    [businessId, input.staffId ?? null, input.startsAt, input.endsAt, input.reason ?? null],
  );
  return r;
}

/** Days off that have not ended before `endingAfter` (and start before `startingBefore`, if given). */
export async function listDaysOff(
  pool: pg.Pool,
  businessId: string,
  f: { staffId?: string; endingAfter: Date; startingBefore?: Date },
): Promise<DayOffRecord[]> {
  const { rows } = await pool.query(
    `SELECT ${DAY_OFF_COLS} FROM days_off
      WHERE business_id = $1 AND ($2::uuid IS NULL OR staff_id = $2)
        AND upper(during) > $3 AND ($4::timestamptz IS NULL OR lower(during) < $4)
      ORDER BY lower(during), id`,
    [businessId, f.staffId ?? null, f.endingAfter, f.startingBefore ?? null],
  );
  return rows;
}

export async function deleteDayOff(pool: pg.Pool, businessId: string, id: string): Promise<void> {
  const removed = UUID.test(id) ? (await pool.query("DELETE FROM days_off WHERE business_id = $1 AND id = $2", [businessId, id])).rowCount : 0;
  if (!removed) throw new CatalogError("NOT_FOUND", "Day off not found");
}

// ---------------------------------------------------------------------------------------------------------------
// The business itself
// ---------------------------------------------------------------------------------------------------------------

export interface BusinessInfo {
  name: string;
  timezone: string;
  goes_to_customer: boolean;
  staff_label_ar: string;
  staff_label_en: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  settings: {
    slot_step_min: number;
    gap_min: number;
    min_lead_min: number;
    horizon_days: number;
    change_cutoff_min: number;
    display_digits: "latin" | "arabic";
  };
}

export async function getBusinessInfo(pool: pg.Pool, businessId: string): Promise<BusinessInfo> {
  const { rows: [b] } = await pool.query(
    "SELECT name, timezone, goes_to_customer, staff_label_ar, staff_label_en, webhook_url, webhook_secret, settings FROM businesses WHERE id = $1",
    [businessId],
  );
  const rules = readRules(b.goes_to_customer, b.settings);
  return {
    name: b.name,
    timezone: b.timezone,
    goes_to_customer: b.goes_to_customer,
    staff_label_ar: b.staff_label_ar,
    staff_label_en: b.staff_label_en,
    webhook_url: b.webhook_url,
    webhook_secret: b.webhook_secret,
    settings: {
      slot_step_min: rules.slotStepMin,
      gap_min: rules.gapMin,
      min_lead_min: rules.minLeadMin,
      horizon_days: rules.horizonDays,
      change_cutoff_min: rules.changeCutoffMin,
      display_digits: b.settings?.display_digits === "arabic" ? "arabic" : "latin",
    },
  };
}

/** Merges the given settings over the stored ones. */
export async function patchSettings(pool: pg.Pool, businessId: string, settings: Record<string, number | string>): Promise<BusinessInfo> {
  await pool.query("UPDATE businesses SET settings = settings || $2::jsonb WHERE id = $1", [businessId, JSON.stringify(settings)]);
  return getBusinessInfo(pool, businessId);
}

/**
 * Sets (or, with null, removes) the URL that receives booking events. The first URL a business sets creates its
 * signing secret; changing the URL keeps it; removing the URL deletes it (so setting one again gives a new secret).
 */
export async function setWebhookUrl(pool: pg.Pool, businessId: string, url: string | null): Promise<BusinessInfo> {
  await pool.query(
    `UPDATE businesses SET webhook_url = $2::text,
            webhook_secret = CASE WHEN $2::text IS NULL THEN NULL ELSE COALESCE(webhook_secret, $3) END
      WHERE id = $1`,
    [businessId, url, generateWebhookSecret()],
  );
  return getBusinessInfo(pool, businessId);
}
