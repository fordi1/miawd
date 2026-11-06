# Mawid (موعد) — Booking Engine

A multi-tenant **booking calendar service** for appointment-based businesses, controlled by an API.
It was designed for a WhatsApp bot that speaks Jordanian Arabic, so every answer the bot needs comes back
ready to send (`display_ar`), but nothing in the API is specific to WhatsApp.

- **One fixed endpoint, one API key per business.** The key tells the server which business a request is for.
- **Admin Panel** for the platform owner and **Business Panel** for each shop owner (Arabic RTL and English).
- **No double booking**: a time can never be booked twice (enforced by a database constraint).
- **Integration docs included**: API reference, OpenAPI, Postman collection, and guides in Arabic and English.

> Status: **v0.1, first working version.** The scope is intentionally small; see [SPEC.md](SPEC.md) for what is and is not built.

## Contents

- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Security](#security)
- [Testing](#testing)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [License](#license)

## How it works

```
 Integrator (for example a WhatsApp bot)      Booking Engine server
 ┌──────────────────┐  HTTPS + API key        ┌─────────────────────────────────────┐
 │ its own server   │ ──────────────────────▶ │ caddy (HTTPS) ─▶ api (Fastify)      │
 │                  │ ◀────────────────────── │   (also sends webhooks, retries)    │
 └──────────────────┘  signed webhooks        │ postgres 17                         │
                                              │ web: /admin (Admin) · /app (Business)│
                                              │ backup (daily dump)                 │
                                              └─────────────────────────────────────┘
```

Typical flow for a bot: ask for free slots → check a time → create the booking after the customer confirms →
reschedule or cancel later. The business owner sees and edits everything in the Business Panel.
The server can notify the integrator through three signed webhook events: `booking.created`, `booking.updated`, `booking.cancelled`.

| | |
|---|---|
| API | `https://<host>/v1`, key in `Authorization: Bearer …` |
| API reference, guides, OpenAPI, Postman | `/docs` · `/docs/guide/ar` · `/docs/guide/en` · `/docs/openapi.json` · `/docs/postman.json` |
| Admin Panel / Business Panel | `/admin` · `/app` |

Out of scope: sending WhatsApp messages, reminders, payments.

## Tech stack

| Part | Technology |
|---|---|
| API server | Node.js 22+, TypeScript, Fastify 5, Zod, Luxon |
| Database | PostgreSQL 17 |
| Panels | React 18, Vite 6, React Router (Vazirmatn font, Arabic RTL and English) |
| Tests | Vitest |
| Production | Docker Compose, Caddy (automatic HTTPS) |

## Quick start

Needs **Node 22+** and **Docker**.

```bash
cp server/.env.example server/.env                    # then fill in the two secrets (see Configuration)
docker compose --env-file server/.env up -d           # development database on port 54329
cd server && npm install && npm run migrate && npm test
npm run dev                                           # API on http://localhost:3000
cd ../web && npm install && npm run dev               # panels on http://localhost:5174
```

Create the first admin account:

```bash
cd server && npm run create-admin -- <username>
```

## Configuration

Copy `server/.env.example` to `server/.env`. **Never commit `.env` files** (they are git-ignored).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `TEST_DATABASE_URL` | Separate database used by the test suite (created automatically) |
| `API_KEY_PEPPER` | Server-side secret used when hashing API keys |
| `SLOT_TOKEN_SECRET` | Secret used to sign slot tokens |
| `PORT` | HTTP port (default `3000`) |
| `PUBLIC_URL` | The address people reach the API at; shown in the docs |
| `COOKIE_SECURE` | Set `true` behind HTTPS so panel cookies are marked `Secure` |
| `TRUST_PROXY` | Set `true` behind a reverse proxy so the real client IP is used |
| `WEBHOOKS_ALLOW_LOCAL` | **Development only.** Allows http or local webhook URLs. Never set in production |

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For production, copy `deploy/env.production.example` to `.env.production` **on the server** and fill it in the same way.

## Security

- Passwords are hashed with scrypt. API keys are stored hashed with a server-side pepper and shown in full only once.
- Slot tokens are signed; webhooks are signed (the `whsec_` secret follows the Standard Webhooks style).
- Webhook URLs are validated; local and plain-http targets are rejected unless you explicitly enable development mode.
- Secrets never belong in the repository: use `.env` files that are git-ignored, and rotate any secret that was ever shared.
- Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Testing

```bash
cd server
npm run typecheck
npm test            # needs the development database to be running (see Quick start)
```

The suite covers availability, booking rules, double-booking under concurrent requests, Arabic input parsing, webhooks, the panels' API, and rate limiting.

## Deployment

The production stack is `docker-compose.prod.yml` (database, app, Caddy for HTTPS, daily backup).
Step-by-step operation (creating the admin, adding businesses, backups, updates, enabling HTTPS) is in
[deploy/RUNBOOK.md](deploy/RUNBOOK.md) (written in Persian). After every deploy, run the end-to-end check:

```bash
BASE_URL=https://<host> ADMIN_USER=<admin> ADMIN_PASSWORD=<password> node deploy/smoke.mjs
```

## Project structure

```
SPEC.md                    the specification everything is built from
server/                    API and the panels' back end (src/, test/, docs/ with the two integration guides)
web/                       Admin and Business panels (React, Vite)
prototype/                 static UI reference
deploy/                    RUNBOOK.md, Caddyfile, backup.sh, smoke.mjs
docker-compose.yml         development database
docker-compose.prod.yml    production stack
```

## License

Released under the [MIT License](LICENSE).
