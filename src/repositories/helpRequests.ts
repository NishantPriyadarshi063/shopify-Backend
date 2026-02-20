import { getPool } from '../db/client';
import { DB_SCHEMA } from '../config';
import type {
  HelpRequestType,
  HelpRequestStatus,
  HelpRequestCreateBody,
  HelpRequestRow,
  HelpRequestAttachmentRow,
  HelpRequestUpdateBody,
} from '../types/helpRequests';

const SCHEMA = DB_SCHEMA;
const REQUESTS = `${SCHEMA}.help_requests`;
const ATTACHMENTS = `${SCHEMA}.help_request_attachments`;

const OPEN_STATUSES: HelpRequestStatus[] = ['pending', 'in_progress', 'approved'];

/** Check if order_number already has an open request. */
export async function hasOpenRequestForOrder(orderNumber: string): Promise<boolean> {
  const pool = getPool();
  const normalized = orderNumber.replace(/^#/, '').trim();
  const query = `
    SELECT 1 FROM ${REQUESTS}
    WHERE (order_number = $1 OR order_number = $2)
    AND status = ANY($3::varchar[])
    LIMIT 1
  `;
  const rows = await pool.query(query, [normalized, `#${normalized}`, OPEN_STATUSES]);
  return (rows.rowCount ?? 0) > 0;
}

/** Create a new help request. */
export async function create(body: HelpRequestCreateBody): Promise<HelpRequestRow> {
  const pool = getPool();
  const orderNumber = body.order_number.replace(/^#/, '').trim() || body.order_number;
  const query = `
    INSERT INTO ${REQUESTS} (type, customer_email, customer_phone, customer_name, order_number, reason)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  const result = await pool.query(query, [
    body.type,
    body.customer_email.trim(),
    body.customer_phone?.trim() || null,
    body.customer_name.trim(),
    orderNumber,
    body.reason?.trim() || null,
  ]);
  return result.rows[0] as HelpRequestRow;
}

/** List help requests with optional filters (admin). search: ILIKE on order_number or customer_email */
export async function list(filters: {
  type?: HelpRequestType;
  status?: HelpRequestStatus;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<HelpRequestRow[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (filters.type) {
    conditions.push(`type = $${idx++}`);
    values.push(filters.type);
  }
  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    values.push(filters.status);
  }
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(`(order_number ILIKE $${idx} OR customer_email ILIKE $${idx} OR customer_name ILIKE $${idx})`);
    values.push(term);
    idx++;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(filters.limit ?? 50);
  values.push(filters.offset ?? 0);
  const query = `
    SELECT * FROM ${REQUESTS}
    ${where}
    ORDER BY created_at DESC
    LIMIT $${idx++} OFFSET $${idx}
  `;
  const result = await pool.query(query, values);
  return result.rows as HelpRequestRow[];
}

/** Get one help request by id. */
export async function getById(id: string): Promise<HelpRequestRow | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM ${REQUESTS} WHERE id = $1`, [id]);
  return (result.rows[0] as HelpRequestRow) || null;
}

/** Get attachments for a request. */
export async function getAttachmentsByRequestId(
  requestId: string
): Promise<HelpRequestAttachmentRow[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM ${ATTACHMENTS} WHERE request_id = $1 ORDER BY created_at ASC`,
    [requestId]
  );
  return result.rows as HelpRequestAttachmentRow[];
}

/** Update a help request (status, admin_notes, etc.). */
export async function update(
  id: string,
  body: HelpRequestUpdateBody,
  processedBy?: string
): Promise<HelpRequestRow | null> {
  const pool = getPool();
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (body.status !== undefined) {
    updates.push(`status = $${idx++}`);
    values.push(body.status);
  }
  if (body.admin_notes !== undefined) {
    updates.push(`admin_notes = $${idx++}`);
    values.push(body.admin_notes);
  }
  if (body.shopify_order_id !== undefined) {
    updates.push(`shopify_order_id = $${idx++}`);
    values.push(body.shopify_order_id);
  }
  if (body.shopify_shop !== undefined) {
    updates.push(`shopify_shop = $${idx++}`);
    values.push(body.shopify_shop);
  }
  if (body.status === 'completed' || body.status === 'rejected') {
    updates.push(`processed_at = now()`);
    if (processedBy) {
      updates.push(`processed_by = $${idx++}`);
      values.push(processedBy);
    }
  }
  if (updates.length === 0) return getById(id);
  values.push(id);
  const idPlaceholder = values.length;
  const query = `
    UPDATE ${REQUESTS}
    SET ${updates.join(', ')}, updated_at = now()
    WHERE id = $${idPlaceholder}
    RETURNING *
  `;
  const result = await pool.query(query, values);
  return (result.rows[0] as HelpRequestRow) || null;
}

/** Add an attachment row (after generating blob path). */
export async function createAttachment(params: {
  request_id: string;
  blob_url: string;
  blob_container: string;
  blob_path: string;
  file_name?: string;
  content_type?: string;
  file_size_bytes?: number;
}): Promise<HelpRequestAttachmentRow> {
  const pool = getPool();
  const result = await pool.query(
    `
    INSERT INTO ${ATTACHMENTS} (request_id, blob_url, blob_container, blob_path, file_name, content_type, file_size_bytes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `,
    [
      params.request_id,
      params.blob_url,
      params.blob_container,
      params.blob_path,
      params.file_name ?? null,
      params.content_type ?? null,
      params.file_size_bytes ?? null,
    ]
  );
  return result.rows[0] as HelpRequestAttachmentRow;
}
