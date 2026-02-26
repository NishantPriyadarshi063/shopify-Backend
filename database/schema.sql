-- =============================================================================
-- Tilting Heads – Help Page (Cancel / Return / Refund)
-- Schema: shopify_return_cancel
-- Database tables: 5 (admin_users, help_requests, help_request_attachments,
--                   chat_messages, refresh_tokens)
-- Azure Blob: store blob URL and path; SAS generated on-demand for upload/read
-- =============================================================================

-- Create schema and set search path
CREATE SCHEMA IF NOT EXISTS shopify_return_cancel;

-- =============================================================================
-- 1. admin_users (must exist first: help_requests.processed_by references it)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shopify_return_cancel.admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  name            VARCHAR(255),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_users_email ON shopify_return_cancel.admin_users(email);
COMMENT ON TABLE shopify_return_cancel.admin_users IS 'Admin users for dashboard and JWT auth';

-- =============================================================================
-- 2. help_requests
--    One row per customer request (cancel / return / refund)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shopify_return_cancel.help_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              VARCHAR(20) NOT NULL CHECK (type IN ('cancel', 'return', 'refund', 'exchange')),
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'approved', 'rejected', 'completed')),

  -- Customer info (as submitted)
  customer_email    VARCHAR(255) NOT NULL,
  customer_phone    VARCHAR(50),
  customer_name     VARCHAR(255) NOT NULL,
  order_number      VARCHAR(50) NOT NULL,

  -- Optional reason / notes from customer
  reason            TEXT,

  -- Shopify (filled after lookup or admin action)
  shopify_order_id  VARCHAR(100),
  shopify_shop     VARCHAR(255),

  -- Admin action tracking
  processed_at      TIMESTAMPTZ,
  processed_by      UUID REFERENCES shopify_return_cancel.admin_users(id),
  admin_notes       TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_help_requests_type ON shopify_return_cancel.help_requests(type);
CREATE INDEX idx_help_requests_status ON shopify_return_cancel.help_requests(status);
CREATE INDEX idx_help_requests_order_number ON shopify_return_cancel.help_requests(order_number);
CREATE INDEX idx_help_requests_created_at ON shopify_return_cancel.help_requests(created_at DESC);
CREATE INDEX idx_help_requests_customer_email ON shopify_return_cancel.help_requests(customer_email);

-- One open request per order: same order_number cannot have two requests with status pending/in_progress/approved
CREATE UNIQUE INDEX idx_help_requests_one_open_per_order
  ON shopify_return_cancel.help_requests (order_number)
  WHERE status NOT IN ('completed', 'rejected');

COMMENT ON TABLE shopify_return_cancel.help_requests IS 'Customer help requests: cancel, return, or refund. Only one open request per order_number.';

-- =============================================================================
-- 3. help_request_attachments
--    Images/videos for return/refund; stored in Azure Blob; we save blob URL
--    SAS URL is generated on-demand for upload (client) and read (admin)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shopify_return_cancel.help_request_attachments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       UUID NOT NULL REFERENCES shopify_return_cancel.help_requests(id) ON DELETE CASCADE,

  -- Azure Blob: permanent URL and path (SAS generated separately for upload/read)
  blob_url         TEXT NOT NULL,
  blob_container   VARCHAR(255) NOT NULL,
  blob_path        VARCHAR(512) NOT NULL,

  -- File metadata
  file_name        VARCHAR(255),
  file_type        VARCHAR(100),
  content_type     VARCHAR(150),
  file_size_bytes  BIGINT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_help_request_attachments_request_id ON shopify_return_cancel.help_request_attachments(request_id);

COMMENT ON TABLE shopify_return_cancel.help_request_attachments IS 'Product images/videos for return/refund; blob_url points to Azure Blob';

-- =============================================================================
-- 4. chat_messages
--    One thread per help request; optional attachment (blob URL)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shopify_return_cancel.chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      UUID NOT NULL REFERENCES shopify_return_cancel.help_requests(id) ON DELETE CASCADE,
  sender          VARCHAR(20) NOT NULL CHECK (sender IN ('customer', 'admin')),
  sender_id       UUID REFERENCES shopify_return_cancel.admin_users(id),

  body            TEXT,
  -- Attachment: Azure blob URL (SAS generated when serving to client)
  attachment_blob_url   TEXT,
  attachment_blob_path  VARCHAR(512),
  attachment_file_name VARCHAR(255),
  attachment_content_type VARCHAR(150),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_messages_request_id ON shopify_return_cancel.chat_messages(request_id);
CREATE INDEX idx_chat_messages_created_at ON shopify_return_cancel.chat_messages(created_at);

COMMENT ON TABLE shopify_return_cancel.chat_messages IS 'Per-request chat; attachments stored in Azure Blob';

-- =============================================================================
-- 5. refresh_tokens
--    Store refresh tokens for JWT rotation (invalidate on logout)
-- =============================================================================
CREATE TABLE IF NOT EXISTS shopify_return_cancel.refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES shopify_return_cancel.admin_users(id) ON DELETE CASCADE,
  token_hash      VARCHAR(255) NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_refresh_tokens_token_hash ON shopify_return_cancel.refresh_tokens(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_tokens_user_id ON shopify_return_cancel.refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON shopify_return_cancel.refresh_tokens(expires_at);

COMMENT ON TABLE shopify_return_cancel.refresh_tokens IS 'Refresh tokens for JWT; revoke on logout';

-- =============================================================================
-- Trigger: updated_at for help_requests and admin_users
-- =============================================================================
CREATE OR REPLACE FUNCTION shopify_return_cancel.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS help_requests_updated_at ON shopify_return_cancel.help_requests;
CREATE TRIGGER help_requests_updated_at
  BEFORE UPDATE ON shopify_return_cancel.help_requests
  FOR EACH ROW EXECUTE PROCEDURE shopify_return_cancel.set_updated_at();

DROP TRIGGER IF EXISTS admin_users_updated_at ON shopify_return_cancel.admin_users;
CREATE TRIGGER admin_users_updated_at
  BEFORE UPDATE ON shopify_return_cancel.admin_users
  FOR EACH ROW EXECUTE PROCEDURE shopify_return_cancel.set_updated_at();
