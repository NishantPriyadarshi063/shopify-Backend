import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthPayload {
  userId: string;
  email: string;
  type: 'access';
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/** Require valid JWT access token; set req.auth. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' });
    return;
  }
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as AuthPayload & { type?: string };
    if (decoded.type !== 'access') {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid token type' });
      return;
    }
    req.auth = { userId: decoded.userId, email: decoded.email, type: 'access' };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}
