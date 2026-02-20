import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { getPool } from './db/client';
import { helpRequestsRouter } from './routes/helpRequests';
import { authRouter } from './routes/auth';
import { chatRouter } from './routes/chat';
import { helpRequestsRateLimit, chatRateLimit } from './middleware/rateLimit';

const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'shopify-help-backend' });
});

app.get('/health/db', async (_req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// Auth (public)
app.use('/api/auth', authRouter);

// Help requests: rate-limited; create, check, upload-url = public; list, get one, patch = admin (requireAuth)
app.use('/api/help-requests', helpRequestsRateLimit, helpRequestsRouter);

// Chat: rate-limited; public with email param or admin auth
app.use('/api/chat', chatRateLimit, chatRouter);

const server = app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});

export { app, server };
