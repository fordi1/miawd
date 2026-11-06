import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ERRORS } from "../src/api/errors.js";
import { OPERATIONS, buildOpenApi, buildPostman, documentedRoutes } from "../src/docs/openapi.js";
import { BASE, PEPPER, SECRET } from "./fixtures.js";
import { testPool } from "./helpers.js";

const pool = testPool(3);
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(pool, { apiKeyPepper: PEPPER, slotTokenSecret: SECRET, now: () => BASE, publicUrl: "https://api.mawid.example" });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("the documentation matches the server", () => {
  it("documents exactly the routes the server has under /v1", () => {
    const served = app.registeredRoutes.filter((r) => r.split(" ")[1]!.startsWith("/v1/")).sort();
    expect(documentedRoutes().sort()).toEqual(served);
  });

  it("only documents error codes that exist, and every public one", () => {
    const doc = buildOpenApi() as { components: { schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } } } };
    const documented = doc.components.schemas.Error.properties.error.properties.code.enum;
    const real = Object.keys(ERRORS);
    for (const code of documented) expect(real, code).toContain(code);
    const panelOnly = ["INVALID_CREDENTIALS", "ACCOUNT_DISABLED", "PASSWORD_CHANGE_REQUIRED"]; // the API never answers these
    expect(real.filter((c) => !documented.includes(c)).sort()).toEqual(panelOnly.sort());
  });

  it("gives every operation a unique id, a summary and at least one response", () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of OPERATIONS) {
      expect(op.summary.length, op.operationId).toBeGreaterThan(5);
      expect(Object.keys(op.responses).length, op.operationId).toBeGreaterThan(0);
    }
  });
});

describe("/docs", () => {
  it("serves the OpenAPI 3.1 file with the public URL as the server", async () => {
    const r = await app.inject({ method: "GET", url: "/docs/openapi.json" });
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://api.mawid.example/v1");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/availability", "/availability/check", "/bookings", "/bookings/{id}/reschedule", "/staff/{id}/hours", "/days-off"]));
    expect(Object.keys(doc.webhooks)).toEqual(["booking.created", "booking.updated", "booking.cancelled"]);
    expect(r.body).not.toMatch(/\bbk_(live|test)_[A-Za-z0-9_-]{20,}/); // no real key anywhere
  });

  it("serves a Postman collection with variables and saved tokens", async () => {
    const r = await app.inject({ method: "GET", url: "/docs/postman.json" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toContain("postman_collection.json");
    const c = r.json();
    expect(c.info.schema).toContain("v2.1.0");
    expect(c.variable.map((v: { key: string }) => v.key)).toEqual(["base_url", "api_key", "slot_token", "booking_id"]);
    expect(c.auth.bearer[0].value).toBe("{{api_key}}");
    const items = c.item.flatMap((f: { item: unknown[] }) => f.item) as { name: string; request: { url: { raw: string } }; event?: unknown[] }[];
    expect(items).toHaveLength(OPERATIONS.length);
    expect(items.find((i) => i.name.startsWith("GET /availability —"))!.event).toBeDefined(); // saves {{slot_token}}
    expect(items.every((i) => i.request.url.raw.startsWith("{{base_url}}/v1/"))).toBe(true);
    expect(buildPostman().variable).toBeDefined();
  });

  it("serves the reference page and both guides", async () => {
    const page = await app.inject({ method: "GET", url: "/docs" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain('data-url="/docs/openapi.json"');
    expect(page.body).toContain("@scalar/api-reference@1.67.0"); // pinned

    const en = await app.inject({ method: "GET", url: "/docs/guide/en" });
    expect(en.statusCode).toBe(200);
    expect(en.body).toContain('<html lang="en" dir="ltr">');
    expect(en.body).toContain("integration guide");
    expect(en.body).toContain("<pre>");

    const ar = await app.inject({ method: "GET", url: "/docs/guide/ar" });
    expect(ar.statusCode).toBe(200);
    expect(ar.body).toContain('<html lang="ar" dir="rtl">');
    expect(ar.body).toContain("دليل الربط");
  });

  it("shows this server's own address in the guides, not a placeholder", async () => {
    for (const lang of ["en", "ar"]) {
      const body = (await app.inject({ method: "GET", url: `/docs/guide/${lang}`, headers: { host: "api.example.test" } })).body;
      expect(body, lang).not.toContain("YOUR-HOST");
      expect(body, lang).toContain("/v1");
    }
  });

  it("explains every endpoint and webhook header in both guides", async () => {
    for (const lang of ["en", "ar"]) {
      const body = (await app.inject({ method: "GET", url: `/docs/guide/${lang}` })).body;
      for (const needle of ["/availability/check", "/bookings", "booking_id", "Idempotency-Key", "webhook-signature", "whsec_", "TOO_LATE_TO_CHANGE", "SLOT_TAKEN", "RateLimit", "find_slots", "book_slot"]) {
        expect(body, `${lang}: ${needle}`).toContain(needle);
      }
    }
  });

  it("does not need a login", async () => {
    for (const url of ["/docs", "/docs/openapi.json", "/docs/postman.json", "/docs/guide/en", "/docs/guide/ar"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
  });
});
