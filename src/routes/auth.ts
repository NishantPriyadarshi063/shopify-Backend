import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import {
  findAdminByEmail,
  verifyPassword,
  createRefreshToken,
  findRefreshToken,
  revokeRefreshToken,
  hashRefreshToken,
} from '../repositories/auth';
import type { AuthPayload } from '../middleware/auth';

const router = Router();

const refreshExpiresMs = parseExpiresIn(config.jwt.refreshExpiresIn);

function parseExpiresIn(s: string): number {
  const match = s.match(/^(\d+)(d|h|m)$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000; // 30 days default
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'd') return num * 24 * 60 * 60 * 1000;
  if (unit === 'h') return num * 60 * 60 * 1000;
  if (unit === 'm') return num * 60 * 1000;
  return num * 24 * 60 * 60 * 1000;
}

/** POST /auth/login - email, password -> accessToken, refreshToken */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await findAdminByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const payload: AuthPayload = {
      userId: user.id,
      email: user.email,
      type: 'access',
    };
    const accessToken = jwt.sign(
      payload,
      config.jwt.secret as jwt.Secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    const refreshToken = crypto.randomBytes(32).toString('hex');
    const refreshHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + refreshExpiresMs);
    await createRefreshToken(user.id, refreshHash, expiresAt);

    return res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: config.jwt.expiresIn,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (e) {
    console.error('POST /auth/login', e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

/** POST /auth/refresh - refreshToken -> new accessToken */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body as { refresh_token?: string };
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }

    const hash = hashRefreshToken(refresh_token);
    const tokenData = await findRefreshToken(hash);
    if (!tokenData) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const payload: AuthPayload = {
      userId: tokenData.user_id,
      email: tokenData.email,
      type: 'access',
    };
    const accessToken = jwt.sign(
      payload,
      config.jwt.secret as jwt.Secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );

    return res.json({
      access_token: accessToken,
      expires_in: config.jwt.expiresIn,
    });
  } catch (e) {
    console.error('POST /auth/refresh', e);
    return res.status(500).json({ error: 'Refresh failed' });
  }
});

/** POST /auth/logout - revoke refresh token */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body as { refresh_token?: string };
    if (refresh_token) {
      const hash = hashRefreshToken(refresh_token);
      await revokeRefreshToken(hash);
    }
    return res.json({ message: 'Logged out' });
  } catch (e) {
    console.error('POST /auth/logout', e);
    return res.status(500).json({ error: 'Logout failed' });
  }
});

export const authRouter = router;
