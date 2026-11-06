import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { marked } from "marked";
import { buildOpenApi, buildPostman } from "./openapi.js";

const DOCS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
const SCALAR_VERSION = "1.67.0"; // pinned

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const PAGE_CSS = `
:root{--bg:#EEF2F7;--surface:#fff;--primary:#4466F2;--text:#1D2433;--muted:#6B7488;--line:#E4E9F2;--code:#F3F6FB}
@media (prefers-color-scheme:dark){:root{--bg:#0F1420;--surface:#171D2B;--primary:#7C93FF;--text:#E8ECF5;--muted:#9AA3B8;--line:#27304A;--code:#0F1524}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.75 "Vazirmatn",system-ui,sans-serif}
header{background:var(--surface);border-bottom:1px solid var(--line);padding:14px 16px}
nav{max-width:860px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
nav b{margin-inline-end:auto}nav a{color:var(--primary);text-decoration:none;font-weight:600;white-space:nowrap}
main{max-width:860px;margin:18px auto 60px;background:var(--surface);border-radius:16px;padding:20px 22px;box-shadow:0 10px 30px rgba(68,102,242,.10)}
h1,h2,h3{line-height:1.4}h2{margin-top:2em;padding-top:.6em;border-top:1px solid var(--line)}h1{margin-top:0}
a{color:var(--primary)}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;direction:ltr;text-align:left;unicode-bidi:plaintext}
pre{background:var(--code);border-radius:12px;padding:14px 16px;overflow-x:auto;font-size:13.5px;line-height:1.6}
:not(pre)>code{background:var(--code);padding:1px 6px;border-radius:6px;font-size:.9em}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}th,td{border:1px solid var(--line);padding:6px 10px;text-align:start;vertical-align:top}th{background:var(--code)}
blockquote{margin:1em 0;padding:.2em 1em;border-inline-start:4px solid var(--primary);background:var(--code);border-radius:8px}
@media (max-width:600px){main{margin:10px;padding:14px}}
`;

function guidePage(lang: "ar" | "en", markdown: string): string {
  const title = lang === "ar" ? "دليل الربط مع واجهة موعد" : "Mawid API — integration guide";
  const other = lang === "ar" ? `<a href="/docs/guide/en">English</a>` : `<a href="/docs/guide/ar">العربية</a>`;
  return `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700&display=swap" rel="stylesheet">
<style>${PAGE_CSS}</style></head><body>
<header><nav><b>${escapeHtml(title)}</b><a href="/docs">API reference</a><a href="/docs/openapi.json">OpenAPI</a><a href="/docs/postman.json">Postman</a>${other}</nav></header>
<main>${marked.parse(markdown, { async: false })}</main></body></html>`;
}

/** The guides are written with https://YOUR-HOST in them; each page shows the real address of this server instead. */
function loadGuides() {
  const source = {
    ar: readFileSync(path.join(DOCS_DIR, "guide.ar.md"), "utf8"),
    en: readFileSync(path.join(DOCS_DIR, "guide.en.md"), "utf8"),
  };
  const rendered = new Map<string, string>();
  return (lang: "ar" | "en", base: string) => {
    const key = `${lang} ${base}`;
    let html = rendered.get(key);
    if (!html) {
      html = guidePage(lang, source[lang].replaceAll("https://YOUR-HOST", base));
      if (rendered.size < 50) rendered.set(key, html); // a handful of hosts at most; never grows without limit
    }
    return html;
  };
}

export function docsRoutes(opts: { publicUrl?: string }) {
  return async function plugin(app: FastifyInstance) {
    const guides = loadGuides();
    const baseOf = (req: FastifyRequest) => opts.publicUrl ?? `${req.protocol}://${req.hostname}`;

    app.get("/docs", async (_req, res) =>
      res.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mawid Booking API</title></head>
<body><script id="api-reference" data-url="/docs/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}"></script></body></html>`));

    app.get("/docs/openapi.json", async (req) => buildOpenApi(baseOf(req)));
    app.get("/docs/postman.json", async (req, res) =>
      res.header("content-disposition", 'attachment; filename="mawid-api.postman_collection.json"').send(buildPostman(baseOf(req))));
    app.get("/docs/guide/ar", async (req, res) => res.type("text/html; charset=utf-8").send(guides("ar", baseOf(req))));
    app.get("/docs/guide/en", async (req, res) => res.type("text/html; charset=utf-8").send(guides("en", baseOf(req))));
  };
}
