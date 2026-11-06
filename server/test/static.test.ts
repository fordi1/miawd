import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BASE, PEPPER, SECRET } from "./fixtures.js";
import { testPool } from "./helpers.js";

const pool = testPool(3);
let app: FastifyInstance;
let bare: FastifyInstance; // no built panels on disk (like development, where Vite serves them)

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mawid-public-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>موعد</title></head><body><div id=\"root\"></div></body></html>");
  writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log('panel');");
  const base = { apiKeyPepper: PEPPER, slotTokenSecret: SECRET, now: () => BASE };
  app = await buildApp(pool, { ...base, publicDir: dir });
  bare = await buildApp(pool, { ...base, publicDir: path.join(dir, "does-not-exist") });
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await pool.end();
});

const get = (url: string, a = app) => a.inject({ method: "GET", url });

describe("serving the panels", () => {
  it("answers every panel address with the app, so reloading a page works", async () => {
    for (const url of ["/app", "/app/", "/app/team", "/admin", "/admin/businesses/3f2c8c60-0000-4000-8000-000000000000", "/admin/login"]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.headers["content-type"], url).toContain("text/html");
      expect(r.body, url).toContain('<div id="root">');
    }
  });

  it("sends / to the business panel", async () => {
    const r = await get("/");
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/app");
  });

  it("serves built files, with long caching for the hashed ones and none for the page", async () => {
    const js = await get("/assets/app-abc123.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.headers["cache-control"]).toContain("immutable");
    expect((await get("/app")).headers["cache-control"]).toBe("no-cache");
    expect((await get("/assets/missing.js")).statusCode).toBe(404);
  });

  it("protects the panel page: no framing, no sniffing, and a content policy that only allows our own scripts", async () => {
    const r = await get("/app/team");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("same-origin");
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain("googleapis");
  });

  it("never lets the app swallow the API: unknown API addresses stay JSON 404s", async () => {
    for (const url of ["/v1/nothing-here", "/panel/nothing-here", "/docs/nothing-here"]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.headers["content-type"], url).toContain("application/json");
      expect(r.json().error.code).toBe("NOT_FOUND");
    }
  });

  it("does nothing special when the panels are not built (development)", async () => {
    expect((await get("/app", bare)).statusCode).toBe(404);
    expect((await get("/", bare)).statusCode).toBe(404);
    expect((await get("/health", bare)).statusCode).toBe(200);
  });

  it("tells browsers never to keep API and panel data", async () => {
    for (const url of ["/v1/business", "/panel/app/me"]) {
      expect((await get(url)).headers["cache-control"], url).toBe("no-store");
    }
  });

  it("puts the basic security headers on API answers too", async () => {
    const r = await get("/health");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });
});
