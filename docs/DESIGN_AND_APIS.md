# Tilting Heads – Help Page (Cancel / Return / Refund) – Design & APIs

## 1. Your questions answered

### 1.1 Does Shopify let us take action from our admin (without going to Shopify admin)?

**Yes.** Shopify’s **Admin GraphQL API** lets you cancel orders, create refunds, and create/process returns from your own backend/admin. You do **not** need to open Shopify admin to perform these actions.

| Action | Shopify API | Scope | Notes |
|--------|-------------|--------|--------|
| **Cancel order** | `orderCancel` | `write_orders` or `write_marketplace_orders` | Full cancel, optional refund (original payment or store credit), restock, notify customer. **Irreversible.** |
| **Refund** | `refundCreate` | `orders` or `marketplace_orders` | Full/partial refund; line items, shipping, duties; store credit. From 2026-04, **idempotency key required**. |
| **Return** | `returnCreate` + `returnProcess` | `write_returns` / `write_marketplace_returns` | `returnCreate` opens a return; as of July 2025, use `returnProcess` (replaces `returnRefund`) to process/refund. |

So in your **admin app** you can:

- Show a list of help requests (from PostgreSQL).
- For each request, call the right mutation using your stored Shopify access token (same one you use for analytics/orders).
- Optionally show the result (e.g. “Order cancelled”, “Refund created”) and update the request status in your DB.

References:

- [orderCancel](https://shopify.dev/docs/api/admin-graphql/latest/mutations/ordercancel)
- [refundCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/refundCreate)
- [returnCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/returnCreate)
- [Returns Processing API (returnProcess)](https://shopify.dev/changelog/returns-processing-api)

---

### 1.2 Can we implement real-time chat with file/image support?

**Yes.** You can do it with your stack (Node.js + Next.js + PostgreSQL):

- **Real-time:** WebSockets. Easiest with **Socket.IO** (Node.js server + client in Next.js). Alternatives: raw WebSockets, or a hosted service (Pusher, Ably, SendBird).
- **Files/images:**  
  - **Option A:** Upload via your API (Next.js API route or Node backend) → store files in **S3** (or Cloudinary, R2) → save URL + metadata in PostgreSQL; send the URL in the chat message.  
  - **Option B:** Small images as base64 over Socket.IO (only for small files; not ideal for large uploads).

Recommended: **Socket.IO for real-time + REST/API route for file upload** (multipart) → cloud storage → store URL in DB and in chat message.

---

## 2. Flows you described (and small additions)

### 2.1 Cancel order

- **Collect:** email, phone, customer name, order number, optional reason (textarea).
- **Backend:** Create a “help request” with type `cancel`, store in PostgreSQL. Optionally validate that the order exists and belongs to that email (via Shopify Admin API) before allowing submit.
- **Admin:** List request; from admin, call `orderCancel` with the order’s Shopify GID (resolved from order number/name).

### 2.2 Return order

- **Collect:** email, phone, customer name, order number, **product image upload** (to assess condition).
- **Backend:** Save request type `return`, store image URL(s) in DB (after upload to S3/Cloudinary).
- **Admin:** List request; view images; when approved, use `returnCreate` (and then `returnProcess` when you’re ready to process the return/refund).

### 2.3 Refund

- **Collect:** Same as return (email, phone, name, order number); optionally reason + image if it’s “refund after damage” etc.
- **Backend:** Save as type `refund`; optional image upload same as return.
- **Admin:** For “refund only” (no return), use `refundCreate`; for “refund after return”, use return flow then `returnProcess` / refund.

---

## 3. What you might have missed (and suggested solutions)

The table below lists each consideration; **[section 3.1](#31-how-we-tackle-these-implementation-guide)** documents how we tackle each one (order lookup, status workflow, idempotency, admin auth, email, file storage, chat, etc.) with concrete implementation steps and where things live in the stack.

| Topic | Suggestion |
|--------|------------|
| **Order identity** | Customers use **order number** (e.g. `#1001`). Shopify APIs use **order GID** (e.g. `gid://shopify/Order/123`). Your backend should **resolve** order number → order GID (e.g. query `orders(query: "name:#1001")` or by order number) and then use that GID in `orderCancel` / `refundCreate` / `returnCreate`. |
| **Request status** | Add a status workflow, e.g. `pending` → `in_progress` → `approved` / `rejected` → `completed`. Store in PostgreSQL and show in admin. |
| **Customer verification** | Optionally verify that the email/phone matches the order in Shopify before accepting the request (reduces abuse). |
| **Email notifications** | On new request: send "We received your request." On status change: "Your return was approved" / "Refund processed." Use Resend, SendGrid, or Shopify Flow. |
| **Refund vs return** | **Refund only:** use `refundCreate`. **Return then refund:** use `returnCreate` then `returnProcess`. In admin, two different buttons/flows. |
| **Idempotency** | `refundCreate` requires an idempotency key (e.g. UUID per "refund attempt"). Generate one per action in admin and retry safely. |
| **Admin auth** | Protect admin routes (e.g. NextAuth, or JWT after login). Do not expose admin list/actions to public. |
| **File storage** | Store product images in **S3** (or R2/Cloudinary); save only URLs in PostgreSQL. Add size/type validation and virus scan if needed. |
| **Chat scope** | Decide: chat per **help request** (thread) vs one global "contact us" room. Per-request thread is better for context and history. |
| **Chat persistence** | Store messages in PostgreSQL (e.g. `chat_messages` with `request_id`); Socket.IO for delivery; on reconnect, load history from DB. |

---

## 3.1 How we tackle these (implementation guide)

Below is how to implement each of the items above in your Node.js + Next.js + PostgreSQL stack.

### Order lookup (order number → Shopify GID)

**Problem:** Customer submits order number (e.g. `1001` or `#1001`). Shopify mutations need order GID (`gid://shopify/Order/123456`).

**Solution:**

1. **Normalize input:** Strip `#` and leading zeros if needed; Shopify `name` is usually `#1001` for order number 1001.
2. **GraphQL query** (Admin API) to resolve by order name:
   ```graphql
   query GetOrderByNumber($query: String!) {
     orders(first: 1, query: $query) {
       edges { node { id name email } }
     }
   }
   ```
   Variables: `{ "query": "name:#1001" }` (use the store’s order number format).
3. **Single backend function** (e.g. `getOrderGidByOrderNumber(shopDomain, accessToken, orderNumber)`):
   - Build query string `name:#${orderNumber}` (or `name:${orderNumber}` depending on store).
   - Call Shopify Admin GraphQL; return `node.id` (the GID) or throw if not found.
4. **When to call:** Either at **submit** (validate and store `shopify_order_id` on `help_requests`) or when **admin takes action** (lookup then call `orderCancel` / `refundCreate` / etc.). Doing it at submit gives you a chance to show “Order not found” to the customer and to verify email (see Customer verification below).
5. **Store result:** Save `shopify_order_id` (and optionally `shopify_shop`) on `help_requests` so admin doesn’t need to look up again.

**Where:** Backend service (e.g. `shopifyOrderLookup.ts` or inside your existing Shopify integration). Reuse your existing Shopify access token (from OAuth / env / DB).

---

### Request status workflow

**Problem:** Requests need a clear lifecycle so admin and (optionally) customers see progress.

**Solution:**

1. **Status values** (already in schema): `pending` → `in_progress` → `approved` | `rejected` → `completed`.
2. **Rules:**
   - **pending:** Just created; no action taken.
   - **in_progress:** Admin is working on it (e.g. contacted customer, checking with warehouse).
   - **approved / rejected:** Decision made. For cancel/refund/return you might set `approved` only after the Shopify mutation succeeds.
   - **completed:** Order cancelled / refund created / return processed; no further action.
3. **Transitions in code:** In your API, only allow valid transitions (e.g. `pending` → `in_progress` → `approved` → `completed`). Reject invalid ones with 400.
4. **Admin UI:** Show status badge; filter list by status; on “Cancel order” / “Refund” / “Process return” success, set status to `completed` (and set `processed_at`, `processed_by`).
5. **Optional:** Add a `status_history` table or JSONB column if you need an audit trail of status changes.

**Where:** PostgreSQL `help_requests.status`; API route (e.g. `PATCH /api/help-requests/:id/status`); admin list and detail pages.

---

### Customer verification (optional)

**Problem:** Prevent someone from submitting cancel/return/refund for another person’s order.

**Solution:**

1. **After order lookup** (see Order lookup), you have the order’s `email` (and optionally phone) from Shopify.
2. **Compare:** If the email on the order (from Shopify) matches `customer_email` from the form, treat as verified. Optionally compare phone if you store it on the order.
3. **If mismatch:** Either reject the request (“Order not found or email doesn’t match”) or allow but flag for admin review (e.g. set a `verified: false` or show a warning in admin).
4. **Implementation:** In the same function that does order lookup, return `{ orderId, emailMatches: order.email === customerEmail }`. When creating the help request, store `email_verified: boolean` if you add that column, or leave it implicit (only create request when email matches, or always create and show warning in admin).

**Where:** Backend, in the flow that creates the help request (or in a dedicated “validate order” endpoint called before submit).

---

### Refund vs return (two flows in admin)

**Problem:** “Refund” can mean refund-only (no return) or refund-after-return. Shopify has different APIs.

**Solution:**

1. **Refund only (no return):**  
   - Admin clicks “Issue refund” (or “Refund only”).  
   - Backend: resolve order GID (if not already on request), then call **`refundCreate`** with the right line items / amount.  
   - No `returnCreate` or `returnProcess`.

2. **Return then refund:**  
   - Admin clicks “Create return” then later “Process return / Refund”.  
   - Backend: **`returnCreate`** with the fulfilled line items to return → then **`returnProcess`** (as of July 2025) to complete the return and issue refund.  
   - Use Shopify’s Returns Processing API docs for exact `returnProcess` input (return ID, refund method, etc.).

3. **In your admin UI:**  
   - For request type **return:** show “Create return” + “Process return” (or one combined flow if you prefer).  
   - For request type **refund:** show “Issue refund” (refundCreate only).  
   - Don’t mix: if the customer asked for a “return”, use return flow; if they asked for “refund” only (e.g. wrong item, never shipped), use `refundCreate` only.

**Where:** Admin detail page (two action buttons or two flows); backend routes like `POST /api/help-requests/:id/refund` and `POST /api/help-requests/:id/create-return`, `POST /api/help-requests/:id/process-return`.

---

### Idempotency for refundCreate

**Problem:** Shopify’s `refundCreate` requires an idempotency key (required as of 2026-04). Duplicate requests must not create two refunds.

**Solution:**

1. **Generate a key per refund attempt:** e.g. `uuid.v4()` or `crypto.randomUUID()`. Key must be unique per “logical” refund (e.g. one per help request + action).
2. **Recommended:** Use a stable key derived from the help request and action, e.g. `refund-${helpRequestId}-${timestampOrVersion}`. Store this in DB (e.g. `refund_idempotency_key` on `help_requests` or in a small `refund_attempts` table). If the same request is retried, send the **same** key so Shopify returns the same refund instead of creating a new one.
3. **GraphQL:** Use the `@idempotent(key: $idempotencyKey)` directive on the mutation; pass the key in variables.
4. **Retries:** On network failure, retry with the **same** idempotency key; backend should not generate a new key for the same user action.

**Where:** Backend when calling `refundCreate`; store the key in DB so you can retry safely. Example: when admin clicks “Issue refund”, create key once, save it, use it in the mutation; if mutation fails with retryable error, retry with same key.

---

### Admin auth (protect admin routes)

**Problem:** Admin list and actions must not be public.

**Solution:**

1. **Option A – NextAuth (recommended if you use Next.js for admin):**  
   - Add NextAuth with a provider (e.g. credentials, or Google/GitHub).  
   - Protect all routes under `/admin` (or `/dashboard/help`) with a middleware or `getServerSession`; redirect to login if no session.  
   - Store admin user in session; use `processed_by` = session user id/email when updating requests.

2. **Option B – JWT:**  
   - Login endpoint: validate email/password (or SSO), issue JWT (e.g. 24h expiry).  
   - Admin API routes and Next.js pages: require `Authorization: Bearer <token>`. Validate JWT and attach user to request.  
   - Use same token (or refresh) for API calls from the admin frontend.

3. **Scopes:** Only allow roles that should see help requests (e.g. “support”, “admin”). Store role in DB or in JWT claims.

**Where:** Next.js middleware or `getServerSession` in layout; API middleware that checks session/JWT before listing or updating help requests.

---

### Email notifications

**Problem:** Customer should know their request was received and when status changes (e.g. approved, refund processed).

**Solution:**

1. **Provider:** Use Resend, SendGrid, or similar. Store API key in env (e.g. `RESEND_API_KEY`). Send from a verified domain (e.g. `noreply@tiltingheads.com`).
2. **Events to send:**  
   - **On create:** When a new help request is inserted, send “We received your request” with request type and reference (e.g. request id or order number).  
   - **On status change:** When status moves to `in_progress`, `approved`, `rejected`, or `completed`, send a short email (“Your return was approved”, “Your refund has been processed”, etc.).
3. **Implementation:**  
   - In the same API that creates/updates the help request, after DB commit, call a small `sendHelpRequestEmail(type, to, data)` function.  
   - Or use a queue (e.g. Bull with Redis) so API responds fast and a worker sends the email.  
   - Use a simple HTML/text template with request type, order number, and new status.
4. **Unsubscribe:** For transactional emails (order-related) usually no unsubscribe is required; keep content to the point (request received / status update).

**Where:** Backend service (e.g. `emailService.ts`); call from help-request create and status-update endpoints. Env: `RESEND_API_KEY`, `NOTIFICATION_FROM`.

---

### File storage (return/refund images and chat attachments)

**Problem:** Product images and chat files must be stored securely; only URLs in DB.

**Solution:**

1. **Storage:** Use **S3** (or R2, Cloudinary). Create a bucket; use IAM keys or Cloudinary credentials in env.
2. **Upload flow:**  
   - **Help request attachments:** Form submit (multipart) or separate `POST /api/upload` that accepts a file, uploads to S3, returns URL. Frontend then sends that URL in the create-help-request payload (or backend associates the uploaded file with the request by a temp id).  
   - **Chat:** Same idea: `POST /api/chat/upload` → S3 → return URL; client sends message with `attachment_url`.
3. **Validation:**  
   - **Size:** e.g. max 5–10 MB per file.  
   - **Type:** Allow only images (e.g. `image/jpeg`, `image/png`, `image/webp`) and maybe PDF for returns. Reject others with 400.  
   - **Virus scan (optional):** Use ClamAV or a cloud scan service on upload; reject if infected.
4. **DB:** Store only `file_url` (and optionally `file_name`, `file_type`, `file_size`) in `help_request_attachments` and in `chat_messages.attachment_url`. Never store file binary in PostgreSQL.
5. **Access:** Serve files via S3 public URL or signed URL; if private, generate short-lived signed URLs in API when admin/customer views the request or chat.

**Where:** Backend upload route (Node or Next.js API route); S3 SDK (e.g. `@aws-sdk/client-s3`); validation in that route; env for bucket and credentials.

---

### Chat (per-request thread + persistence)

**Problem:** Real-time chat with history and optional file sharing.

**Solution:**

1. **Scope:** One thread per help request. When customer or admin opens a request, they join the room for that `request_id` (e.g. Socket.IO room `request:${requestId}`).
2. **Persistence:**  
   - Every message is first saved to PostgreSQL `chat_messages` (request_id, sender, body, attachment_url, created_at).  
   - Then broadcast to the room via Socket.IO.  
   - On client connect/reconnect, load last N messages from DB (e.g. `GET /api/help-requests/:id/messages`) so history is always from DB, not only from socket.
3. **Socket.IO:**  
   - Server: On connection, client sends `requestId`; server joins them to `request:${requestId}`. On incoming `message` event, validate sender, insert into DB, then `io.to(room).emit('message', msg)`.  
   - Client: Emit `message` on send; listen for `message` and append to UI. On mount, fetch history from REST API, then listen for new messages via socket.
4. **Files:** Use the same file-upload API as above; client sends message with `attachment_url` and optional `attachment_name`. No large binary over the socket.
5. **Auth:** For admin, ensure only authenticated users can join rooms (e.g. verify JWT/session when joining). For customer, you can use a short-lived token or link (e.g. `?request_id=xxx&token=yyy`) so only someone with the link can join that request’s room; validate token server-side before joining.

**Where:** Socket.IO server (Node.js); `chat_messages` table; REST endpoint for message history; frontend: one chat component per request detail page; upload API reused for attachments.

---

## 4. High-level architecture

```
[Customer] → Help page (Next.js)
  → Cancel / Return / Refund forms
  → Submit → Node.js API (or Next.js API route)
  → PostgreSQL (help_requests, attachments)
  → Optional: Shopify API to validate order

[Admin] → Admin app (Next.js, protected)
  → List help_requests (filters: type, status)
  → Open request → See details + images
  → Actions: Cancel order / Create return / Create refund
  → Node.js backend calls Shopify GraphQL (orderCancel / refundCreate / returnCreate / returnProcess)
  → Update request status in PostgreSQL

[Chat]
  → Socket.IO server (Node.js) + Next.js client
  → Files: upload API → S3 → URL in message
  → Messages stored in PostgreSQL (chat_messages linked to help_request_id)
```

---

## 5. Tech stack summary

| Layer | Choice |
|--------|--------|
| DB | PostgreSQL (requests, attachments, chat messages, admin users) |
| Backend | Node.js (Express/Fastify) – API, Shopify client, Socket.IO, file upload) |
| Frontend | Next.js (TypeScript) – help flows + admin UI |
| Shopify | Admin GraphQL API (orderCancel, refundCreate, returnCreate, returnProcess) |
| Files | S3 (or R2/Cloudinary) for return/refund images and chat attachments |
| Realtime | Socket.IO for chat |
| Auth | NextAuth or JWT for admin; optional customer verification via Shopify order lookup |

---

## 6. Next steps

1. Implement **help request** forms (cancel / return / refund) and persistence in PostgreSQL.
2. Implement **admin** list + detail view and wire **Shopify mutations** (orderCancel, refundCreate, returnCreate/returnProcess) with order lookup by order number.
3. Add **file upload** (return/refund images) to S3 and link to requests.
4. Add **Socket.IO** and **chat** (per-request thread, messages in DB, file upload for chat).
5. Add **email notifications** and **admin auth** as needed.

All of this can live in one monorepo: e.g. `apps/web` (Next.js), `apps/api` (Node.js), shared types and DB access.
