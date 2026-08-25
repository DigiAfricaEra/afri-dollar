import type { NextFunction, Response } from 'express';

import { StellarSep10Service } from '../services/stellar-sep10.service';
import { AppError } from '../types';
import { SEP24_ALLOWED_ROLES, type SepJwtPayload } from '../types/sep.types';

import type { AuthRequest } from './auth.middleware';

export interface SepAuthRequest extends AuthRequest {
  sep?: SepJwtPayload;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function sepAuthMiddleware(req: SepAuthRequest, res: Response, next: NextFunction): void {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({
        success: false,
        error: 'SEP-10 token is required',
      });
      return;
    }

    req.sep = StellarSep10Service.verifySepJwt(token);
    next();
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    res.status(401).json({
      success: false,
      error: 'Invalid or expired SEP-10 token',
    });
  }
}

export function optionalSepAuthMiddleware(
  req: SepAuthRequest,
  _res: Response,
  next: NextFunction
): void {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (token) {
      req.sep = StellarSep10Service.verifySepJwt(token);
    }
  } catch {
    // Optional auth: ignore invalid tokens and continue unauthenticated.
  }
  next();
}

export function requireSepRole(req: SepAuthRequest, res: Response, next: NextFunction): void {
  if (!req.sep) {
    res.status(401).json({
      success: false,
      error: 'SEP-10 token is required',
    });
    return;
  }

  if (!req.sep.role || !SEP24_ALLOWED_ROLES.includes(req.sep.role)) {
    res.status(403).json({
      success: false,
      error: 'Insufficient permissions',
    });
    return;
  }

  next();
}
