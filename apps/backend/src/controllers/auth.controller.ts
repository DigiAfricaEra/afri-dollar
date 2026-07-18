/**
 * Auth Controller
 * Handles authentication-related HTTP requests
 */
import { Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { AuthService } from '../services/auth.service';
import { SecurityService } from '../services/security.service';
import { InvalidCredentialsError } from '../types';
import type {
  RegisterRequest,
  LoginRequest,
  RefreshTokenRequest,
  AuthResponse,
  TokenRefreshResponse,
  UserResponse,
} from '../types';
import { getRequestIp, handleError } from '../utils';

function getUserAgent(headers: AuthRequest['headers']): string | undefined {
  const userAgent = headers['user-agent'];
  return typeof userAgent === 'string' ? userAgent : undefined;
}

export const AuthController = {
  /**
   * Register a new user
   */
  async register(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedData = req.body as RegisterRequest;
      const deviceInfo = getUserAgent(req.headers);

      const result = await AuthService.register(validatedData, deviceInfo);

      AuthService.createAuditLog({
        userId: result.user.id,
        action: 'register',
        resource: 'user',
        resourceId: result.user.id,
        ipAddress: req.ip,
        userAgent: deviceInfo,
        success: true,
      }).catch((err) => console.error('Failed to log audit register success:', err));

      const response: AuthResponse = {
        success: true,
        data: result,
      };
      res.status(201).json(response);
    } catch (error) {
      if (error instanceof Error) {
        void AuthService.createAuditLog({
          action: 'register',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: getUserAgent(req.headers),
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
      const deviceInfo = getUserAgent(req.headers);

      const result = await AuthService.login(validatedData, deviceInfo);
      await SecurityService.clearFailedAttempts(getRequestIp(req));

      AuthService.createAuditLog({
        userId: result.user.id,
        action: 'login',
        resource: 'user',
        resourceId: result.user.id,
        ipAddress: req.ip,
        userAgent: deviceInfo,
        success: true,
      }).catch((err) => console.error('Failed to log audit login success:', err));

      const response: AuthResponse = {
        success: true,
        data: result,
      };
      res.status(200).json(response);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        const failedAttempt = await SecurityService.recordFailedAttempt({
          ip: getRequestIp(req),
        });

        AuthService.createAuditLog({
          action: 'login',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: getUserAgent(req.headers),
          success: false,
          metadata: {
            error: error.message,
            attempts: failedAttempt.record.attempts,
            riskScore: failedAttempt.assessment.riskScore,
            flagged: failedAttempt.assessment.flagged,
            delayMs: failedAttempt.delayMs,
            blockedUntil: failedAttempt.blockedUntil?.toISOString(),
          },
        }).catch((err) => console.error('Failed to log audit login failure:', err));

        if (failedAttempt.blockedUntil || failedAttempt.delayMs > 0) {
          const retryAfterSeconds = failedAttempt.blockedUntil
            ? Math.ceil((failedAttempt.blockedUntil.getTime() - Date.now()) / 1000)
            : Math.max(1, Math.ceil(failedAttempt.delayMs / 1000));

          res.setHeader('Retry-After', String(retryAfterSeconds));
          res.status(429).json({
            success: false,
            error: 'Too many failed login attempts. Please try again later.',
            retryAfterSeconds,
          });
          return;
        }
      } else if (error instanceof Error) {
        AuthService.createAuditLog({
          action: 'login',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: getUserAgent(req.headers),
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit login failure:', err));
      }
      handleError(res, error);
    }
  },

  /**
   * Logout a user (device or all-device).
   * Pass `allDevices: true` in the request body to revoke all sessions.
   */
  async logout(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { refreshToken, allDevices } = req.body as RefreshTokenRequest & {
        allDevices?: boolean;
      };

      if (!req.user) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      await AuthService.logout(refreshToken, req.user.userId, allDevices === true);

      AuthService.createAuditLog({
        userId: req.user.userId,
        action: allDevices ? 'logout_all_devices' : 'logout',
        resource: 'user',
        resourceId: req.user.userId,
        ipAddress: req.ip,
        userAgent: getUserAgent(req.headers),
        success: true,
      }).catch((err) => console.error('Failed to log audit logout success:', err));

      res.status(200).json({
        success: true,
        message: allDevices ? 'Logged out from all devices' : 'Logged out successfully',
      });
    } catch (error) {
      if (req.user && error instanceof Error) {
        AuthService.createAuditLog({
          userId: req.user.userId,
          action: 'logout',
          resource: 'user',
          ipAddress: req.ip,
          userAgent: getUserAgent(req.headers),
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit logout failure:', err));
      }
      handleError(res, error);
    }
  },

  /**
   * Refresh access token (issues rotated token pair)
   */
  async refresh(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedData = req.body as RefreshTokenRequest;

      const result = await AuthService.refreshAccessToken(validatedData.refreshToken);

      AuthService.createAuditLog({
        userId: result.userId,
        action: 'refresh',
        resource: 'token',
        ipAddress: req.ip,
        userAgent: getUserAgent(req.headers),
        success: true,
      }).catch((err) => console.error('Failed to log audit token refresh success:', err));

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
          userAgent: getUserAgent(req.headers),
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

      const user = await AuthService.getCurrentUser(req.user.userId);

      AuthService.createAuditLog({
        userId: user.id,
        action: 'me',
        resource: 'user',
        resourceId: user.id,
        ipAddress: req.ip,
        userAgent: getUserAgent(req.headers),
        success: true,
      }).catch((err) => console.error('Failed to log audit get profile success:', err));

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
          userAgent: getUserAgent(req.headers),
          success: false,
          metadata: { error: error.message },
        }).catch((err) => console.error('Failed to log audit get profile failure:', err));
      }
      handleError(res, error);
    }
  },
};
