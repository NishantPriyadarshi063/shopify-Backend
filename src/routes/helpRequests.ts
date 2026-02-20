import { Router, Request, Response } from 'express';
import {
  hasOpenRequestForOrder,
  create,
  list,
  getById,
  getAttachmentsByRequestId,
  update,
  createAttachment,
} from '../repositories/helpRequests';
import { getPool } from '../db/client';
import { getUploadSasUrl, getReadSasUrl, buildBlobPath, getBlobUrl } from '../services/azureBlob';
import { config } from '../config';
import { buildShopifyAdminOrderUrl, cancelOrder, findOrderByName, getOrder, refundFullOrder, refundPartialOrder } from '../services/shopify';
import { notifyAdminNewHelpRequest, notifyCustomerRequestReceived } from '../services/notifications';
import { requireAuth } from '../middleware/auth';
import type { HelpRequestCreateBody, HelpRequestUpdateBody, HelpRequestType, HelpRequestStatus } from '../types/helpRequests';

const router = Router();

// --- Public: create help request (customer) ---
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as HelpRequestCreateBody;
    const { type, customer_email, customer_name, order_number } = body;

    if (!type || !customer_email?.trim() || !customer_name?.trim() || !order_number?.trim()) {
      return res.status(400).json({
        error: 'Missing required fields: type, customer_email, customer_name, order_number',
      });
    }
    const allowedTypes: HelpRequestType[] = ['cancel', 'return', 'refund'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be cancel, return, or refund.' });
    }

    const openExists = await hasOpenRequestForOrder(order_number);
    if (openExists) {
      return res.status(409).json({
        error: 'You already have an open request for this order. Please wait for it to be processed or contact support.',
        code: 'OPEN_REQUEST_EXISTS',
      });
    }

    const request = await create(body);
    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL || '';
    if (adminEmail) {
      notifyAdminNewHelpRequest(
        adminEmail,
        type,
        body.customer_name.trim(),
        body.customer_email.trim(),
        body.order_number.replace(/^#/, '').trim(),
        body.reason?.trim() || null,
        request.id
      ).catch((e) => console.error('Failed to notify admin of new request:', e));
    }
    const reference = String(request.id).slice(0, 8).toUpperCase();
    notifyCustomerRequestReceived(
      body.customer_email.trim(),
      body.customer_name.trim(),
      type,
      body.order_number.replace(/^#/, '').trim(),
      reference,
      request.id
    ).catch((e) => console.error('Failed to send customer confirmation:', e));
    return res.status(201).json(request);
  } catch (e) {
    console.error('POST /help-requests', e);
    return res.status(500).json({ error: 'Failed to create request' });
  }
});

// --- Public: check if order has open request (for frontend) ---
router.get('/check', async (req: Request, res: Response) => {
  const order_number = (req.query.order_number as string)?.trim();
  if (!order_number) {
    return res.status(400).json({ error: 'Query order_number is required' });
  }
  try {
    const hasOpen = await hasOpenRequestForOrder(order_number);
    return res.json({ order_number, has_open_request: hasOpen });
  } catch (e) {
    console.error('GET /help-requests/check', e);
    return res.status(500).json({ error: 'Failed to check' });
  }
});

// --- Public: get latest request status for a customer (by order number + email) ---
router.get('/status', async (req: Request, res: Response) => {
  const order_number = (req.query.order_number as string)?.trim();
  const email = (req.query.email as string)?.trim().toLowerCase();

  if (!order_number || !email) {
    return res
      .status(400)
      .json({ error: 'Query order_number and email are required' });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `
        SELECT id, type, status, customer_email, customer_name, order_number, created_at, updated_at
        FROM ${config.db.schema}.help_requests
        WHERE order_number = $1 AND LOWER(customer_email) = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [order_number.replace(/^#/, '').trim(), email]
    );

    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({
        error: 'No request found for this order and email',
      });
    }

    // Short, customer-friendly reference (first 8 chars of UUID)
    const reference = String(row.id).slice(0, 8).toUpperCase();

    return res.json({
      id: row.id,
      reference,
      type: row.type,
      status: row.status,
      customer_email: row.customer_email,
      customer_name: row.customer_name,
      order_number: row.order_number,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  } catch (e) {
    console.error('GET /help-requests/status', e);
    return res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// --- Admin: list (protected) ---
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const type = req.query.type as HelpRequestType | undefined;
    const status = req.query.status as HelpRequestStatus | undefined;
    const search = (req.query.search as string)?.trim() || undefined;
    const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : 50;
    const offset = req.query.offset != null ? parseInt(String(req.query.offset), 10) : 0;

    const requests = await list({ type, status, search, limit, offset });
    return res.json(requests);
  } catch (e) {
    console.error('GET /help-requests', e);
    return res.status(500).json({ error: 'Failed to list requests' });
  }
});

// --- Admin: get one with attachments (read SAS URLs) ---
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const request = await getById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const attachments = await getAttachmentsByRequestId(req.params.id);
    const attachmentsWithReadUrl = attachments.map((a) => ({
      ...a,
      read_url: getReadSasUrl(a.blob_path),
    }));

    return res.json({ ...request, attachments: attachmentsWithReadUrl });
  } catch (e) {
    console.error('GET /help-requests/:id', e);
    return res.status(500).json({ error: 'Failed to get request' });
  }
});

// --- Admin: update status / notes ---
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body as HelpRequestUpdateBody;
    const adminId = req.auth?.userId;

    const updated = await update(req.params.id, body, adminId);
    if (!updated) return res.status(404).json({ error: 'Request not found' });
    return res.json(updated);
  } catch (e) {
    console.error('PATCH /help-requests/:id', e);
    return res.status(500).json({ error: 'Failed to update request' });
  }
});

// --- Admin: Shopify lookup by order number (stores shopify_order_id + shopify_shop) ---
router.post('/:id/shopify/lookup', requireAuth, async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const request = await getById(requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const order = await findOrderByName(request.order_number);
    if (!order) {
      return res.status(404).json({ error: `No Shopify order found for #${request.order_number}` });
    }

    const updated = await update(
      requestId,
      {
        shopify_order_id: String(order.id),
        shopify_shop: config.shopify.shopDomain,
      },
      req.auth?.userId
    );

    return res.json({
      request: updated ?? request,
      shopify: {
        order_id: String(order.id),
        order_name: order.name,
        admin_url: buildShopifyAdminOrderUrl(order.id),
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        total_price: order.total_price,
        currency: order.currency,
      },
    });
  } catch (e) {
    console.error('POST /help-requests/:id/shopify/lookup', e);
    return res.status(500).json({ error: 'Failed to lookup Shopify order' });
  }
});

// --- Admin: Cancel order in Shopify ---
router.post('/:id/shopify/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const request = await getById(requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    let orderIdStr = request.shopify_order_id;
    if (!orderIdStr) {
      const order = await findOrderByName(request.order_number);
      if (!order) return res.status(404).json({ error: `No Shopify order found for #${request.order_number}` });
      orderIdStr = String(order.id);
    }

    const orderId = parseInt(orderIdStr, 10);
    await cancelOrder(orderId);

    const updated = await update(
      requestId,
      { status: 'completed', shopify_order_id: String(orderId), shopify_shop: config.shopify.shopDomain },
      req.auth?.userId
    );

    return res.json({
      request: updated ?? request,
      shopify: { admin_url: buildShopifyAdminOrderUrl(orderId) },
      message: 'Order cancelled in Shopify',
    });
  } catch (e: any) {
    console.error('POST /help-requests/:id/shopify/cancel', e);
    const status = e?.status === 422 ? 422 : 500;
    const message = e?.message && typeof e.message === 'string' ? e.message : 'Failed to cancel order in Shopify';
    return res.status(status).json({ error: message });
  }
});

// --- Admin: Get Shopify order details (line items for partial refund UI) ---
router.get('/:id/shopify/order', requireAuth, async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const request = await getById(requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    let orderIdStr = request.shopify_order_id;
    if (!orderIdStr) {
      const order = await findOrderByName(request.order_number);
      if (!order) return res.status(404).json({ error: `No Shopify order found for #${request.order_number}` });
      orderIdStr = String(order.id);
    }
    const orderId = parseInt(orderIdStr, 10);
    const order = await getOrder(orderId);
    return res.json({
      order_id: order.id,
      order_name: order.name,
      currency: order.currency,
      line_items: order.line_items.map((li) => ({
        id: li.id,
        title: li.title,
        variant_title: li.variant_title,
        quantity: li.quantity,
        price: li.price,
      })),
      admin_url: buildShopifyAdminOrderUrl(orderId),
    });
  } catch (e) {
    console.error('GET /help-requests/:id/shopify/order', e);
    return res.status(500).json({ error: 'Failed to fetch Shopify order' });
  }
});

// --- Admin: Refund order in Shopify (full or partial) ---
// Body: { refundLineItems?: Array<{ lineItemId, quantity }>, restockType?: string, note?: string }
// If refundLineItems is provided and non-empty, partial refund; else full refund.
router.post('/:id/shopify/refund', requireAuth, async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const request = await getById(requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    let orderIdStr = request.shopify_order_id;
    if (!orderIdStr) {
      const order = await findOrderByName(request.order_number);
      if (!order) return res.status(404).json({ error: `No Shopify order found for #${request.order_number}` });
      orderIdStr = String(order.id);
    }
    const orderId = parseInt(orderIdStr, 10);
    const body = (req.body || {}) as {
      refundLineItems?: Array<{ lineItemId: number; quantity: number }>;
      restockType?: string;
      note?: string;
      refundAmount?: number;
    };
    const defaultNote = `Refund for help request ${requestId}`;
    const manualAmount =
      body.refundAmount != null && typeof body.refundAmount === 'number' && body.refundAmount > 0
        ? body.refundAmount
        : undefined;

    if (Array.isArray(body.refundLineItems) && body.refundLineItems.length > 0) {
      await refundPartialOrder(orderId, body.refundLineItems, {
        restockType: body.restockType ?? 'no_restock',
        note: body.note ?? defaultNote,
        manualRefundAmount: manualAmount,
      });
    } else {
      await refundFullOrder(orderId, body.note ?? defaultNote, manualAmount);
    }

    const updated = await update(
      requestId,
      { status: 'completed', shopify_order_id: String(orderId), shopify_shop: config.shopify.shopDomain },
      req.auth?.userId
    );

    return res.json({
      request: updated ?? request,
      shopify: { admin_url: buildShopifyAdminOrderUrl(orderId) },
      message: 'Refund initiated in Shopify',
    });
  } catch (e: unknown) {
    console.error('POST /help-requests/:id/shopify/refund', e);
    const err = e as Error & { status?: number };
    const status = err?.status === 422 || err?.status === 400 ? err.status : 500;
    const message = err?.message && typeof err.message === 'string' ? err.message : 'Failed to refund order in Shopify';
    return res.status(status).json({ error: message });
  }
});

// --- Upload URL for attachment (customer or admin): get SAS URL and create attachment row ---
router.post('/:id/attachments/upload-url', async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const request = await getById(requestId);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const { file_name, content_type, file_size_bytes } = req.body as {
      file_name?: string;
      content_type?: string;
      file_size_bytes?: number;
    };
    const fileName = (file_name as string)?.trim() || 'file';
    const blobPath = buildBlobPath('help-requests', requestId, fileName);
    const blobUrl = getBlobUrl(blobPath);
    const uploadUrl = getUploadSasUrl(blobPath);

    const attachment = await createAttachment({
      request_id: requestId,
      blob_url: blobUrl,
      blob_container: config.azure.containerName,
      blob_path: blobPath,
      file_name: fileName,
      content_type: content_type ?? undefined,
      file_size_bytes: file_size_bytes ?? undefined,
    });

    return res.status(201).json({
      attachment_id: attachment.id,
      upload_url: uploadUrl,
      blob_path: blobPath,
      expires_in_minutes: config.azure.sasTtlMinutes,
    });
  } catch (e) {
    console.error('POST /help-requests/:id/attachments/upload-url', e);
    return res.status(500).json({ error: 'Failed to get upload URL' });
  }
});

export const helpRequestsRouter = router;
