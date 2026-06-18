import { createHash } from 'crypto';

import { User, Prisma } from '@prisma/client';
import { hash, compare } from 'bcrypt';
import { addDays } from 'date-fns';
import { sign, verify } from 'jsonwebtoken';

/**
 * Auth Service
 * Contains business logic for authentication
 */
import prisma from '../config/database';
import { AppError } from '../types';
import type {
  AuthTokens,
  RegisterRequest,
  TokenRefreshData,
  LoginRequest,
  JwtPayload,
} from '../types';

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/**
 * Validate JWT secrets are present
 */
function validateJwtSecrets(): void {
  if (!process.env.JWT_SECRET) {
    throw new AppError(500, 'Server configuration error');
  }
  if (!process.env.JWT_REFRESH_SECRET) {
    throw new AppError(500, 'Server configuration error');
  }
}

export const AuthService = {
  /**
   * Hash a password using bcrypt
   */
  async hashPassword(password: string): Promise<string> {
    return hash(password, SALT_ROUNDS);
  },

  /**
   * Verify a password against a hash
   */
  async verifyPassword(password: string, hashStr: string): Promise<boolean> {
    return compare(password, hashStr);
  },

  /**
   * Hash a refresh token using SHA-256
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  },

  /**
   * Generate JWT access token
   */
  generateAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    validateJwtSecrets();
    return sign(payload, process.env.JWT_SECRET!, {
      expiresIn: ACCESS_TOKEN_EXPIRY,
    });
  },

  /**
   * Generate JWT refresh token
   */
  generateRefreshToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    validateJwtSecrets();
    return sign(payload, process.env.JWT_REFRESH_SECRET!, {
      expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d`,
    });
  },

  /**
   * Verify JWT access token
   */
  verifyAccessToken(token: string): JwtPayload {
    validateJwtSecrets();
    try {
      return verify(token, process.env.JWT_SECRET!) as JwtPayload;
    } catch {
      throw new AppError(401, 'Invalid or expired access token');
    }
  },

  /**
   * Verify JWT refresh token
   */
  verifyRefreshToken(token: string): JwtPayload {
    validateJwtSecrets();
    try {
      return verify(token, process.env.JWT_REFRESH_SECRET!) as JwtPayload;
    } catch {
      throw new AppError(401, 'Invalid refresh token');
    }
  },

  /**
   * Register a new user
   */
  async register(
    data: RegisterRequest
  ): Promise<{ user: Omit<User, 'passwordHash'>; tokens: AuthTokens }> {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (existingUser) {
      throw new AppError(400, 'Email already registered');
    }

    // Check if phone number already exists
    if (data.phoneNumber) {
      const existingPhone = await prisma.user.findUnique({
        where: { phoneNumber: data.phoneNumber },
      });

      if (existingPhone) {
        throw new AppError(400, 'Phone number already registered');
      }
    }

    // Hash password
    const passwordHash = await this.hashPassword(data.password);

    // Create user
    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        phoneNumber: data.phoneNumber,
      },
    });

    // Generate tokens (Using runtime type assertion fallback)
    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email,
      role: (user as any).role || 'USER',
    };

    const accessToken = this.generateAccessToken(jwtPayload);
    const refreshToken = this.generateRefreshToken(jwtPayload);

    // Store refresh token hash in database
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashRefreshToken(refreshToken),
        expiresAt: addDays(new Date(), REFRESH_TOKEN_EXPIRY_DAYS),
      },
    });

    // Remove passwordHash from user object before returning
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      tokens: { accessToken, refreshToken },
    };
  },

  /**
   * Login a user
   */
  async login(
    data: LoginRequest
  ): Promise<{ user: Omit<User, 'passwordHash'>; tokens: AuthTokens }> {
    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (!user || !user.passwordHash) {
      throw new AppError(401, 'Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await this.verifyPassword(data.password, user.passwordHash);

    if (!isPasswordValid) {
      throw new AppError(401, 'Invalid credentials');
    }

    // Check if user is active
    if (!user.isActive) {
      throw new AppError(403, 'Account is inactive');
    }

    // Fixed: Added safe runtime mapping fallback to match JwtPayload specifications
    const jwtPayload: JwtPayload = {
      userId: user.id,
      email: user.email,
      role: (user as any).role || 'USER',
    };

    const accessToken = this.generateAccessToken(jwtPayload);
    const refreshToken = this.generateRefreshToken(jwtPayload);

    // Store refresh token hash in database
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashRefreshToken(refreshToken),
        expiresAt: addDays(new Date(), REFRESH_TOKEN_EXPIRY_DAYS),
      },
    });

    // Remove passwordHash from user object before returning
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      tokens: { accessToken, refreshToken },
    };
  },

  /**
   * Refresh access token with token rotation and active breach defense
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenRefreshData> {
    const payload = this.verifyRefreshToken(refreshToken);

    // Hash the token to check in database
    const tokenHash = this.hashRefreshToken(refreshToken);

    // Check if refresh token exists in database and is not revoked
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (tokenRecord && tokenRecord.isRevoked) {
      await prisma.refreshToken.updateMany({
        where: { userId: tokenRecord.userId },
        data: { isRevoked: true, revokedAt: new Date() },
      });
      throw new AppError(401, 'Refresh token has been revoked');
    }

    if (!tokenRecord) {
      throw new AppError(401, 'Invalid refresh token');
    }

    if (tokenRecord.expiresAt < new Date()) {
      throw new AppError(401, 'Refresh token has expired');
    }

    // Check if user is active
    if (!tokenRecord.user.isActive) {
      throw new AppError(403, 'Account is inactive');
    }

    // Revoke old refresh token
    await prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });

    // Fixed: Added safe runtime fallback for relation map users
    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: payload.userId,
      email: payload.email,
      role: (tokenRecord.user as any).role || 'USER',
    };

    const accessToken = this.generateAccessToken(jwtPayload);
    const newRefreshToken = this.generateRefreshToken(jwtPayload);

    // Store new refresh token hash in database
    await prisma.refreshToken.create({
      data: {
        userId: tokenRecord.userId,
        tokenHash: this.hashRefreshToken(newRefreshToken),
        expiresAt: addDays(new Date(), REFRESH_TOKEN_EXPIRY_DAYS),
      },
    });

    return { accessToken, refreshToken: newRefreshToken, userId: tokenRecord.userId };
  },

  /**
   * Logout a user (invalidate refresh token)
   */
  async logout(refreshToken: string, userId: string): Promise<void> {
    // Hash the token to check in database
    const tokenHash = this.hashRefreshToken(refreshToken);

    // Find and revoke the refresh token, ensuring it belongs to the user
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (tokenRecord) {
      // Verify the token belongs to the user making the request
      if (tokenRecord.userId !== userId) {
        throw new AppError(401, 'Invalid refresh token');
      }

      await prisma.refreshToken.update({
        where: { id: tokenRecord.id },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
        },
      });
    }
  },

  /**
   * Get current user by ID
   */
  async getCurrentUser(userId: string): Promise<Omit<User, 'passwordHash'>> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    // Remove passwordHash from user object before returning
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _, ...userWithoutPassword } = user;

    return userWithoutPassword;
  },

  /**
   * Create audit log entry
   */
  async createAuditLog(data: Prisma.AuditLogCreateInput): Promise<void> {
    await prisma.auditLog.create({
      data,
    });
  },
};
