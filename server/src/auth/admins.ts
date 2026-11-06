import type pg from "pg";
import { hashPassword } from "./passwords.js";

/** Creates a platform admin (the owner of the platform). Throws if the username is taken. */
export async function createAdmin(pool: pg.Pool, username: string, password: string, options: { cost?: number } = {}): Promise<void> {
  await pool.query("INSERT INTO admins (username, password_hash) VALUES ($1, $2)", [username.toLowerCase(), await hashPassword(password, options)]);
}

/** Sets a new password for an existing admin and logs them out everywhere. Returns false if there is no such admin. */
export async function setAdminPassword(pool: pg.Pool, username: string, password: string, options: { cost?: number } = {}): Promise<boolean> {
  const name = username.toLowerCase();
  const { rowCount } = await pool.query("UPDATE admins SET password_hash = $2 WHERE username = $1", [name, await hashPassword(password, options)]);
  if ((rowCount ?? 0) > 0) await pool.query("DELETE FROM sessions WHERE admin_id = (SELECT id FROM admins WHERE username = $1)", [name]);
  return (rowCount ?? 0) > 0;
}
