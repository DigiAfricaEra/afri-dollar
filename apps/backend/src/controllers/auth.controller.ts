/**
 * Auth Controller
 * Handles authentication-related HTTP requests
 */
import { Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';
import { AppError } from '../types';
import type {
  RegisterRequest,
  LoginRequest,
  RefreshTokenRequest,
  AuthResponse,
  TokenRefreshResponse,
  UserResponse,
} from '../types';

/**
 * Handles error mapping to avoid dense walls of string checks
 */
function handleError(res: Response, error: unknown): void {
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

export const AuthController = {
  /**
   * Register a new user
   */
  async register(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedData = req.body as RegisterRequest;

      // Register user
      const result = await AuthService.register(validatedData);

      // Create audit log safely backgrounded
      AuthService.createAuditLog({
        userId: result.user.id,
        action: 'register',
        resource: 'user',
        resourceId: result.user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        success: true,
      }).catch((err) => console.error('Failed to log audit register success:', err));

      // Send response
      const response: AuthResponse = {
        success: true,
        data: result,
      };
      res.status(201).json(response);
    } catch (error) {
      if (error instanceof Error) {
        // Create audit log for failed registration (non-blocking)
        void AuthService.createAuditLog({
          action: 'register',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit register failure:', err));
      }
      handleError(res, error);
    }
  },

  /**
   * Login a user
   */
  async login(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedData = req.body as LoginRequest;

      // Login user
      const result = await AuthService.login(validatedData);

      // Create audit log safely backgrounded
      AuthService.createAuditLog({
        userId: result.user.id,
        action: 'login',
        resource: 'user',
        resourceId: result.user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        success: true,
      }).catch((err) => console.error('Failed to log audit login success:', err));

      // Send response
      const response: AuthResponse = {
        success: true,
        data: result,
      };
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof Error) {
        AuthService.createAuditLog({
          action: 'login',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit login failure:', err));
      }
      handleError(res, error);
    }
  },

  /**
   * Logout a user
   */
  async logout(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedData = req.body as RefreshTokenRequest;

      if (!req.user) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Logout user (invalidate refresh token)
      await AuthService.logout(validatedData.refreshToken, req.user.userId);

      // Create audit log safely backgrounded
      AuthService.createAuditLog({
        userId: req.user.userId,
        action: 'logout',
        resource: 'user',
        resourceId: req.user.userId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        success: true,
      }).catch((err) => console.error('Failed to log audit logout success:', err));

      res.status(200).json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      if (req.user && error instanceof Error) {
        AuthService.createAuditLog({
          userId: req.user.userId,
          action: 'logout',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit logout failure:', err));
      }
      handleError(res, error);
    }
  },

  /**
   * Refresh access token
   */
  async refresh(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedData = req.body as RefreshTokenRequest;

      // Refresh access token and pull verified userId back
      const result = await AuthService.refreshAccessToken(validatedData.refreshToken);

      // Create audit log with extracted userId context safely backgrounded
      AuthService.createAuditLog({
        userId: result.userId,
        action: 'refresh',
        resource: 'token',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        success: true,
      }).catch((err) => console.error('Failed to log audit token refresh success:', err));

      // Send response without structural pollution
      const response: TokenRefreshResponse = {
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
      };
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof Error) {
        AuthService.createAuditLog({
          action: 'refresh',
          resource: 'token',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit token refresh failure:', err));
      }
      handleError(res, error);
    }
  },

  /**
   * Get current user
   */
  async me(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      // Get current user
      const user = await AuthService.getCurrentUser(req.user.userId);

      // Create audit log safely backgrounded
      AuthService.createAuditLog({
        userId: user.id,
        action: 'me',
        resource: 'user',
        resourceId: user.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        success: true,
      }).catch((err) => console.error('Failed to log audit get profile success:', err));

      // Send response
      const response: UserResponse = {
        success: true,
        data: user,
      };
      res.status(200).json(response);
    } catch (error) {
      if (req.user && error instanceof Error) {
        AuthService.createAuditLog({
          userId: req.user.userId,
          action: 'me',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit get profile failure:', err));
      }
      handleError(res, error);
    }
  },
};
