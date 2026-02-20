import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, type AuthPayload } from '../middleware/auth';
import { getMessagesByRequestId, createMessage, type ChatMessageCreate } from '../repositories/chat';
import { getById } from '../repositories/helpRequests';
import { notifyAdminNewMessage, notifyCustomerNewMessage } from '../services/notifications';
import { config } from '../config';

const router = Router();

// Optional auth: if a valid Bearer token is present (header or query for GET/EventSource), populate req.auth.
// Query token is only for GET so EventSource can authenticate (it cannot send headers).
router.use((req, _res, next) => {
  const header = req.headers.authorization;
  let token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && req.method === 'GET' && typeof req.query.token === 'string') {
    token = req.query.token;
  }
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as AuthPayload & { type?: string };
    if (decoded.type === 'access') {
      req.auth = { userId: decoded.userId, email: decoded.email, type: 'access' };
    }
  } catch {
    // ignore invalid token here; route-level checks will handle auth rules
  }
  next();
});

/** GET /chat/:requestId/messages - Get all messages for a request */
router.get('/:requestId/messages', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    
    // Check if request exists
    const request = await getById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Help request not found' });
    }

    // For customers: allow if they provide email query param matching request email
    // For admin: allow if req.auth is set from JWT
    const customerEmail = req.query.email as string | undefined;
    const user = req.auth;

    if (!customerEmail && !user) {
      return res.status(401).json({ error: 'Unauthorized: provide email query param or admin auth' });
    }

    if (customerEmail && customerEmail.toLowerCase() !== request.customer_email.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden: email does not match request' });
    }

    const messages = await getMessagesByRequestId(requestId);
    return res.json(messages);
  } catch (e) {
    console.error('GET /chat/:requestId/messages', e);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/** POST /chat/:requestId/messages - Create a new message */
router.post('/:requestId/messages', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const { body, attachment_blob_url, attachment_blob_path, attachment_file_name, attachment_content_type } = req.body;
    const user = req.auth;
    const customerEmail = req.query.email as string | undefined;

    // Check if request exists
    const request = await getById(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Help request not found' });
    }

    // Determine sender: admin if authenticated, customer if email matches
    let sender: 'customer' | 'admin';
    let senderId: string | null = null;

    if (user) {
      sender = 'admin';
      senderId = user.userId;
    } else if (customerEmail && customerEmail.toLowerCase() === request.customer_email.toLowerCase()) {
      sender = 'customer';
    } else {
      return res.status(401).json({ error: 'Unauthorized: provide email query param or admin auth' });
    }

    if (!body?.trim() && !attachment_blob_url) {
      return res.status(400).json({ error: 'Message body or attachment is required' });
    }

    const messageData: ChatMessageCreate = {
      request_id: requestId,
      sender,
      sender_id: senderId,
      body: body?.trim() || null,
      attachment_blob_url: attachment_blob_url || null,
      attachment_blob_path: attachment_blob_path || null,
      attachment_file_name: attachment_file_name || null,
      attachment_content_type: attachment_content_type || null,
    };

    const message = await createMessage(messageData);

    // Send email notifications (async, don't wait)
    if (sender === 'customer' && body?.trim()) {
      // Notify admin (get admin email from config or fetch from DB)
      const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL || '';
      if (adminEmail) {
        notifyAdminNewMessage(
          adminEmail,
          request.customer_name,
          request.order_number,
          body.trim(),
          requestId
        ).catch((e) => console.error('Failed to notify admin:', e));
      }
    } else if (sender === 'admin' && body?.trim()) {
      // Notify customer
      notifyCustomerNewMessage(
        request.customer_email,
        request.customer_name,
        request.order_number,
        body.trim(),
        requestId
      ).catch((e) => console.error('Failed to notify customer:', e));
    }

    return res.status(201).json(message);
  } catch (e) {
    console.error('POST /chat/:requestId/messages', e);
    return res.status(500).json({ error: 'Failed to create message' });
  }
});

/** GET /chat/:requestId/stream - Server-Sent Events stream for real-time updates */
router.get('/:requestId/stream', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const customerEmail = req.query.email as string | undefined;
    const user = req.auth;

    // Check if request exists
    const request = await getById(requestId);
    if (!request) {
      return res.status(404).end();
    }

    // Verify access
    if (!user && (!customerEmail || customerEmail.toLowerCase() !== request.customer_email.toLowerCase())) {
      return res.status(401).end();
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Poll for new messages every 2 seconds
    let lastMessageId: string | null = null;
    const interval = setInterval(async () => {
      try {
        const messages = await getMessagesByRequestId(requestId);
        const newMessages = lastMessageId
          ? messages.filter((m) => m.id !== lastMessageId && new Date(m.created_at) > new Date())
          : messages.slice(-1); // Send last message on first poll

        for (const msg of newMessages) {
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
          if (!lastMessageId || msg.id > lastMessageId) {
            lastMessageId = msg.id;
          }
        }
      } catch (e) {
        console.error('SSE poll error:', e);
        clearInterval(interval);
        res.end();
      }
    }, 2000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });
  } catch (e) {
    console.error('GET /chat/:requestId/stream', e);
    res.status(500).end();
  }
});

/** Admin-only: GET /chat/:requestId/unread-count - Get unread message count */
router.get('/:requestId/unread-count', requireAuth, async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const { getUnreadCountForAdmin } = await import('../repositories/chat');
    const count = await getUnreadCountForAdmin(requestId);
    return res.json({ unread_count: count });
  } catch (e) {
    console.error('GET /chat/:requestId/unread-count', e);
    return res.status(500).json({ error: 'Failed to get unread count' });
  }
});

export const chatRouter = router;
