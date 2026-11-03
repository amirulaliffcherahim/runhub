import { randomBytes } from "node:crypto";
import { openDb } from "../db.mjs";

/**
 * Postgres test harness. Each call creates a throwaway schema on the configured
 * server, so tests use the real database engine without touching real data.
 * `TEST_DATABASE_URL` overrides `DATABASE_URL`.
 */
export async function tempDb() {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const db = await openDb({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL, schema });
  return {
    db,
    schema,
    async cleanup() {
      await db.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.close();
    },
  };
}

/** Skip the whole file when no Postgres is reachable, instead of failing every test. */
export async function pgAvailable() {
  try {
    const { db, cleanup } = await tempDb();
    await cleanup();
    return true;
  } catch {
    return false;
  }
}
