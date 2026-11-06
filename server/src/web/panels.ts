import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** Only our own scripts may run on the panel pages; fonts are our own; nothing may frame the page. */
const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Basic headers for every answer (API, docs and panels). */
export function addSecurityHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (req, res) => {
    // answers with customer data, keys or sessions must never be kept by a browser or proxy
    if (req.url.startsWith("/v1/") || req.url.startsWith("/panel/")) res.header("cache-control", "no-store");
    res.header("x-content-type-options", "nosniff");
    res.header("x-frame-options", "DENY");
    res.header("referrer-policy", "same-origin");
  });
}

/**
 * Serves the built Admin Panel (/admin) and Business Panel (/app) from `publicDir`. Every panel address answers with
 * index.html, so reloading a page deep inside the app works. Does nothing if the panels were not built (development uses Vite).
 */
export async function registerPanels(app: FastifyInstance, publicDir: string) {
  if (!existsSync(path.join(publicDir, "index.html"))) return;

  await app.register(fastifyStatic, {
    root: publicDir,
    wildcard: false, // serve the files that exist; everything else is handled below or is a 404
    index: false,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const hashed = filePath.replaceAll("\\", "/").includes("/assets/");
      res.setHeader("cache-control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });

  const page = async (_req: unknown, res: import("fastify").FastifyReply) =>
    res.header("content-security-policy", PANEL_CSP).header("cache-control", "no-cache").type("text/html; charset=utf-8").sendFile("index.html");
  for (const url of ["/app", "/app/*", "/admin", "/admin/*"]) app.get(url, page);
  app.get("/", async (_req, res) => res.redirect("/app"));
}
