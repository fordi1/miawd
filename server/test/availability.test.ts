import { afterAll, describe, expect, it } from "vitest";
import { findSlots, pickSpread } from "../src/availability/findSlots.js";
import { createBooking } from "../src/bookings/createBooking.js";
import { addService, addStaff, addZone, seedBusiness, setDefaultHours, testPool } from "./helpers.js";

const pool = testPool(10);
afterAll(() => pool.end());

// Sunday 1 Nov 2026, 03:00 Amman. Dates used below: Sun 8 Nov … Thu 12 Nov; Fri 6 Nov and Sat 7 Nov are the weekend.
const NOW = new Date("2026-11-01T00:00:00Z");
const customer = { customerName: "سامر", customerPhone: "+962795550100" };

async function business(opts?: Parameters<typeof seedBusiness>[1]) {
  const ids = await seedBusiness(pool, opts);
  await setDefaultHours(pool, ids.staffId);
  return ids;
}
const times = (slots: { localTime: string }[]) => slots.map((s) => s.localTime);

describe("findSlots", () => {
  it("offers 09:00–17:00 on a free working day, in Amman time (UTC+3)", async () => {
    const ids = await business();
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });

    expect(times(slots)[0]).toBe("09:00");
    expect(times(slots).at(-1)).toBe("17:00"); // a 60-min visit must end by 18:00
    expect(slots).toHaveLength(17); // every 30 min from 09:00 to 17:00
    expect(slots[0]!.startsAt.toISOString()).toBe("2026-11-08T06:00:00.000Z");
    expect(slots[0]!.endsAt.toISOString()).toBe("2026-11-08T07:00:00.000Z");
  });

  it("works Saturday–Thursday and skips Friday", async () => {
    const ids = await business();
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-05", toDate: "2026-11-07", now: NOW });
    expect([...new Set(slots.map((s) => s.localDate))]).toEqual(["2026-11-05", "2026-11-07"]);
  });

  it("removes times blocked by an existing booking plus the travel gap", async () => {
    const ids = await business({ gapMin: 30 });
    await createBooking(pool, { ...ids, startsAt: new Date("2026-11-08T07:00:00Z"), ...customer, source: "api" }); // 10:00–11:00
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });

    // blocked until 11:30; 09:00 is out too because its own gap would run into the 10:00 booking
    expect(times(slots)[0]).toBe("11:30");
    expect(times(slots).at(-1)).toBe("17:00");
    expect(times(slots)).not.toContain("09:00");
    expect(times(slots)).not.toContain("11:00");
  });

  it("does not offer a slot when the whole business has a day off", async () => {
    const ids = await business();
    await pool.query(
      "INSERT INTO days_off (business_id, during, reason) VALUES ($1, tstzrange($2, $3, '[)'), 'عيد')",
      [ids.businessId, "2026-11-08T21:00:00Z", "2026-11-09T21:00:00Z"], // all of Mon 9 Nov, Amman time
    );
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-10", now: NOW });
    expect([...new Set(slots.map((s) => s.localDate))]).toEqual(["2026-11-08", "2026-11-10"]);
  });

  it("respects the earliest-booking lead time (2 h by default)", async () => {
    const ids = await business();
    const now = new Date("2026-11-08T05:00:00Z"); // 08:00 Amman on the same day
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-08", now });
    expect(times(slots)[0]).toBe("10:00");
  });

  it("does not offer anything beyond the 14-day horizon", async () => {
    const ids = await business();
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-20", toDate: "2026-11-22", now: NOW });
    expect(slots).toEqual([]);
  });

  it("returns one slot per time and gives it to the staff member with fewer bookings that day", async () => {
    const ids = await business();
    const second = await addStaff(pool, ids.businessId, "سامر", [ids.serviceId]);
    await setDefaultHours(pool, second);
    await createBooking(pool, { ...ids, startsAt: new Date("2026-11-08T07:00:00Z"), ...customer, source: "api" }); // first staff, 10:00

    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });
    expect(new Set(times(slots)).size).toBe(slots.length);
    const at14 = slots.find((s) => s.localTime === "14:00")!;
    expect(at14.staffId).toBe(second);
    const at10 = slots.find((s) => s.localTime === "10:00")!; // first staff is busy, only the second is free
    expect(at10.staffId).toBe(second);
  });

  it("ignores staff who do not do the service, and staff who do not cover the zone", async () => {
    const ids = await business();
    const other = await addService(pool, ids.businessId, "صيانة غسالة", 60);
    expect(await findSlots(pool, { ...ids, serviceId: other, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW })).toEqual([]);

    const hashmi = await addZone(pool, ids.businessId, "الهاشمي الشمالي", [ids.staffId]);
    const abdoun = await addZone(pool, ids.businessId, "عبدون", []);
    const covered = await findSlots(pool, { ...ids, zoneId: hashmi, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });
    const notCovered = await findSlots(pool, { ...ids, zoneId: abdoun, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });
    expect(covered.length).toBeGreaterThan(0);
    expect(notCovered).toEqual([]);
  });

  it("every offered slot can really be booked, until the day is full", async () => {
    const ids = await business({ gapMin: 30 });
    const booked: string[] = [];
    for (let i = 0; i < 20; i++) {
      const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });
      if (slots.length === 0) break;
      const slot = slots[0]!;
      await createBooking(pool, { ...ids, staffId: slot.staffId, startsAt: slot.startsAt, ...customer, source: "api" }); // must never throw SLOT_TAKEN
      booked.push(slot.localTime);
    }
    expect(booked).toEqual(["09:00", "10:30", "12:00", "13:30", "15:00", "16:30"]);
  });
});

describe("pickSpread", () => {
  it("offers different parts of the day instead of three back-to-back times", async () => {
    const ids = await business();
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });
    expect(times(pickSpread(slots, 3))).toEqual(["09:00", "12:00", "14:00"]);
  });

  it("fills up with the earliest remaining slots when there are fewer parts than the limit", async () => {
    const ids = await business();
    const slots = await findSlots(pool, { ...ids, fromDate: "2026-11-08", toDate: "2026-11-08", now: NOW });
    const afternoonOnly = slots.filter((s) => s.partOfDay === "afternoon");
    expect(times(pickSpread(afternoonOnly, 3))).toEqual(["14:00", "14:30", "15:00"]);
  });
});
