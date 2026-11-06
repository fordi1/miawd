import type pg from "pg";
import { enqueueBookingEvent } from "../webhooks/outbox.js";
import { BookingError } from "./createBooking.js";
import { BOOKING_COLUMNS, toRecord, type Actor, type BookingRecord, type BookingStatus } from "./record.js";
import { readRules } from "./rules.js";

export type { Actor, BookingRecord, BookingStatus } from "./record.js";

export interface HistoryEntry {
  action: string;
  by: Actor;
  at: Date;
  data: Record<string, unknown>;
}

const COLUMNS = BOOKING_COLUMNS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCLUSION_VIOLATION = "23P01";

export async function getBooking(pool: pg.Pool, businessId: string, id: string): Promise<BookingRecord | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM bookings WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getHistory(pool: pg.Pool, bookingId: string): Promise<HistoryEntry[]> {
  const { rows } = await pool.query("SELECT action, by, at, data FROM booking_history WHERE booking_id = $1 ORDER BY id", [bookingId]);
  return rows;
}

export interface ListFilters {
  phone?: string; // E.164
  externalRef?: string;
  status?: BookingStatus;
  from?: Date; // inclusive
  to?: Date; // exclusive
  limit: number;
}

export async function listBookings(pool: pg.Pool, businessId: string, f: ListFilters): Promise<BookingRecord[]> {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM bookings
      WHERE business_id = $1
        AND ($2::text IS NULL OR customer_phone = $2)
        AND ($3::text IS NULL OR external_ref = $3)
        AND ($4::booking_status IS NULL OR status = $4)
        AND ($5::timestamptz IS NULL OR starts_at >= $5)
        AND ($6::timestamptz IS NULL OR starts_at < $6)
      ORDER BY starts_at, id
      LIMIT $7`,
    [businessId, f.phone ?? null, f.externalRef ?? null, f.status ?? null, f.from ?? null, f.to ?? null, f.limit],
  );
  return rows.map(toRecord);
}

/** Runs `fn` with the booking row locked, so two simultaneous changes to one booking cannot interleave. */
async function withLockedBooking<T>(
  pool: pg.Pool,
  businessId: string,
  bookingId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (client: pg.PoolClient, row: any) => Promise<T>,
): Promise<T> {
  if (!UUID.test(bookingId)) throw new BookingError("NOT_FOUND", "Booking not found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(
      `SELECT bk.*, s.duration_min, biz.goes_to_customer, biz.settings
         FROM bookings bk
         JOIN services s ON s.id = bk.service_id
         JOIN businesses biz ON biz.id = bk.business_id
        WHERE bk.id = $2 AND bk.business_id = $1
          FOR UPDATE OF bk`,
      [businessId, bookingId],
    );
    if (!row) throw new BookingError("NOT_FOUND", "Booking not found");
    const result = await fn(client, row);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const history = (client: pg.PoolClient, bookingId: string, action: string, by: Actor, data: Record<string, unknown> = {}) =>
  client.query("INSERT INTO booking_history (booking_id, action, by, data) VALUES ($1, $2, $3, $4)", [bookingId, action, by, data]);

/** Through the API a visit that is too close to start (or already started) can no longer be changed. */
function assertChangeable(row: any, enforceAt: Date | undefined) {
  if (!enforceAt) return;
  const { changeCutoffMin } = readRules(row.goes_to_customer, row.settings);
  if (row.starts_at.getTime() - enforceAt.getTime() < changeCutoffMin * 60_000) {
    throw new BookingError("TOO_LATE_TO_CHANGE", "Too close to the start time to change");
  }
}

export interface RescheduleInput {
  businessId: string;
  bookingId: string;
  staffId: string;
  startsAt: Date;
  by: Actor;
  /** Set for API calls: applies the "changes allowed until N minutes before" rule at this moment. */
  enforceCutoffAt?: Date;
}

export function rescheduleBooking(pool: pg.Pool, input: RescheduleInput): Promise<BookingRecord> {
  return withLockedBooking(pool, input.businessId, input.bookingId, async (client, row) => {
    if (row.status !== "confirmed") throw new BookingError("INVALID_TRANSITION", `Booking is ${row.status}`);
    assertChangeable(row, input.enforceCutoffAt);
    if (row.starts_at.getTime() === input.startsAt.getTime() && row.staff_id === input.staffId) return toRecord(row);

    const { gapMin } = readRules(row.goes_to_customer, row.settings);
    const endsAt = new Date(input.startsAt.getTime() + row.duration_min * 60_000);
    const blockedUntil = new Date(endsAt.getTime() + gapMin * 60_000);
    try {
      const { rows: [updated] } = await client.query(
        `UPDATE bookings SET staff_id = $3, starts_at = $4, ends_at = $5, blocked = tstzrange($4, $6, '[)'), updated_at = now()
          WHERE id = $1 AND business_id = $2 RETURNING ${COLUMNS}`,
        [input.bookingId, input.businessId, input.staffId, input.startsAt, endsAt, blockedUntil],
      );
      await history(client, input.bookingId, "rescheduled", input.by, {
        from: { starts_at: row.starts_at, staff_id: row.staff_id },
        to: { starts_at: input.startsAt, staff_id: input.staffId },
      });
      await enqueueBookingEvent(client, {
        type: "booking.updated",
        bookingId: input.bookingId,
        actor: input.by,
        change: "rescheduled",
        previous: { start_at: row.starts_at, staff_id: row.staff_id },
      });
      return toRecord(updated);
    } catch (err) {
      if ((err as { code?: string }).code === EXCLUSION_VIOLATION) {
        throw new BookingError("SLOT_TAKEN", "This staff member already has a booking at that time");
      }
      throw err;
    }
  });
}

export interface CancelInput {
  businessId: string;
  bookingId: string;
  reason?: string | null;
  by: Actor;
  enforceCutoffAt?: Date;
}

/** Cancelling an already cancelled booking is a harmless no-op (`changed: false`). */
export function cancelBooking(pool: pg.Pool, input: CancelInput): Promise<{ booking: BookingRecord; changed: boolean }> {
  return withLockedBooking(pool, input.businessId, input.bookingId, async (client, row) => {
    if (row.status === "cancelled") return { booking: toRecord(row), changed: false };
    if (row.status !== "confirmed") throw new BookingError("INVALID_TRANSITION", `Booking is ${row.status}`);
    assertChangeable(row, input.enforceCutoffAt);

    const { rows: [updated] } = await client.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1 AND business_id = $2 RETURNING ${COLUMNS}`,
      [input.bookingId, input.businessId],
    );
    await history(client, input.bookingId, "cancelled", input.by, { reason: input.reason ?? null });
    await enqueueBookingEvent(client, {
      type: "booking.cancelled",
      bookingId: input.bookingId,
      actor: input.by,
      reason: input.reason ?? null,
    });
    return { booking: toRecord(updated), changed: true };
  });
}

export interface StatusInput {
  businessId: string;
  bookingId: string;
  status: "completed" | "no_show";
  by: Actor;
}

/** confirmed → completed / no_show. Setting the status it already has is a harmless no-op. */
export function setBookingStatus(pool: pg.Pool, input: StatusInput): Promise<BookingRecord> {
  return withLockedBooking(pool, input.businessId, input.bookingId, async (client, row) => {
    if (row.status === input.status) return toRecord(row);
    if (row.status !== "confirmed") throw new BookingError("INVALID_TRANSITION", `Booking is ${row.status}`);

    const { rows: [updated] } = await client.query(
      `UPDATE bookings SET status = $3, updated_at = now() WHERE id = $1 AND business_id = $2 RETURNING ${COLUMNS}`,
      [input.bookingId, input.businessId, input.status],
    );
    await history(client, input.bookingId, "status_changed", input.by, { from: row.status, to: input.status });
    await enqueueBookingEvent(client, { type: "booking.updated", bookingId: input.bookingId, actor: input.by, change: input.status });
    return toRecord(updated);
  });
}

export interface BookingPatch {
  customerName?: string;
  customerPhone?: string; // E.164
  description?: string | null;
  address?: string | null;
  externalRef?: string | null;
}

const PATCH_COLUMNS: Record<keyof BookingPatch, string> = {
  customerName: "customer_name",
  customerPhone: "customer_phone",
  description: "description",
  address: "address",
  externalRef: "external_ref",
};

/** Fixes customer data. A duplicate external_ref surfaces as the raw Postgres error 23505 for the caller to map. */
export function patchBooking(
  pool: pg.Pool,
  input: { businessId: string; bookingId: string; patch: BookingPatch; by: Actor },
): Promise<BookingRecord> {
  return withLockedBooking(pool, input.businessId, input.bookingId, async (client, row) => {
    const current = toRecord(row);
    const changed = (Object.keys(input.patch) as (keyof BookingPatch)[]).filter(
      (k) => input.patch[k] !== undefined && input.patch[k] !== current[k],
    );
    if (changed.length === 0) return current;

    const sets = changed.map((k, i) => `${PATCH_COLUMNS[k]} = $${i + 3}`).join(", ");
    const { rows: [updated] } = await client.query(
      `UPDATE bookings SET ${sets}, updated_at = now() WHERE id = $1 AND business_id = $2 RETURNING ${COLUMNS}`,
      [input.bookingId, input.businessId, ...changed.map((k) => input.patch[k])],
    );
    await history(client, input.bookingId, "updated", input.by, { changed: changed.map((k) => PATCH_COLUMNS[k]) });
    await enqueueBookingEvent(client, { type: "booking.updated", bookingId: input.bookingId, actor: input.by, change: "edited" });
    return toRecord(updated);
  });
}
