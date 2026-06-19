import type { UserRole } from '@prisma/client';
import jwt from 'jsonwebtoken';

import { AuthService } from '../../services/auth.service';

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  },
}));

describe('AuthService Unit Tests', () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalJwtRefreshSecret = process.env.JWT_REFRESH_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.JWT_REFRESH_SECRET = originalJwtRefreshSecret;
  });

  describe('Password Hashing', () => {
    it('should hash and verify passwords', async () => {
      const password = 'mySecretPassword123';
      const hash = await AuthService.hashPassword(password);

      expect(hash).not.toBe(password);

      const isValid = await AuthService.verifyPassword(password, hash);
      expect(isValid).toBe(true);

      const isInvalid = await AuthService.verifyPassword('wrongpassword', hash);
      expect(isInvalid).toBe(false);
    });
  });

  describe('JWT Tokens', () => {
    const payload = {
      userId: 'user-123',
      email: 'test@example.com',
      role: 'USER' as UserRole,
    };

    it('should generate and verify access tokens', () => {
      const token = AuthService.generateAccessToken(payload);
      expect(typeof token).toBe('string');

      const decoded = AuthService.verifyAccessToken(token);
      expect(decoded.userId).toBe(payload.userId);
      expect(decoded.email).toBe(payload.email);
      expect(decoded.role).toBe(payload.role);
      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();
    });

    it('should generate and verify refresh tokens', () => {
      const token = AuthService.generateRefreshToken(payload);
      expect(typeof token).toBe('string');

      const decoded = AuthService.verifyRefreshToken(token);
      expect(decoded.userId).toBe(payload.userId);
      expect(decoded.email).toBe(payload.email);
      expect(decoded.role).toBe(payload.role);
      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();
    });

    it('tokens should have proper expiration', () => {
      const accessToken = AuthService.generateAccessToken(payload);
      const decodedAccess = jwt.verify(accessToken, process.env.JWT_SECRET!) as jwt.JwtPayload;

      // Access token should expire in 15m (900 seconds)
      const accessDiff = (decodedAccess.exp || 0) - (decodedAccess.iat || 0);
      expect(accessDiff).toBe(900);

      const refreshToken = AuthService.generateRefreshToken(payload);
      const decodedRefresh = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET!
      ) as jwt.JwtPayload;

      // Refresh token should expire in 7d (604800 seconds)
      const refreshDiff = (decodedRefresh.exp || 0) - (decodedRefresh.iat || 0);
      expect(refreshDiff).toBe(604800);
    });
  });
});
