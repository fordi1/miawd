import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { ApiError } from "./errors.js";

export interface HandlerResult {
  status: number;
  body: unknown;
}

const KEY_TTL = "24 hours"; // a key older than this is forgotten
const STALE_AFTER = "60 seconds"; // a request that never finished (server crash) is taken over after this

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Makes a POST safe to retry. Without an `Idempotency-Key` header it just runs the handler.
 * With one: the first successful result is stored and returned again for the same key + same request;
 * the same key with a different request is refused; failures are not remembered (fix the request and retry).
 *
 * Known limit: if the server dies between creating the booking and saving the result, a retry within
 * 60 seconds gets IDEMPOTENCY_IN_PROGRESS and afterwards runs again (and then gets SLOT_TAKEN).
 */
export async function withIdempotency(
  pool: pg.Pool,
  req: FastifyRequest,
  res: FastifyReply,
  run: () => Promise<HandlerResult>,
) {
  const header = req.headers["idempotency-key"];
  if (header === undefined) {
    const r = await run();
    return res.status(r.status).send(r.body);
  }
  const key = typeof header === "string" ? header.trim() : "";
  if (!key || key.length > 255) {
    throw new ApiError("INVALID_INPUT", { fields: [{ path: "Idempotency-Key", message: "must be 1–255 characters" }] });
  }

  const businessId = req.business!.id;
  const hash = createHash("sha256")
    .update(`${req.method} ${req.url.split("?")[0]} ${stableStringify(req.body ?? null)}`)
    .digest("hex");

  const claim = async () =>
    ((await pool.query(
      "INSERT INTO idempotency_keys (business_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [businessId, key, hash],
    )).rowCount ?? 0) === 1;
  const release = () =>
    pool.query("DELETE FROM idempotency_keys WHERE business_id = $1 AND key = $2", [businessId, key]).catch(() => undefined);

  let owned = await claim();
  if (!owned) {
    const { rows: [row] } = await pool.query(
      `SELECT request_hash, status_code, response,
              created_at < now() - interval '${KEY_TTL}' AS expired,
              (response IS NULL AND created_at < now() - interval '${STALE_AFTER}') AS stale
         FROM idempotency_keys WHERE business_id = $1 AND key = $2`,
      [businessId, key],
    );
    if (!row) {
      owned = await claim(); // it was released a moment ago
    } else if (row.expired || row.stale) {
      await release();
      owned = await claim();
    } else if (row.response === null) {
      throw new ApiError("IDEMPOTENCY_IN_PROGRESS");
    } else if (row.request_hash !== hash) {
      throw new ApiError("IDEMPOTENCY_KEY_REUSED");
    } else {
      return res.header("idempotent-replayed", "true").status(row.status_code).send(row.response);
    }
    if (!owned) throw new ApiError("IDEMPOTENCY_IN_PROGRESS"); // lost a race for the same key
  }

  let result: HandlerResult;
  try {
    result = await run();
  } catch (err) {
    await release();
    throw err;
  }
  if (result.status < 300) {
    await pool.query(
      "UPDATE idempotency_keys SET status_code = $3, response = $4::jsonb WHERE business_id = $1 AND key = $2",
      [businessId, key, result.status, JSON.stringify(result.body)],
    );
  } else {
    await release();
  }
  return res.status(result.status).send(result.body);
}
