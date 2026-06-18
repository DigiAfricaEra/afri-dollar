import type { Request, Response, NextFunction } from 'express';

import { AuthService } from '../services/auth.service';
import type { JwtPayload } from '../types';

/**
 * Extended Request interface with user payload
 */
export interface AuthRequest extends Request {
  user?: JwtPayload;
}

/**
 * Auth Middleware
 * Handles authentication and authorization for routes
 */
export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction): void => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Access token is required',
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify token
    const payload = AuthService.verifyAccessToken(token);

    // Attach user payload to request
    req.user = payload;

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired access token',
    });
  }
};

/**
 * Admin Middleware
 * Restricts a route to users with the ADMIN role. Must run after `authMiddleware`
 * so that `req.user` has been populated from a verified access token.
 */
export const adminMiddleware = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Access token is required',
    });
    return;
  }

  if (req.user.role !== 'ADMIN') {
    res.status(403).json({
      success: false,
      error: 'Admin privileges required',
    });
    return;
  }

  next();
};
