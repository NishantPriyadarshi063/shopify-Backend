-- Migration: One open request per order
-- Run this if you already applied schema.sql before this constraint existed.

CREATE UNIQUE INDEX IF NOT EXISTS idx_help_requests_one_open_per_order
  ON shopify_return_cancel.help_requests (order_number)
  WHERE status NOT IN ('completed', 'rejected');
