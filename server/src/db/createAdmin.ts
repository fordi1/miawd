import { randomBytes } from "node:crypto";
import pg from "pg";
import { createAdmin, setAdminPassword } from "../auth/admins.js";

// Usage:
//   create-admin <username>            create an admin (password generated and shown once)
//   create-admin <username> --reset    set a new password for an existing admin (and log it out everywhere)
// To choose the password yourself, set ADMIN_PASSWORD in the environment for this one command.
const username = process.argv[2];
const reset = process.argv.includes("--reset");
const url = process.env.DATABASE_URL;
if (!username || username.startsWith("--") || !url) {
  console.error("Usage: create-admin <username> [--reset]   (DATABASE_URL must be set, see server/.env.example)");
  process.exit(1);
}

const chosen = process.env.ADMIN_PASSWORD;
const password = chosen ?? randomBytes(15).toString("base64url");
if (password.length < 10) {
  console.error("The password must be at least 10 characters.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
try {
  if (reset) {
    if (!(await setAdminPassword(pool, username, password))) throw new Error(`there is no admin called "${username}"`);
    console.log(`New password set for admin "${username.toLowerCase()}".`);
  } else {
    await createAdmin(pool, username, password);
    console.log(`Admin "${username.toLowerCase()}" created.`);
  }
  if (!chosen) console.log(`Password (shown only now - save it somewhere safe): ${password}`);
} catch (err) {
  console.error(`Could not ${reset ? "reset" : "create"} the admin: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
