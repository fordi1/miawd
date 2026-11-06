import type pg from "pg";
import { enqueueBookingEvent } from "../webhooks/outbox.js";
import type { Actor } from "./record.js";
import { readRules } from "./rules.js";

export type BookingErrorCode = "SLOT_TAKEN" | "NOT_FOUND" | "TOO_LATE_TO_CHANGE" | "INVALID_TRANSITION";

export class BookingError extends Error {
  constructor(public readonly code: BookingErrorCode, message: string) {
    super(message);
  }
}

export interface CreateBookingInput {
  businessId: string;
  staffId: string;
  serviceId: string;
  zoneId?: string | null;
  startsAt: Date;
  customerName: string;
  customerPhone: string; // already normalized to E.164
  address?: string | null;
  description?: string | null;
  externalRef?: string | null;
  source: "api" | "panel";
  /** Who is doing it; defaults to the API for source "api" and to the business for the panel. */
  actor?: Actor;
}

export interface Booking {
  id: string;
  businessId: string;
  staffId: string;
  zoneId: string | null;
  /** Snapshot of the zone's visit fee ("10.000"), if any. */
  visitFeeJod: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
}

const EXCLUSION_VIOLATION = "23P01"; // Postgres error code raised by bookings_no_overlap

/**
 * Inserts a confirmed booking. Overlap with another confirmed booking of the same staff member
 * (including the travel gap) is rejected by the database itself, so this is safe under concurrency.
 */
export async function createBooking(pool: pg.Pool, input: CreateBookingInput): Promise<Booking> {
  const client = await pool.connect();
  try {
    const actor: Actor = input.actor ?? (input.source === "api" ? "api" : "business");
    await client.query("BEGIN");
    const { rows: [ctx] } = await client.query(
      `SELECT s.duration_min, b.goes_to_customer, b.settings, z.visit_fee_jod
         FROM services s
         JOIN businesses b ON b.id = s.business_id
         JOIN staff st ON st.business_id = b.id AND st.id = $3
         LEFT JOIN zones z ON z.business_id = b.id AND z.id = $4
        WHERE s.id = $2 AND b.id = $1`,
      [input.businessId, input.serviceId, input.staffId, input.zoneId ?? null],
    );
    if (!ctx) throw new BookingError("NOT_FOUND", "Business, service or staff member not found");

    const { gapMin } = readRules(ctx.goes_to_customer, ctx.settings);
    const endsAt = new Date(input.startsAt.getTime() + ctx.duration_min * 60_000);
    const blockedUntil = new Date(endsAt.getTime() + gapMin * 60_000);

    const { rows: [row] } = await client.query(
      `INSERT INTO bookings (business_id, staff_id, service_id, zone_id, starts_at, ends_at, blocked,
                             customer_name, customer_phone, address, description, external_ref, visit_fee_jod, source)
       VALUES ($1, $2, $3, $4, $5, $6, tstzrange($5, $7, '[)'), $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, status`,
      [input.businessId, input.staffId, input.serviceId, input.zoneId ?? null, input.startsAt, endsAt, blockedUntil,
       input.customerName, input.customerPhone, input.address ?? null, input.description ?? null,
       input.externalRef ?? null, ctx.visit_fee_jod, input.source],
    );
    await client.query(
      "INSERT INTO booking_history (booking_id, action, by) VALUES ($1, 'created', $2)",
      [row.id, actor],
    );
    await enqueueBookingEvent(client, { type: "booking.created", bookingId: row.id, actor });
    await client.query("COMMIT");
    return {
      id: row.id,
      businessId: input.businessId,
      staffId: input.staffId,
      zoneId: input.zoneId ?? null,
      visitFeeJod: ctx.visit_fee_jod,
      startsAt: input.startsAt,
      endsAt,
      status: row.status,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === EXCLUSION_VIOLATION) {
      throw new BookingError("SLOT_TAKEN", "This staff member already has a booking at that time");
    }
    throw err;
  } finally {
    client.release();
  }
}
