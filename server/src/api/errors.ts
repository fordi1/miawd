export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "ZONE_NOT_FOUND"
  | "ZONE_NOT_COVERED"
  | "SERVICE_NOT_FOUND"
  | "SLOT_TAKEN"
  | "SLOT_TOKEN_EXPIRED"
  | "TOO_LATE_TO_CHANGE"
  | "INVALID_TRANSITION"
  | "HAS_UPCOMING_BOOKINGS"
  | "INVALID_PHONE"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_DISABLED"
  | "FORBIDDEN"
  | "PASSWORD_CHANGE_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "RATE_LIMITED"
  | "SERVER_ERROR";

/** SPEC §6.4. `displayAr` is null when the error is for developers, not for the customer. */
export const ERRORS: Record<ErrorCode, { status: number; message: string; displayAr: string | null }> = {
  INVALID_INPUT: { status: 422, message: "Some input is missing or invalid.", displayAr: "في معلومة ناقصة أو مش واضحة، ممكن تعيدها؟" },
  UNAUTHORIZED: { status: 401, message: "Missing or invalid API key.", displayAr: null },
  NOT_FOUND: { status: 404, message: "Not found.", displayAr: "ما لقيت هالحجز." },
  ZONE_NOT_FOUND: { status: 422, message: "Zone not found.", displayAr: "ما لقيت هالمنطقة 🤔 ممكن تكتب اسم الحي؟" },
  ZONE_NOT_COVERED: { status: 422, message: "No staff member covers this zone.", displayAr: "للأسف ما منغطي هالمنطقة حالياً." },
  SERVICE_NOT_FOUND: { status: 422, message: "Service not found.", displayAr: null },
  SLOT_TAKEN: { status: 409, message: "The slot was taken by another booking.", displayAr: "للأسف هالموعد انحجز هلأ 😅" },
  SLOT_TOKEN_EXPIRED: { status: 422, message: "The slot token expired; fetch availability again.", displayAr: "خليني أجيبلك المواعيد الفاضية من جديد." },
  TOO_LATE_TO_CHANGE: { status: 409, message: "Too close to the start time to change through the API.", displayAr: "الموعد قريب كتير وما بنقدر نغيّره هلأ، رح نحوّلك لصاحب المحل." },
  INVALID_TRANSITION: { status: 409, message: "The booking's current status does not allow this.", displayAr: null },
  HAS_UPCOMING_BOOKINGS: { status: 409, message: "It still has upcoming confirmed bookings; move or cancel them first.", displayAr: null },
  INVALID_PHONE: { status: 422, message: "Not a valid Jordanian mobile number.", displayAr: "الرقم مش واضح، ابعته بالشكل 07XXXXXXXX" },
  INVALID_CREDENTIALS: { status: 401, message: "Wrong username or password.", displayAr: null },
  ACCOUNT_DISABLED: { status: 403, message: "This account is switched off.", displayAr: null },
  FORBIDDEN: { status: 403, message: "Not allowed.", displayAr: null },
  PASSWORD_CHANGE_REQUIRED: { status: 403, message: "Change the temporary password first.", displayAr: null },
  IDEMPOTENCY_KEY_REUSED: { status: 422, message: "This Idempotency-Key was already used for a different request.", displayAr: null },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: "A request with this Idempotency-Key is still running; retry in a moment.", displayAr: null },
  RATE_LIMITED: { status: 429, message: "Too many requests.", displayAr: null },
  SERVER_ERROR: { status: 500, message: "Unexpected server error.", displayAr: "صار عنا خلل بسيط، جرّب كمان شوي 🙏" },
};

export interface ApiErrorDetails {
  /** Overrides the default Arabic text (e.g. SLOT_TAKEN with the list of alternatives). */
  displayAr?: string;
  alternatives?: unknown[];
  fields?: { path: string; message: string }[];
  message?: string;
}

export class ApiError extends Error {
  constructor(public readonly code: ErrorCode, public readonly details: ApiErrorDetails = {}) {
    super(details.message ?? ERRORS[code].message);
  }
}
