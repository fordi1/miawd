import pg from "pg";
import { buildApp } from "./app.js";
import { startMaintenance } from "./maintenance.js";
import { startWebhookWorker } from "./webhooks/deliver.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set (see server/.env.example)`);
    process.exit(1);
  }
  return v;
}

// Local development only: let webhook URLs be http and point to this machine.
const allowLocal = process.env.WEBHOOKS_ALLOW_LOCAL === "true";

const pool = new pg.Pool({ connectionString: need("DATABASE_URL") });
const app = await buildApp(pool, {
  apiKeyPepper: need("API_KEY_PEPPER"),
  slotTokenSecret: need("SLOT_TOKEN_SECRET"),
  webhookAllowLocal: allowLocal,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  trustProxy: process.env.TRUST_PROXY === "true",
  publicUrl: process.env.PUBLIC_URL || undefined,
  logger: true,
});
const worker = startWebhookWorker(pool, { allowLocal });
const maintenance = startMaintenance(pool);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

async function shutdown() {
  maintenance.stop();
  await worker.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
