import { Router } from 'express';

import { AuthController } from '../controllers/auth.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { loginSchema, registerSchema, refreshTokenSchema } from '../utils/validation';

/**
 * Auth Routes
 * Defines authentication-related API endpoints
 */
const authRouter = Router();

/**
 * POST /api/v1/auth/register
 * Register a new user
 * Request body: { email: string, password: string, firstName?: string, lastName?: string, phoneNumber?: string }
 * Response: { success: boolean, data: { user: User, tokens: AuthTokens } }
 */
authRouter.post('/register', validate(registerSchema), (req, res, next) => {
  AuthController.register(req, res).catch(next);
});

/**
 * POST /api/v1/auth/login
 * Login a user
 * Request body: { email: string, password: string }
 * Response: { success: boolean, data: { user: User, tokens: AuthTokens } }
 */
authRouter.post('/login', validate(loginSchema), (req, res, next) => {
  AuthController.login(req, res).catch(next);
});

/**
 * POST /api/v1/auth/logout
 * Logout a user (requires valid JWT)
 * Invalidates refresh token
 */
authRouter.post('/logout', authMiddleware, validate(refreshTokenSchema), (req, res, next) => {
  AuthController.logout(req, res).catch(next);
});

/**
 * POST /api/v1/auth/refresh
 * Refresh access token
 * Request body: { refreshToken: string }
 * Response: { success: boolean, data: { accessToken: string, refreshToken: string } }
 */
authRouter.post('/refresh', validate(refreshTokenSchema), (req, res, next) => {
  AuthController.refresh(req, res).catch(next);
});

/**
 * GET /api/v1/auth/me
 * Get current user information (requires valid JWT)
 */
authRouter.get('/me', authMiddleware, (req, res, next) => {
  AuthController.me(req, res).catch(next);
});

export default authRouter;
