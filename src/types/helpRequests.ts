export type HelpRequestType = 'cancel' | 'return' | 'refund';

export type HelpRequestStatus =
  | 'pending'
  | 'in_progress'
  | 'approved'
  | 'rejected'
  | 'completed';

export interface HelpRequestCreateBody {
  type: HelpRequestType;
  customer_email: string;
  customer_phone?: string;
  customer_name: string;
  order_number: string;
  reason?: string;
}

export interface HelpRequestRow {
  id: string;
  type: HelpRequestType;
  status: HelpRequestStatus;
  customer_email: string;
  customer_phone: string | null;
  customer_name: string;
  order_number: string;
  reason: string | null;
  shopify_order_id: string | null;
  shopify_shop: string | null;
  processed_at: string | null;
  processed_by: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface HelpRequestAttachmentRow {
  id: string;
  request_id: string;
  blob_url: string;
  blob_container: string;
  blob_path: string;
  file_name: string | null;
  file_type: string | null;
  content_type: string | null;
  file_size_bytes: number | null;
  created_at: string;
}

export interface HelpRequestUpdateBody {
  status?: HelpRequestStatus;
  admin_notes?: string;
  shopify_order_id?: string;
  shopify_shop?: string;
}
