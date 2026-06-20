import { createHash } from 'crypto';

import { hash, compare } from 'bcrypt';
import { addDays } from 'date-fns';
import { sign, verify } from 'jsonwebtoken';

import prisma from '../config/database';
import { AppError } from '../types';
import type { RegisterRequest, TokenRefreshData, LoginRequest, JwtPayload } from '../types';

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

function validateJwtSecrets(): void {
  if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
    throw new AppError(500, 'Server configuration error');
  }
}

export const AuthService = {
  async hashPassword(password: string): Promise<string> {
    return hash(password, SALT_ROUNDS);
  },

  async verifyPassword(password: string, hashStr: string): Promise<boolean> {
    return compare(password, hashStr);
  },

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  },

  generateAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    validateJwtSecrets();
    return sign(payload, process.env.JWT_SECRET!, {
      expiresIn: ACCESS_TOKEN_EXPIRY,
    });
  },

  generateRefreshToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    validateJwtSecrets();
    return sign(payload, process.env.JWT_REFRESH_SECRET!, {
      expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d`,
    });
  },

  verifyAccessToken(token: string): JwtPayload {
    validateJwtSecrets();
    try {
      return verify(token, process.env.JWT_SECRET!) as JwtPayload;
    } catch {
      throw new AppError(401, 'Invalid or expired access token');
    }
  },

  verifyRefreshToken(token: string): JwtPayload {
    validateJwtSecrets();
    try {
      return verify(token, process.env.JWT_REFRESH_SECRET!) as JwtPayload;
    } catch {
      throw new AppError(401, 'Invalid refresh token');
    }
  },

  async register(data: RegisterRequest, deviceInfo?: string) {
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new AppError(400, 'Email already registered');
    }

    if (data.phoneNumber) {
      const existingPhone = await prisma.user.findUnique({
        where: { phoneNumber: data.phoneNumber },
      });

      if (existingPhone) {
        throw new AppError(400, 'Phone number already registered');
      }
    }

    const hashedPassword = await this.hashPassword(data.password);

    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash: hashedPassword,
        firstName: data.firstName,
        lastName: data.lastName,
        phoneNumber: data.phoneNumber,
      },
    });

    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = this.generateAccessToken(jwtPayload);
    const refreshToken = this.generateRefreshToken(jwtPayload);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashRefreshToken(refreshToken),
        deviceInfo: deviceInfo ?? null,
        expiresAt: addDays(new Date(), REFRESH_TOKEN_EXPIRY_DAYS),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _pw, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      tokens: { accessToken, refreshToken },
    };
  },

  async login(data: LoginRequest, deviceInfo?: string) {
    const user = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (!user || !user.passwordHash) {
      throw new AppError(401, 'Invalid credentials');
    }

    const isPasswordValid = await this.verifyPassword(data.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError(401, 'Invalid credentials');
    }

    if (!user.isActive) {
      throw new AppError(403, 'Account is inactive');
    }

    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    const accessToken = this.generateAccessToken(jwtPayload);
    const refreshToken = this.generateRefreshToken(jwtPayload);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashRefreshToken(refreshToken),
        deviceInfo: deviceInfo ?? null,
        expiresAt: addDays(new Date(), REFRESH_TOKEN_EXPIRY_DAYS),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _pw, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      tokens: { accessToken, refreshToken },
    };
  },

  async refreshAccessToken(refreshToken: string): Promise<TokenRefreshData> {
    const payload = this.verifyRefreshToken(refreshToken);
    const tokenHash = this.hashRefreshToken(refreshToken);

    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    // Reuse detection: revoked token re-used — potential theft; revoke all active sessions
    if (tokenRecord && tokenRecord.isRevoked) {
      await prisma.refreshToken.updateMany({
        where: { userId: tokenRecord.userId, isRevoked: false },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      throw new AppError(401, 'Refresh token reuse detected. All sessions have been revoked.');
    }

    // Token not found in DB (was never issued or already cleaned up)
    if (!tokenRecord) {
      // We still have the payload from JWT verification, so we can revoke all tokens
      // for the user as a precautionary measure against token theft
      await prisma.refreshToken.updateMany({
        where: { userId: payload.userId, isRevoked: false },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      throw new AppError(401, 'Invalid refresh token. All sessions have been revoked.');
    }

    if (tokenRecord.expiresAt < new Date()) {
      throw new AppError(401, 'Refresh token has expired');
    }

    if (!tokenRecord.user.isActive) {
      throw new AppError(403, 'Account is inactive');
    }

    // Rotate: revoke the current token
    await prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: { isRevoked: true, revokedAt: new Date() },
    });

    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: payload.userId,
      email: payload.email,
      role: tokenRecord.user.role,
    };

    const accessToken = this.generateAccessToken(jwtPayload);
    const newRefreshToken = this.generateRefreshToken(jwtPayload);

    // Issue new token preserving device association
    await prisma.refreshToken.create({
      data: {
        userId: tokenRecord.userId,
        tokenHash: this.hashRefreshToken(newRefreshToken),
        deviceInfo: tokenRecord.deviceInfo,
        expiresAt: addDays(new Date(), REFRESH_TOKEN_EXPIRY_DAYS),
      },
    });

    return { accessToken, refreshToken: newRefreshToken, userId: tokenRecord.userId };
  },

  /**
   * Revoke a single refresh token (device logout).
   * If revokeAllDevices is true, all tokens for the user are revoked.
   */
  async logout(refreshToken: string, userId: string, revokeAllDevices = false): Promise<void> {
    const tokenHash = this.hashRefreshToken(refreshToken);

    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (tokenRecord && tokenRecord.userId !== userId) {
      throw new AppError(401, 'Invalid refresh token');
    }

    if (revokeAllDevices) {
      await prisma.refreshToken.updateMany({
        where: { userId, isRevoked: false },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      return;
    }

    if (tokenRecord && !tokenRecord.isRevoked) {
      await prisma.refreshToken.update({
        where: { id: tokenRecord.id },
        data: { isRevoked: true, revokedAt: new Date() },
      });
    }
  },

  async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _pw, ...userWithoutPassword } = user;

    return userWithoutPassword;
  },

  async createAuditLog(data: {
    action: string;
    resource: string;
    userId?: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
    success?: boolean;
  }): Promise<void> {
    const { metadata, ...rest } = data;
    await prisma.auditLog.create({
      data: {
        ...rest,
        metadata: metadata as any,
      },
    });
  },
};
