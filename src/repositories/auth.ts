import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getPool } from '../db/client';
import { DB_SCHEMA } from '../config';

const SCHEMA = DB_SCHEMA;
const USERS = `${SCHEMA}.admin_users`;
const TOKENS = `${SCHEMA}.refresh_tokens`;

export interface AdminUserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SALT_ROUNDS = 10;

export async function findAdminByEmail(email: string): Promise<AdminUserRow | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM ${USERS} WHERE email = $1 AND is_active = true`,
    [email.trim().toLowerCase()]
  );
  return (result.rows[0] as AdminUserRow) || null;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createRefreshToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ${TOKENS} (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
}

export async function findRefreshToken(
  tokenHash: string
): Promise<{ user_id: string; email: string } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT rt.user_id, u.email FROM ${TOKENS} rt
     JOIN ${USERS} u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
    [tokenHash]
  );
  const row = result.rows[0] as { user_id: string; email: string } | undefined;
  return row || null;
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE ${TOKENS} SET revoked_at = now() WHERE token_hash = $1`,
    [tokenHash]
  );
}

export async function createAdminUser(params: {
  email: string;
  password: string;
  name?: string;
}): Promise<AdminUserRow> {
  const pool = getPool();
  const hash = await hashPassword(params.password);
  const result = await pool.query(
    `INSERT INTO ${USERS} (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *`,
    [params.email.trim().toLowerCase(), hash, params.name?.trim() || null]
  );
  return result.rows[0] as AdminUserRow;
}
