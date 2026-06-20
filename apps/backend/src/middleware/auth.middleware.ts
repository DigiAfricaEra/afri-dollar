import type { Request, Response, NextFunction } from 'express';

import { AuthService } from '../services/auth.service';
import { AppError } from '../types';
import type { JwtPayload } from '../types';

/**
 * Role permissions mapping
 * Defines which permissions each role has access to
 */
const ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ['*'], // Full access
  BUSINESS: [
    'wallet:read',
    'wallet:write',
    'transaction:read',
    'transaction:write',
    'payroll:read',
    'payroll:write',
  ],
  USER: ['wallet:read', 'transaction:read'],
  AUDITOR: ['wallet:read', 'transaction:read', 'audit:read'],
};

/**
 * Extended Request interface with user payload
 */
export interface AuthRequest extends Request {
  user?: JwtPayload;
}

/**
 * Auth Middleware (also exported as authenticate)
 * Verifies JWT token and attaches user to request
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

    // Verify token directly using domain mapping strategies inside the service
    const payload = AuthService.verifyAccessToken(token);

    req.user = payload;
    next();
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    res.status(401).json({
      success: false,
      error: 'Invalid or expired access token',
    });
  }
};

// Export authMiddleware as authenticate to match issue #8 requirements
export const authenticate = authMiddleware;

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

/**
 * Role-based access control middleware
 * Checks if the authenticated user has one of the required roles
 * Must run after `authMiddleware` so that `req.user` has been populated
 * @param roles - Array of allowed roles
 */
export const requireRole = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Access token is required',
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
      return;
    }

    next();
  };
};

/**
 * Permission-based access control middleware
 * Checks if the authenticated user has the required permission
 * Must run after `authMiddleware` so that `req.user` has been populated
 * @param permission - The permission string to check
 */
export const requirePermission = (permission: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Access token is required',
      });
      return;
    }

    const userPermissions = ROLE_PERMISSIONS[req.user.role];

    // Log security event for unknown role
    if (!userPermissions) {
      console.error(
        `Security: Unknown role '${req.user.role}' encountered for user ${req.user.userId} requesting permission '${permission}'`
      );
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
      return;
    }

    // Check if user has the required permission
    // Admin has full access via '*' wildcard
    if (!userPermissions.includes('*') && !userPermissions.includes(permission)) {
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
      return;
    }

    next();
  };
};
