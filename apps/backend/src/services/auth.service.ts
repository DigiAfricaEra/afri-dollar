/**
 * Auth Service
 * Contains business logic for authentication
 */
import { createHash } from 'crypto';

import type { User } from '@prisma/client';
import bcrypt from 'bcrypt';
import { addDays } from 'date-fns';
import jwt from 'jsonwebtoken';

import prisma from '../config/database';
import type { AuthTokens, RegisterRequest, LoginCredentials, JwtPayload } from '../types';

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/**
 * Validate JWT secrets are present
 */
function validateJwtSecrets(): void {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  if (!process.env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_REFRESH_SECRET environment variable is required');
  }
}

export const AuthService = {
  /**
   * Hash a password using bcrypt
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  },

  /**
   * Verify a password against a hash
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
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
    return jwt.sign(payload, process.env.JWT_SECRET!, {
      expiresIn: ACCESS_TOKEN_EXPIRY,
    });
  },

  /**
   * Generate JWT refresh token
   */
  generateRefreshToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    validateJwtSecrets();
    return jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, {
      expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d`,
    });
  },

  /**
   * Verify JWT access token
   */
  verifyAccessToken(token: string): JwtPayload {
    validateJwtSecrets();
    return jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
  },

  /**
   * Verify JWT refresh token
   */
  verifyRefreshToken(token: string): JwtPayload {
    validateJwtSecrets();
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as JwtPayload;
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
      throw new Error('User with this email already exists');
    }

    // Check if phone number already exists
    if (data.phoneNumber) {
      const existingPhone = await prisma.user.findUnique({
        where: { phoneNumber: data.phoneNumber },
      });

      if (existingPhone) {
        throw new Error('User with this phone number already exists');
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

    // Generate tokens
    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email,
      role: user.role,
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
    data: LoginCredentials
  ): Promise<{ user: Omit<User, 'passwordHash'>; tokens: AuthTokens }> {
    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (!user || !user.passwordHash) {
      throw new Error('Invalid email or password');
    }

    // Verify password
    const isPasswordValid = await this.verifyPassword(data.password, user.passwordHash);

    if (!isPasswordValid) {
      throw new Error('Invalid email or password');
    }

    // Check if user is active
    if (!user.isActive) {
      throw new Error('User account is inactive');
    }

    // Generate tokens
    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: user.id,
      email: user.email,
      role: user.role,
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
   * Refresh access token with token rotation
   */
  async refreshAccessToken(
    refreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // Verify refresh token
    const payload = this.verifyRefreshToken(refreshToken);

    // Hash the token to check in database
    const tokenHash = this.hashRefreshToken(refreshToken);

    // Check if refresh token exists in database and is not revoked
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!tokenRecord) {
      throw new Error('Invalid refresh token');
    }

    if (tokenRecord.isRevoked) {
      throw new Error('Refresh token has been revoked');
    }

    if (tokenRecord.expiresAt < new Date()) {
      throw new Error('Refresh token has expired');
    }

    // Check if user is active
    if (!tokenRecord.user.isActive) {
      throw new Error('User account is inactive');
    }

    // Revoke old refresh token
    await prisma.refreshToken.update({
      where: { id: tokenRecord.id },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });

    // Generate new tokens
    const jwtPayload: Omit<JwtPayload, 'iat' | 'exp'> = {
      userId: payload.userId,
      email: payload.email,
      role: tokenRecord.user.role,
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

    return { accessToken, refreshToken: newRefreshToken };
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
        throw new Error('Refresh token does not belong to this user');
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
      throw new Error('User not found');
    }

    // Remove passwordHash from user object before returning
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _, ...userWithoutPassword } = user;

    return userWithoutPassword;
  },

  /**
   * Create audit log entry
   */
  async createAuditLog(data: {
    userId?: string;
    action: string;
    resource: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
    success?: boolean;
  }): Promise<void> {
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
    await prisma.auditLog.create({
      data: data as any,
    });
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
  },
};
