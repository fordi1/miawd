import type pg from "pg";
import { DateTime } from "luxon";
import { BookingError } from "../bookings/createBooking.js";
import { readRules, type BookingRules } from "../bookings/rules.js";

export type PartOfDay = "morning" | "noon" | "afternoon" | "evening";

export interface Slot {
  startsAt: Date;
  endsAt: Date;
  staffId: string;
  /** Local date / time in the business timezone. */
  localDate: string; // yyyy-MM-dd
  localTime: string; // HH:mm
  partOfDay: PartOfDay;
}

export interface FindSlotsInput {
  businessId: string;
  serviceId: string;
  /** Only staff who cover this zone (used when the business goes to the customer). */
  zoneId?: string | null;
  /** Inclusive local dates (business timezone), yyyy-MM-dd. */
  fromDate: string;
  toDate: string;
  /** A booking that is being rescheduled: its own time (and travel gap) counts as free. */
  ignoreBookingId?: string | null;
  /** Injectable for tests; defaults to the current time. */
  now?: Date;
}

interface Range {
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive
}

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;
const MAX_RANGE_DAYS = 31;

function partOfDay(hour: number): PartOfDay {
  if (hour < 12) return "morning";
  if (hour < 14) return "noon";
  if (hour < 18) return "afternoon";
  return "evening";
}

export interface ServiceContext {
  tz: string;
  rules: BookingRules;
  durationMs: number;
}

/** The business's timezone and booking rules, plus the length of the service. */
export async function loadServiceContext(pool: pg.Pool, businessId: string, serviceId: string): Promise<ServiceContext> {
  const { rows: [biz] } = await pool.query(
    `SELECT b.timezone, b.goes_to_customer, b.settings, s.duration_min
       FROM businesses b JOIN services s ON s.business_id = b.id AND s.id = $2 AND s.active
      WHERE b.id = $1`,
    [businessId, serviceId],
  );
  if (!biz) throw new BookingError("NOT_FOUND", "Business or service not found");
  return {
    tz: biz.timezone,
    rules: readRules(biz.goes_to_customer, biz.settings),
    durationMs: biz.duration_min * 60_000,
  };
}

/** Active staff who do this service (and cover the zone, if one is given), in a stable order. */
export async function eligibleStaffIds(
  pool: pg.Pool,
  businessId: string,
  serviceId: string,
  zoneId?: string | null,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT st.id FROM staff st
       JOIN staff_services ss ON ss.staff_id = st.id AND ss.service_id = $2
      WHERE st.business_id = $1 AND st.active
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM staff_zones sz WHERE sz.staff_id = st.id AND sz.zone_id = $3))
      ORDER BY st.created_at, st.id`,
    [businessId, serviceId, zoneId ?? null],
  );
  return rows.map((r) => r.id as string);
}

/**
 * Every bookable start time in the given local-date range, one per start time. The rules mirror the database's
 * double-booking constraint: a candidate [start, end + gap) must not overlap any confirmed booking's blocked time.
 */
export async function findSlots(pool: pg.Pool, input: FindSlotsInput): Promise<Slot[]> {
  const now = input.now ?? new Date();

  const { tz, rules, durationMs } = await loadServiceContext(pool, input.businessId, input.serviceId);
  const gapMs = rules.gapMin * 60_000;

  const first = DateTime.fromISO(input.fromDate, { zone: tz }).startOf("day");
  const last = DateTime.fromISO(input.toDate, { zone: tz }).startOf("day");
  if (!first.isValid || !last.isValid || last < first) throw new BookingError("NOT_FOUND", "Invalid date range");
  if (last.diff(first, "days").days >= MAX_RANGE_DAYS) throw new BookingError("NOT_FOUND", "Date range too long");

  const earliest = now.getTime() + rules.minLeadMin * 60_000;
  const latest = now.getTime() + rules.horizonDays * 86_400_000;
  const window: Range = { start: first.toMillis(), end: last.plus({ days: 1 }).toMillis() };

  const staffIds = await eligibleStaffIds(pool, input.businessId, input.serviceId, input.zoneId);
  if (staffIds.length === 0) return [];

  const [hoursRes, offRes, bookedRes] = await Promise.all([
    pool.query(
      "SELECT staff_id, weekday, start_local::text AS s, end_local::text AS e FROM working_hours WHERE staff_id = ANY($1)",
      [staffIds],
    ),
    pool.query(
      `SELECT staff_id, lower(during) AS s, upper(during) AS e FROM days_off
        WHERE business_id = $1 AND (staff_id IS NULL OR staff_id = ANY($2))
          AND during && tstzrange($3, $4, '[)')`,
      [input.businessId, staffIds, new Date(window.start), new Date(window.end)],
    ),
    pool.query(
      `SELECT staff_id, starts_at, lower(blocked) AS s, upper(blocked) AS e FROM bookings
        WHERE business_id = $1 AND staff_id = ANY($2) AND status = 'confirmed'
          AND blocked && tstzrange($3, $4, '[)')
          AND ($5::uuid IS NULL OR id <> $5)`,
      [input.businessId, staffIds, new Date(window.start - 86_400_000), new Date(window.end + 86_400_000), input.ignoreBookingId ?? null],
    ),
  ]);

  const toMs = (d: Date | null, open: number) => (d ? d.getTime() : open);
  const hoursByStaff = new Map<string, { weekday: number; start: string; end: string }[]>();
  for (const r of hoursRes.rows) {
    const list = hoursByStaff.get(r.staff_id) ?? [];
    list.push({ weekday: r.weekday, start: r.s, end: r.e });
    hoursByStaff.set(r.staff_id, list);
  }
  const offFor = (id: string): Range[] =>
    offRes.rows
      .filter((r) => r.staff_id === null || r.staff_id === id)
      .map((r) => ({ start: toMs(r.s, -Infinity), end: toMs(r.e, Infinity) }));
  const bookedFor = (id: string): Range[] =>
    bookedRes.rows.filter((r) => r.staff_id === id).map((r) => ({ start: r.s.getTime(), end: r.e.getTime() }));
  const bookingsOnDay = (id: string, localDate: string) =>
    bookedRes.rows.filter(
      (r) => r.staff_id === id && DateTime.fromJSDate(r.starts_at, { zone: tz }).toISODate() === localDate,
    ).length;

  // start time (epoch ms) -> best staff member for that time
  const best = new Map<number, { slot: Slot; load: number; order: number }>();

  staffIds.forEach((staffId, order) => {
    const off = offFor(staffId);
    const booked = bookedFor(staffId);
    const hours = hoursByStaff.get(staffId) ?? [];

    for (let day = first; day <= last; day = day.plus({ days: 1 })) {
      const localDate = day.toISODate()!;
      const weekday = day.weekday % 7; // Luxon: Mon=1 … Sun=7  ->  0 = Sunday … 6 = Saturday
      const dayMs = day.toMillis();
      let load: number | undefined;

      for (const h of hours.filter((x) => x.weekday === weekday)) {
        const [sh, sm] = h.start.split(":").map(Number) as [number, number];
        const [eh, em] = h.end.split(":").map(Number) as [number, number];
        const endMin = eh * 60 + em;
        const stepMin = rules.slotStepMin;

        for (let m = Math.ceil((sh * 60 + sm) / stepMin) * stepMin; m * 60_000 + durationMs <= endMin * 60_000; m += stepMin) {
          const startMs = dayMs + m * 60_000; // same as day.plus({ minutes: m }), without Luxon's per-call zone cost
          if (startMs < earliest || startMs > latest) continue;

          const visit: Range = { start: startMs, end: startMs + durationMs };
          const blocked: Range = { start: startMs, end: startMs + durationMs + gapMs };
          if (off.some((o) => overlaps(visit, o))) continue;
          if (booked.some((b) => overlaps(blocked, b))) continue;

          load ??= bookingsOnDay(staffId, localDate);
          const current = best.get(startMs);
          if (current && (current.load < load || (current.load === load && current.order < order))) continue;

          const startLocal = DateTime.fromMillis(startMs, { zone: tz });
          best.set(startMs, {
            load,
            order,
            slot: {
              startsAt: new Date(startMs),
              endsAt: new Date(startMs + durationMs),
              staffId,
              localDate,
              localTime: startLocal.toFormat("HH:mm"),
              partOfDay: partOfDay(startLocal.hour),
            },
          });
        }
      }
    }
  });

  return [...best.values()].map((b) => b.slot).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Picks up to `limit` slots to show a customer: the earliest, then different parts of the day / different days
 * first, so three options are not three back-to-back times. Result is in time order.
 */
export function pickSpread(slots: Slot[], limit: number): Slot[] {
  const chosen: Slot[] = [];
  const seen = new Set<string>();
  for (const s of slots) {
    if (chosen.length >= limit) break;
    const key = `${s.localDate}/${s.partOfDay}`;
    if (!seen.has(key)) {
      seen.add(key);
      chosen.push(s);
    }
  }
  for (const s of slots) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(s)) chosen.push(s);
  }
  return chosen.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * The `limit` slots closest to what the customer asked for: the same day first (nearest in time), then the
 * following days in order. Result is in time order.
 */
export function nearestSlots(slots: Slot[], requestedMs: number, localDate: string, limit: number): Slot[] {
  const sameDay = slots
    .filter((s) => s.localDate === localDate)
    .sort((a, b) => Math.abs(a.startsAt.getTime() - requestedMs) - Math.abs(b.startsAt.getTime() - requestedMs));
  const later = slots.filter((s) => s.localDate !== localDate); // already in time order
  return [...sameDay, ...later].slice(0, limit).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
