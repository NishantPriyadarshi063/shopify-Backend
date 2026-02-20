# Database – schema `shopify_return_cancel`

## Rule: one open request per order

**Same order → only one open request at a time.**

- User A requests **cancel** for order `#1001` → row created (status `pending`).
- User A (or anyone) tries **return** for order `#1001` → **rejected**: "You already have an open request for this order."
- The DB enforces this with a partial unique index on `(order_number)` where `status NOT IN ('completed', 'rejected')`.
- After the first request is **completed** or **rejected**, a new request for the same order is allowed (e.g. they can then request return if cancel was rejected).

**In your API:** Before inserting a new row, check for an existing open request:

```sql
SELECT id FROM shopify_return_cancel.help_requests
WHERE order_number = $1 AND status NOT IN ('completed', 'rejected')
LIMIT 1;
```

If a row exists, return **409 Conflict** (or 400) with a message like: *"You already have an open request for this order. Please wait for it to be processed or contact support."*

## Tables (5)

| # | Table | Purpose |
|---|--------|--------|
| 1 | **admin_users** | Admin login; `processed_by` on help_requests references this. |
| 2 | **help_requests** | One row per customer request (cancel / return / refund). |
| 3 | **help_request_attachments** | Product images/videos for return/refund; stores **Azure Blob URL** and path. |
| 4 | **chat_messages** | Per-request chat; optional attachment (blob URL). |
| 5 | **refresh_tokens** | JWT refresh tokens; revoke on logout. |

## Azure Blob usage

- **Upload:** Backend generates a **SAS URL** (write) with TTL from `AZURE_SAS_TTL_MINUTES`; client uploads to that URL. Backend then saves in DB: `blob_url`, `blob_container`, `blob_path`, file metadata.
- **Read:** Backend generates a **SAS URL** (read) when serving images/videos to admin or customer; or return `blob_url` if container is public.
- **Stored in DB:** `blob_url` (full blob URL), `blob_container`, `blob_path` so you can regenerate SAS anytime.

## How to run

From project root, with `psql` or any PostgreSQL client connected to the same DB as in `.env`:

```bash
# Option 1: psql
psql -h seleric.cloud -p 5432 -U admin_seleric -d seleric_stag -f database/schema.sql

# Option 2: Set search_path and run (schema is created inside the file)
# Ensure DB_USER has permission to create schema and tables.
```

After first run, you can add an initial admin user (e.g. via a seed script or signup endpoint).
