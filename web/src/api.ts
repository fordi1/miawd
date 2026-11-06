/** Talks to the server's /panel API. Cookies carry the session; answers use the standard envelope. */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: { path: string; message: string }[] = [],
    public readonly alternatives: unknown[] = [],
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined | null>;

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const qs = query
    ? "?" + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString()
    : "";
  let res: Response;
  try {
    res = await fetch(path + (qs === "?" ? "" : qs), {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "network error");
  }
  let json: { ok?: boolean; data?: T; error?: { code: string; message: string; fields?: { path: string; message: string }[]; alternatives?: unknown[] } } | null = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  if (!res.ok || !json || json.ok === false) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? "SERVER_ERROR", e?.message ?? res.statusText, e?.fields, e?.alternatives);
  }
  return json.data as T;
}

export const api = {
  get: <T,>(path: string, query?: Query) => request<T>("GET", path, undefined, query),
  post: <T,>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T,>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T,>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T,>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

// ---- shapes the screens use ----------------------------------------------------------------------------------
export interface Me {
  name: string;
  username: string;
  must_change_password: boolean;
  by_admin: boolean;
  goes_to_customer: boolean;
  staff_label_ar: string;
  staff_label_en: string;
  timezone: string;
}
export interface Staff {
  id: string; name_ar: string; name_en: string | null; phone: string | null; color: string; active: boolean;
  service_ids: string[]; zone_ids: string[]; hours: { weekday: number; start: string; end: string }[];
}
export interface Service { id: string; name_ar: string; name_en: string | null; aliases: string[]; duration_min: number; active: boolean }
export interface Zone { id: string; name_ar: string; name_en: string | null; aliases: string[]; visit_fee_jod: string | null; active: boolean }
export interface DayOff { id: string; staff_id: string | null; start_at: string; end_at: string; reason: string | null }
export type BookingStatus = "confirmed" | "completed" | "cancelled" | "no_show";
export interface Booking {
  id: string; status: BookingStatus; start_at: string; end_at: string; staff_id: string; service_id: string; zone_id: string | null;
  customer_name: string; customer_phone: string; description: string | null; address: string | null; external_ref: string | null;
  visit_fee_jod: string | null; source: "api" | "panel"; created_at: string; label_ar: string;
  service_name_ar?: string; service_name_en?: string | null; zone_name_ar?: string | null; staff_name_ar?: string;
}
export interface HistoryEntry { action: string; by: "api" | "business" | "admin"; at: string; data: Record<string, unknown> }
export interface Calendar {
  timezone: string; from: string; to: string; staff: Staff[]; services: Service[]; zones: Zone[]; bookings: Booking[]; days_off: DayOff[];
}
export interface Slot {
  start_at: string; end_at: string; local_date: string; local_time: string; part_of_day: string; staff_id: string;
  staff_name_ar: string | null; staff_name_en: string | null;
}
export interface BusinessInfo {
  name: string; timezone: string; goes_to_customer: boolean; staff_label_ar: string; staff_label_en: string;
  settings: { slot_step_min: number; gap_min: number; min_lead_min: number; horizon_days: number; change_cutoff_min: number; display_digits: "latin" | "arabic" };
}
export interface AdminBusiness {
  id: string; name: string; username: string; active: boolean; is_test: boolean; goes_to_customer: boolean; staff_label_ar: string; staff_label_en: string;
  timezone: string; must_change_password: boolean; api_key_last4: string | null; webhook_url: string | null; webhook_secret: string | null; created_at: string;
  total: number; confirmed: number; cancelled: number; completed: number; no_show: number;
}
