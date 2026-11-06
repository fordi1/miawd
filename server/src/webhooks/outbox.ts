import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type pg from "pg";
import { toRecord, type Actor } from "../bookings/record.js";
import { bookingJson } from "../bookings/serialize.js";
import { applyDigits, fullDateAr, timePhraseAr } from "../i18n/arabic.js";

export type BookingEventType = "booking.created" | "booking.updated" | "booking.cancelled";
export type BookingChange = "rescheduled" | "edited" | "completed" | "no_show";

export interface BookingEventInput {
  type: BookingEventType;
  bookingId: string;
  actor: Actor;
  /** For booking.updated: what happened. */
  change?: BookingChange;
  /** For a reschedule: where the booking used to be. */
  previous?: { start_at: Date; staff_id: string };
  /** For booking.cancelled. */
  reason?: string | null;
}

/**
 * Queues a webhook event for the booking's business, if it has a webhook URL. Call it with the same client (inside the same
 * transaction) as the change itself, so an event exists if and only if the change was saved. Delivery happens later
 * (deliver.ts). The payload is a snapshot of the booking at this moment.
 */
export async function enqueueBookingEvent(client: pg.PoolClient, input: BookingEventInput): Promise<void> {
  const { rows: [r] } = await client.query(
    `SELECT bk.*, biz.webhook_url, biz.timezone, biz.settings, z.name_ar AS zone_name
       FROM bookings bk
       JOIN businesses biz ON biz.id = bk.business_id
       LEFT JOIN zones z ON z.id = bk.zone_id
      WHERE bk.id = $1`,
    [input.bookingId],
  );
  if (!r?.webhook_url) return;

  const booking = toRecord(r);
  const style = r.settings?.display_digits === "arabic" ? "arabic" : "latin";
  const digits = (text: string) => applyDigits(text, style);
  const local = DateTime.fromJSDate(booking.startsAt, { zone: r.timezone });
  const date = fullDateAr(local.toISODate()!);
  const time = timePhraseAr(local.hour, local.minute);

  let displayAr: string | null = null;
  if (input.type === "booking.created") {
    displayAr = `تم تثبيت موعدك ✅ ${date} ${time}. إذا بدك تغيّر أو تلغي احكيلنا هون.`;
  } else if (input.type === "booking.cancelled") {
    displayAr =
      input.actor === "api"
        ? "تم إلغاء موعدك ✅ إذا بدك تحجز موعد جديد احكيلنا."
        : "للأسف اضطرينا نلغي موعدك 🙏 إذا بدك نرتبلك موعد ثاني احكيلنا.";
  } else if (input.change === "rescheduled") {
    displayAr = `تم تغيير موعدك ✅ موعدك الجديد: ${date} ${time}.`;
  } // other updates (edited, completed, no_show) are not messages for the customer

  const id = randomUUID();
  const payload = {
    id: `evt_${id}`,
    type: input.type,
    created_at: new Date().toISOString(),
    actor: input.actor,
    data: {
      booking: bookingJson(booking, r.timezone),
      ...(input.change && { change: input.change }),
      ...(input.previous && { previous: { start_at: input.previous.start_at.toISOString(), staff_id: input.previous.staff_id } }),
      ...(input.type === "booking.cancelled" && { reason: input.reason ?? null }),
      display_ar: displayAr === null ? null : digits(displayAr),
      template: {
        customer_name: booking.customerName,
        date: digits(date),
        time: digits(time),
        zone: r.zone_name ?? null,
      },
    },
  };
  await client.query("INSERT INTO webhook_deliveries (id, business_id, event, payload) VALUES ($1, $2, $3, $4)", [
    id,
    booking.businessId,
    input.type,
    payload,
  ]);
}
