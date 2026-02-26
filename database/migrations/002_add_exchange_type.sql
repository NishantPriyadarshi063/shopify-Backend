-- Add 'exchange' to help_requests.type allowed values
-- Run after schema / 001_one_open_request_per_order

ALTER TABLE shopify_return_cancel.help_requests
  DROP CONSTRAINT IF EXISTS help_requests_type_check;

ALTER TABLE shopify_return_cancel.help_requests
  ADD CONSTRAINT help_requests_type_check CHECK (
    type::text = ANY (ARRAY[
      'cancel'::character varying,
      'return'::character varying,
      'refund'::character varying,
      'exchange'::character varying
    ]::text[])
  );
