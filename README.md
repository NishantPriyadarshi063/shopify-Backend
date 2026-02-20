# Tilting Heads – Help Page Backend

API for **cancel**, **return**, and **refund** help requests. Uses PostgreSQL (schema `shopify_return_cancel`), Azure Blob Storage (SAS URLs for upload/read), and JWT for admin auth.

## Database: 5 tables (schema `shopify_return_cancel`)

| Table | Purpose |
|-------|--------|
| **admin_users** | Admin login; `help_requests.processed_by` references this. |
| **help_requests** | One row per customer request (cancel / return / refund). |
| **help_request_attachments** | Product images/videos; stores **Azure Blob URL** + path; SAS generated on-demand. |
| **chat_messages** | Per-request chat; optional attachment (blob URL). |
| **refresh_tokens** | JWT refresh tokens; revoke on logout. |

See **database/schema.sql** for the full DDL and **database/README.md** for how to run it.

## Azure Blob

- **Upload:** Backend returns a **SAS URL** (write) with TTL; client uploads to that URL. Backend then saves `blob_url`, `blob_container`, `blob_path` in the attachments table.
- **Read:** Backend generates a **read SAS URL** when serving images/videos to admin or customer.
- Env: `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`, `AZURE_STORAGE_CONTAINER`, `AZURE_SAS_TTL_MINUTES`.

## Quick start

```bash
# Install
npm install

# Run schema (set DB_* in .env first)
npm run db:migrate   # or: psql -h ... -U ... -d ... -f database/schema.sql

# Dev
npm run dev

# Build & start
npm run build && npm start
```

- **Health:** `GET /health` and `GET /health/db`

### API summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/help-requests` | No | Create request (cancel/return/refund). 409 if order already has open request. |
| GET | `/api/help-requests/check?order_number=...` | No | Check if order has open request. |
| POST | `/api/help-requests/:id/attachments/upload-url` | No | Get SAS URL to upload image/video; body: `{ file_name, content_type?, file_size_bytes? }`. |
| GET | `/api/help-requests` | Bearer | List requests (query: `type`, `status`, `limit`, `offset`). |
| GET | `/api/help-requests/:id` | Bearer | Get one request with attachments (each has `read_url` SAS). |
| PATCH | `/api/help-requests/:id` | Bearer | Update status / admin_notes (body: `{ status?, admin_notes? }`). |
| POST | `/api/auth/login` | No | Body: `{ email, password }` → access_token, refresh_token. |
| POST | `/api/auth/refresh` | No | Body: `{ refresh_token }` → new access_token. |
| POST | `/api/auth/logout` | No | Body: `{ refresh_token }` → revoke token. |

**Create first admin:**

- **Option A (any OS):** Add to `.env`: `ADMIN_EMAIL=you@example.com`, `ADMIN_PASSWORD=yourpassword`, then run `npm run seed:admin`.
- **Option B (PowerShell):**  
  `$env:ADMIN_EMAIL="you@example.com"; $env:ADMIN_PASSWORD="yourpassword"; npm run seed:admin`
- **Option C (Bash/WSL):**  
  `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret npm run seed:admin`

## Project layout

```
shopify-Backend/
├── database/
│   ├── schema.sql
│   ├── migrations/
│   └── README.md
├── scripts/
│   └── seed-admin.ts
├── src/
│   ├── config/
│   ├── db/
│   ├── middleware/
│   │   └── auth.ts       # requireAuth (JWT)
│   ├── repositories/
│   │   ├── helpRequests.ts
│   │   └── auth.ts
│   ├── routes/
│   │   ├── helpRequests.ts
│   │   └── auth.ts
│   ├── services/
│   │   └── azureBlob.ts
│   ├── types/
│   │   └── helpRequests.ts
│   └── index.ts
├── .env
├── package.json
└── tsconfig.json
```

## Design and APIs

See **docs/DESIGN_AND_APIS.md** for Shopify APIs (orderCancel, refundCreate, returnCreate/returnProcess), order lookup, status workflow, idempotency, admin auth, email, file storage, and chat.
