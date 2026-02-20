import { Pool, PoolClient } from 'pg';
import { config, DB_SCHEMA } from '../config';

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  ...(config.db.ssl && {
    ssl: config.db.rejectUnauthorized ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
  }),
});

/** Run query with schema set for the session (so table names can be unqualified if needed). */
export async function withSchema<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${DB_SCHEMA}`);
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Simple query helper; prefers qualified names like "shopify_return_cancel.help_requests". */
export function query<T = unknown>(text: string, values?: unknown[]): Promise<T[]> {
  return pool.query(text, values).then((r) => r.rows as T[]);
}

/** Get a raw client (caller must set search_path if using unqualified names). */
export function getPool(): Pool {
  return pool;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
