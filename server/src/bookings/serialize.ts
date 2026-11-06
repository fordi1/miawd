import { DateTime } from "luxon";
import { fullDateAr, timePhraseAr } from "../i18n/arabic.js";
import type { BookingRecord } from "./record.js";

/** The booking as the API shows it (responses and webhooks). */
export function bookingJson(r: BookingRecord, tz: string) {
  const local = DateTime.fromJSDate(r.startsAt, { zone: tz });
  return {
    id: r.id,
    status: r.status,
    start_at: r.startsAt.toISOString(),
    end_at: r.endsAt.toISOString(),
    staff_id: r.staffId,
    service_id: r.serviceId,
    zone_id: r.zoneId,
    customer_name: r.customerName,
    customer_phone: r.customerPhone,
    description: r.description,
    address: r.address,
    external_ref: r.externalRef,
    visit_fee_jod: r.visitFeeJod,
    source: r.source,
    created_at: r.createdAt.toISOString(),
    label_ar: `${fullDateAr(local.toISODate()!)}، ${timePhraseAr(local.hour, local.minute)}`,
  };
}
