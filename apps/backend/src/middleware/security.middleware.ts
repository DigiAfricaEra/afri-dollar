import type { NextFunction, Response } from 'express';

import { SecurityService, type AuthEndpoint } from '../services/security.service';

import type { AuthRequest } from './auth.middleware';

function toRetryAfterHeader(seconds?: number): string | undefined {
  if (!seconds || seconds <= 0) {
    return undefined;
  }

  return String(Math.max(1, Math.ceil(seconds)));
}

function getRequestIp(req: AuthRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

async function runAuthSecurityMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  endpoint: AuthEndpoint
): Promise<void> {
  try {
    const ip = getRequestIp(req);
    const decision = await SecurityService.evaluateAuthRequest(ip, endpoint);

    res.locals.authSecurityDecision = decision;

    if (!decision.allowed) {
      const retryAfter = toRetryAfterHeader(decision.retryAfterSeconds);
      if (retryAfter) {
        res.setHeader('Retry-After', retryAfter);
      }

      res.status(429).json({
        success: false,
        error: decision.assessment.flagged
          ? 'This IP has been flagged and is temporarily rate-limited'
          : 'Too many authentication requests',
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

async function runAdminSecurityMiddleware(res: Response, next: NextFunction): Promise<void> {
  try {
    res.locals.securityMetrics = await SecurityService.getSecurityMetrics();
    next();
  } catch (error) {
    next(error);
  }
}

export const authSecurityMiddleware = (endpoint: AuthEndpoint) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    void runAuthSecurityMiddleware(req, res, next, endpoint);
  };
};

export const adminSecurityMiddleware = (
  _req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  void runAdminSecurityMiddleware(res, next);
};
