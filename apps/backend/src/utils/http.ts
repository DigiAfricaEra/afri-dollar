import type { Request, Response } from 'express';

import { AppError } from '../types';

/**
 * Handles error mapping for Express controllers to avoid duplicate error handling logic
 */
export function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }

  if (error instanceof Error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
    return;
  }

  res.status(500).json({ success: false, error: 'An unknown error occurred' });
}

/**
 * Extracts the client IP address from an Express request object
 */
export function getRequestIp(
  req: Request | { ip?: string; socket?: { remoteAddress?: string } }
): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
