export type BookingStatus = "confirmed" | "completed" | "cancelled" | "no_show";
/** Who made a change: the integrator through the API, the business in its panel, or the platform admin. */
export type Actor = "api" | "business" | "admin";

export interface BookingRecord {
  id: string;
  businessId: string;
  staffId: string;
  serviceId: string;
  zoneId: string | null;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  customerName: string;
  customerPhone: string;
  address: string | null;
  description: string | null;
  externalRef: string | null;
  visitFeeJod: string | null;
  source: "api" | "panel";
  createdAt: Date;
}

export const BOOKING_COLUMNS = `id, business_id, staff_id, service_id, zone_id, status, starts_at, ends_at, customer_name, customer_phone,
  address, description, external_ref, visit_fee_jod, source, created_at`;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function toRecord(r: any): BookingRecord {
  return {
    id: r.id,
    businessId: r.business_id,
    staffId: r.staff_id,
    serviceId: r.service_id,
    zoneId: r.zone_id,
    status: r.status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    address: r.address,
    description: r.description,
    externalRef: r.external_ref,
    visitFeeJod: r.visit_fee_jod,
    source: r.source,
    createdAt: r.created_at,
  };
}
