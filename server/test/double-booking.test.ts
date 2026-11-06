import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBooking, BookingError } from "../src/bookings/createBooking.js";
import { seedBusiness, testPool } from "./helpers.js";

const pool = testPool(60);
afterAll(() => pool.end());

const customer = { customerName: "سامر", customerPhone: "+962795550100" };

describe("double-booking protection", () => {
  let ids: Awaited<ReturnType<typeof seedBusiness>>;
  beforeAll(async () => {
    ids = await seedBusiness(pool, { gapMin: 30 });
  });

  it("lets exactly one of 50 simultaneous requests book the same slot", async () => {
    const startsAt = new Date("2026-11-10T07:00:00Z"); // 10:00 Amman
    const attempts = Array.from({ length: 50 }, () =>
      createBooking(pool, { ...ids, startsAt, ...customer, source: "api" }),
    );
    const results = await Promise.allSettled(attempts);

    const ok = results.filter((r) => r.status === "fulfilled");
    const taken = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof BookingError && r.reason.code === "SLOT_TAKEN",
    );
    expect(ok).toHaveLength(1);
    expect(taken).toHaveLength(49);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM bookings WHERE staff_id = $1 AND status = 'confirmed'",
      [ids.staffId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("blocks the travel gap after a booking, then allows the next slot", async () => {
    // 10:00–11:00 is booked above; with a 30-minute gap the staff member is busy until 11:30.
    await expect(
      createBooking(pool, { ...ids, startsAt: new Date("2026-11-10T08:00:00Z"), ...customer, source: "api" }),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" });

    const next = await createBooking(pool, {
      ...ids, startsAt: new Date("2026-11-10T08:30:00Z"), ...customer, source: "api",
    });
    expect(next.endsAt.toISOString()).toBe("2026-11-10T09:30:00.000Z");
  });

  it("frees the slot when a booking is cancelled", async () => {
    const startsAt = new Date("2026-11-11T07:00:00Z");
    const first = await createBooking(pool, { ...ids, startsAt, ...customer, source: "api" });
    await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [first.id]);

    const second = await createBooking(pool, { ...ids, startsAt, ...customer, source: "panel" });
    expect(second.id).not.toBe(first.id);
  });
});
