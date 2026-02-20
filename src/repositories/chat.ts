import { getPool } from '../db/client';
import { DB_SCHEMA } from '../config';

const SCHEMA = DB_SCHEMA;
const MESSAGES = `${SCHEMA}.chat_messages`;

export interface ChatMessageRow {
  id: string;
  request_id: string;
  sender: 'customer' | 'admin';
  sender_id: string | null;
  body: string | null;
  attachment_blob_url: string | null;
  attachment_blob_path: string | null;
  attachment_file_name: string | null;
  attachment_content_type: string | null;
  created_at: string;
}

export interface ChatMessageCreate {
  request_id: string;
  sender: 'customer' | 'admin';
  sender_id?: string | null;
  body?: string | null;
  attachment_blob_url?: string | null;
  attachment_blob_path?: string | null;
  attachment_file_name?: string | null;
  attachment_content_type?: string | null;
}

/** Get all messages for a help request, ordered by created_at ASC. */
export async function getMessagesByRequestId(requestId: string): Promise<ChatMessageRow[]> {
  const pool = getPool();
  const query = `
    SELECT * FROM ${MESSAGES}
    WHERE request_id = $1
    ORDER BY created_at ASC
  `;
  const result = await pool.query(query, [requestId]);
  return result.rows as ChatMessageRow[];
}

/** Create a new chat message. */
export async function createMessage(data: ChatMessageCreate): Promise<ChatMessageRow> {
  const pool = getPool();
  const query = `
    INSERT INTO ${MESSAGES} (
      request_id, sender, sender_id, body,
      attachment_blob_url, attachment_blob_path, attachment_file_name, attachment_content_type
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `;
  const result = await pool.query(query, [
    data.request_id,
    data.sender,
    data.sender_id || null,
    data.body?.trim() || null,
    data.attachment_blob_url || null,
    data.attachment_blob_path || null,
    data.attachment_file_name || null,
    data.attachment_content_type || null,
  ]);
  return result.rows[0] as ChatMessageRow;
}

/** Get unread message count for admin (messages from customer after last admin message or request creation). */
export async function getUnreadCountForAdmin(requestId: string): Promise<number> {
  const pool = getPool();
  // Get the last admin message timestamp, or request creation time if no admin messages
  const query = `
    WITH last_admin_msg AS (
      SELECT MAX(created_at) as last_admin_time
      FROM ${MESSAGES}
      WHERE request_id = $1 AND sender = 'admin'
    ),
    request_created AS (
      SELECT created_at as request_time
      FROM ${SCHEMA}.help_requests
      WHERE id = $1
    ),
    unread_count AS (
      SELECT COUNT(*) as count
      FROM ${MESSAGES}
      WHERE request_id = $1
        AND sender = 'customer'
        AND created_at > COALESCE(
          (SELECT last_admin_time FROM last_admin_msg),
          (SELECT request_time FROM request_created)
        )
    )
    SELECT count FROM unread_count
  `;
  const result = await pool.query(query, [requestId]);
  return parseInt(result.rows[0]?.count || '0', 10);
}
