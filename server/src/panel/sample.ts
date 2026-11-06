import type pg from "pg";
import { DEFAULT_HOURS } from "../catalog/catalog.js";

const SERVICES: { name_ar: string; name_en: string; aliases: string[]; duration_min: number }[] = [
  { name_ar: "صيانة ثلاجة", name_en: "Fridge repair", aliases: ["ثلاجة", "براد"], duration_min: 60 },
  { name_ar: "صيانة غسالة", name_en: "Washing machine repair", aliases: ["غسالة"], duration_min: 60 },
  { name_ar: "صيانة مكيف", name_en: "AC repair", aliases: ["مكيف", "تكييف"], duration_min: 90 },
  { name_ar: "صيانة فرن", name_en: "Oven repair", aliases: ["فرن", "طباخ"], duration_min: 60 },
  { name_ar: "صيانة جلاية", name_en: "Dishwasher repair", aliases: ["جلاية"], duration_min: 60 },
];

const ZONES: { name_ar: string; name_en: string; aliases: string[]; fee: number }[] = [
  { name_ar: "الهاشمي الشمالي", name_en: "Hashmi Shamali", aliases: ["هاشمي"], fee: 10 },
  { name_ar: "جبل عمان", name_en: "Jabal Amman", aliases: [], fee: 10 },
  { name_ar: "عبدون", name_en: "Abdoun", aliases: [], fee: 12 },
  { name_ar: "طبربور", name_en: "Tabarbour", aliases: [], fee: 8 },
  { name_ar: "خلدا", name_en: "Khalda", aliases: [], fee: 12 },
  { name_ar: "صويلح", name_en: "Sweileh", aliases: [], fee: 10 },
  { name_ar: "ماركا", name_en: "Marka", aliases: [], fee: 8 },
  { name_ar: "تلاع العلي", name_en: "Tla' Al-Ali", aliases: [], fee: 12 },
];

const STAFF = [
  { name_ar: "محمود العلي", name_en: "Mahmoud Al-Ali", color: "#4466F2" },
  { name_ar: "سامر حداد", name_en: "Samer Haddad", color: "#22C77A" },
  { name_ar: "خالد الزعبي", name_en: "Khaled Al-Zoubi", color: "#8B6CF6" },
];

/**
 * Fills a test business with sample data: 5 appliance-repair services, 8 Amman zones (when the business goes to its
 * customers), and 3 technicians who do everything, cover every zone and work the default week. Call it inside a transaction.
 */
export async function seedSampleData(client: pg.PoolClient, businessId: string, goesToCustomer: boolean): Promise<void> {
  const serviceIds: string[] = [];
  for (const s of SERVICES) {
    const { rows: [r] } = await client.query(
      "INSERT INTO services (business_id, name_ar, name_en, aliases, duration_min) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [businessId, s.name_ar, s.name_en, s.aliases, s.duration_min],
    );
    serviceIds.push(r.id);
  }
  const zoneIds: string[] = [];
  if (goesToCustomer) {
    for (const z of ZONES) {
      const { rows: [r] } = await client.query(
        "INSERT INTO zones (business_id, name_ar, name_en, aliases, visit_fee_jod) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [businessId, z.name_ar, z.name_en, z.aliases, z.fee],
      );
      zoneIds.push(r.id);
    }
  }
  for (const p of STAFF) {
    const { rows: [r] } = await client.query(
      "INSERT INTO staff (business_id, name_ar, name_en, color) VALUES ($1, $2, $3, $4) RETURNING id",
      [businessId, p.name_ar, p.name_en, p.color],
    );
    await client.query("INSERT INTO staff_services (staff_id, service_id) SELECT $1, unnest($2::uuid[])", [r.id, serviceIds]);
    if (zoneIds.length) await client.query("INSERT INTO staff_zones (staff_id, zone_id) SELECT $1, unnest($2::uuid[])", [r.id, zoneIds]);
    await client.query(
      "INSERT INTO working_hours (staff_id, weekday, start_local, end_local) SELECT $1, * FROM unnest($2::smallint[], $3::time[], $4::time[])",
      [r.id, DEFAULT_HOURS.map((h) => h.weekday), DEFAULT_HOURS.map((h) => h.start), DEFAULT_HOURS.map((h) => h.end)],
    );
  }
}
