export interface BookingRules {
  /** Travel / clean-up gap kept free after every booking. */
  gapMin: number;
  /** Candidate start times are multiples of this many minutes (local clock). */
  slotStepMin: number;
  /** Earliest bookable time = now + this lead. */
  minLeadMin: number;
  /** Furthest bookable time = now + this many days. */
  horizonDays: number;
  /** Through the API a booking can be moved or cancelled until this many minutes before it starts. */
  changeCutoffMin: number;
}

/** Reads a business's settings (SPEC §3.1), falling back to the defaults for anything missing or invalid. */
export function readRules(goesToCustomer: boolean, settings: Record<string, unknown> | null): BookingRules {
  const s = settings ?? {};
  const num = (key: string, fallback: number, min: number) => {
    const v = s[key];
    return typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback;
  };
  return {
    gapMin: num("gap_min", goesToCustomer ? 30 : 0, 0),
    slotStepMin: num("slot_step_min", 30, 5),
    minLeadMin: num("min_lead_min", 120, 0),
    horizonDays: num("horizon_days", 14, 1),
    changeCutoffMin: num("change_cutoff_min", 120, 0),
  };
}
