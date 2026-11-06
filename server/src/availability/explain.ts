import type pg from "pg";
import { DateTime } from "luxon";
import { eligibleStaffIds, loadServiceContext } from "./findSlots.js";

export type UnavailableReason =
  | "TOO_SOON"
  | "BEYOND_HORIZON"
  | "CLOSURE"
  | "DAY_OFF"
  | "OUTSIDE_WORKING_HOURS"
  | "NOT_A_SLOT_TIME"
  | "FULLY_BOOKED";

export interface ExplainInput {
  businessId: string;
  serviceId: string;
  zoneId?: string | null;
  startsAt: Date;
  now: Date;
}

const minutesOf = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** Why can't the customer have exactly this time? Called only after findSlots did not offer it. */
export async function explainUnavailable(pool: pg.Pool, input: ExplainInput): Promise<UnavailableReason> {
  const { tz, rules, durationMs } = await loadServiceContext(pool, input.businessId, input.serviceId);
  const startMs = input.startsAt.getTime();
  const nowMs = input.now.getTime();

  if (startMs < nowMs + rules.minLeadMin * 60_000) return "TOO_SOON";
  if (startMs > nowMs + rules.horizonDays * 86_400_000) return "BEYOND_HORIZON";

  const staffIds = await eligibleStaffIds(pool, input.businessId, input.serviceId, input.zoneId);
  if (staffIds.length === 0) return "FULLY_BOOKED";

  const visit = [input.startsAt, new Date(startMs + durationMs)];

  const closure = await pool.query(
    "SELECT 1 FROM days_off WHERE business_id = $1 AND staff_id IS NULL AND during && tstzrange($2, $3, '[)') LIMIT 1",
    [input.businessId, ...visit],
  );
  if ((closure.rowCount ?? 0) > 0) return "CLOSURE";

  const local = DateTime.fromMillis(startMs, { zone: tz });
  const { rows: hours } = await pool.query(
    "SELECT staff_id, start_local::text AS s, end_local::text AS e FROM working_hours WHERE staff_id = ANY($1) AND weekday = $2",
    [staffIds, local.weekday % 7],
  );
  if (hours.length === 0) return "DAY_OFF";

  const startMin = local.hour * 60 + local.minute;
  const endMin = startMin + durationMs / 60_000;
  const covering: string[] = hours
    .filter((h) => startMin >= minutesOf(h.s) && endMin <= minutesOf(h.e))
    .map((h) => h.staff_id);
  if (covering.length === 0) return "OUTSIDE_WORKING_HOURS";

  const { rows: off } = await pool.query(
    "SELECT DISTINCT staff_id FROM days_off WHERE staff_id = ANY($1) AND during && tstzrange($2, $3, '[)')",
    [covering, ...visit],
  );
  const offIds = new Set(off.map((r) => r.staff_id as string));
  if (covering.every((id) => offIds.has(id))) return "DAY_OFF";

  if (local.second !== 0 || local.millisecond !== 0 || startMin % rules.slotStepMin !== 0) return "NOT_A_SLOT_TIME";
  return "FULLY_BOOKED";
}
