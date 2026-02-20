import { config } from '../config';

export type ShopifyLineItem = {
  id: number;
  quantity: number;
  price: string;
  title: string;
  variant_title?: string;
  sku?: string;
};

export type ShopifyOrder = {
  id: number;
  name: string; // "#1001"
  email?: string;
  created_at: string;
  currency: string;
  total_price: string;
  financial_status?: string;
  fulfillment_status?: string;
  line_items: ShopifyLineItem[];
  transactions?: Array<{
    id: number;
    kind: string;
    status: string;
    gateway?: string;
    amount: string;
    currency?: string;
  }>;
};

function shopifyBaseUrl(): string {
  return `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}`;
}

function shopifyHeaders(): Record<string, string> {
  return {
    'X-Shopify-Access-Token': config.shopify.accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export function buildShopifyAdminOrderUrl(orderId: number): string {
  return `https://${config.shopify.shopDomain}/admin/orders/${orderId}`;
}

export async function findOrderByName(orderNumber: string): Promise<ShopifyOrder | null> {
  const normalized = orderNumber.replace(/^#/, '').trim();
  const name = `#${normalized}`;

  const url = `${shopifyBaseUrl()}/orders.json?name=${encodeURIComponent(name)}&status=any&limit=1`;
  const res = await fetch(url, { headers: shopifyHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shopify order lookup failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { orders?: ShopifyOrder[] };
  const order = data.orders?.[0];
  return order ?? null;
}

export async function getOrder(orderId: number): Promise<ShopifyOrder> {
  const url = `${shopifyBaseUrl()}/orders/${orderId}.json?status=any`;
  const res = await fetch(url, { headers: shopifyHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shopify get order failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { order: ShopifyOrder };
  return data.order;
}

export async function cancelOrder(orderId: number, reason = 'customer'): Promise<void> {
  const url = `${shopifyBaseUrl()}/orders/${orderId}/cancel.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: shopifyHeaders(),
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      const json = JSON.parse(text) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      // use raw text
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}

type RefundLineItemInput = { line_item_id: number; quantity: number; restock_type?: string };

async function executeRefund(
  orderId: number,
  order: ShopifyOrder,
  refundLineItems: RefundLineItemInput[],
  note?: string,
  manualRefundAmount?: number
): Promise<void> {
  const calcUrl = `${shopifyBaseUrl()}/orders/${orderId}/refunds/calculate.json`;
  const calcRes = await fetch(calcUrl, {
    method: 'POST',
    headers: shopifyHeaders(),
    body: JSON.stringify({
      refund: {
        currency: order.currency,
        refund_line_items: refundLineItems,
        note: note ?? 'Refund initiated from Tilting Heads Help Centre',
      },
    }),
  });

  if (!calcRes.ok) {
    const text = await calcRes.text().catch(() => '');
    throw parseShopifyError(text, calcRes.status);
  }

  const calcData = (await calcRes.json()) as {
    refund?: {
      currency?: string;
      refund_line_items?: unknown[];
      transactions?: Array<{ parent_id?: number; amount?: string; gateway?: string; kind?: string }>;
      [k: string]: unknown;
    };
  };
  const refundPayload = calcData.refund;
  if (!refundPayload) {
    throw new Error('Shopify refund calculate returned no refund payload');
  }

  let transactions = Array.isArray(refundPayload.transactions)
    ? refundPayload.transactions
        .filter((t) => t.parent_id != null && t.amount != null && t.gateway != null)
        .map((t) => ({
          parent_id: t.parent_id!,
          amount: t.amount!,
          kind: 'refund' as const,
          gateway: t.gateway!,
        }))
    : [];

  if (manualRefundAmount != null && manualRefundAmount > 0 && transactions.length > 0) {
    const suggestedTotal = transactions.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    if (suggestedTotal > 0 && Math.abs(manualRefundAmount - suggestedTotal) > 0.001) {
      const scale = manualRefundAmount / suggestedTotal;
      const scaled = transactions.map((t, i) => {
        const amt = parseFloat(t.amount) * scale;
        const rounded = Math.round(amt * 100) / 100;
        return { ...t, amount: String(rounded.toFixed(2)) };
      });
      const newTotal = scaled.reduce((sum, t) => sum + parseFloat(t.amount), 0);
      const diff = Math.round((manualRefundAmount - newTotal) * 100) / 100;
      if (diff !== 0 && scaled[0]) {
        const first = parseFloat(scaled[0].amount) + diff;
        scaled[0] = { ...scaled[0], amount: Math.max(0, first).toFixed(2) };
      }
      transactions = scaled;
    }
  }

  const createRefund = {
    ...refundPayload,
    note: note ?? refundPayload.note ?? 'Refund initiated from Tilting Heads Help Centre',
    transactions: transactions.length > 0 ? transactions : undefined,
  };
  delete (createRefund as Record<string, unknown>).id;
  delete (createRefund as Record<string, unknown>).order_id;
  delete (createRefund as Record<string, unknown>).created_at;
  delete (createRefund as Record<string, unknown>).processed_at;

  const createUrl = `${shopifyBaseUrl()}/orders/${orderId}/refunds.json`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: shopifyHeaders(),
    body: JSON.stringify({ refund: createRefund }),
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    throw parseShopifyError(text, createRes.status);
  }
}

/**
 * Full refund: all line items, no restock.
 * Optional manualRefundAmount overrides the calculated total.
 */
export async function refundFullOrder(
  orderId: number,
  note?: string,
  manualRefundAmount?: number
): Promise<void> {
  const order = await getOrder(orderId);
  const refundLineItems = order.line_items.map((li) => ({
    line_item_id: li.id,
    quantity: li.quantity,
    restock_type: 'no_restock',
  }));
  await executeRefund(orderId, order, refundLineItems, note, manualRefundAmount);
}

/**
 * Partial refund: only the given line items and quantities.
 * restockType: 'no_restock' | 'return' | 'cancel'
 * Optional manualRefundAmount overrides the calculated total.
 */
export async function refundPartialOrder(
  orderId: number,
  refundLineItems: Array<{ lineItemId: number; quantity: number }>,
  options?: { restockType?: string; note?: string; manualRefundAmount?: number }
): Promise<void> {
  if (refundLineItems.length === 0) {
    throw new Error('At least one line item with quantity > 0 is required');
  }
  const order = await getOrder(orderId);
  const restockType = options?.restockType ?? 'no_restock';
  const byId = new Map(order.line_items.map((li) => [li.id, li]));
  const items: RefundLineItemInput[] = [];
  for (const { lineItemId, quantity } of refundLineItems) {
    if (quantity <= 0) continue;
    const li = byId.get(lineItemId);
    if (!li) throw new Error(`Line item ${lineItemId} not found in order`);
    const qty = Math.min(quantity, li.quantity);
    if (qty > 0) {
      items.push({ line_item_id: lineItemId, quantity: qty, restock_type: restockType });
    }
  }
  if (items.length === 0) {
    throw new Error('At least one line item with quantity > 0 is required');
  }
  await executeRefund(orderId, order, items, options?.note, options?.manualRefundAmount);
}

function parseShopifyError(text: string, status: number): Error & { status?: number } {
  let message = text;
  try {
    const json = JSON.parse(text) as { error?: string; errors?: Record<string, string[]> };
    if (json.error) message = json.error;
    else if (json.errors?.base?.length) message = json.errors.base.join(' ');
    else if (typeof json.errors === 'object' && json.errors !== null) {
      const parts = Object.entries(json.errors).flatMap(([k, v]) => (Array.isArray(v) ? v : [String(v)]));
      if (parts.length) message = parts.join(' ');
    }
  } catch {
    // use raw text
  }
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

