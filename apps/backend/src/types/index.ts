/**
 * Type Definitions
 * Contains shared TypeScript types for the backend
 */
import type { User } from '@prisma/client';

export * from './auth.types';

export type RegisterRequest = {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
};

export type LoginRequest = {
  email: string;
  password: string;
};

export type RefreshTokenRequest = {
  refreshToken: string;
};

export type AuthResponse = {
  success: boolean;
  data: {
    user: Omit<User, 'passwordHash'>;
    tokens: import('./auth.types').AuthTokens;
  };
};

export type TokenRefreshResponse = {
  success: boolean;
  data: {
    accessToken: string;
    refreshToken: string;
  };
};

export type UserResponse = {
  success: boolean;
  data: Omit<User, 'passwordHash'>;
};

export type JwtPayload = {
  userId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
};

export class AppError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface TokenRefreshData {
  accessToken: string;
  refreshToken: string;
  userId: string;
}
export interface CreatePayrollBatchOptions {
  name: string;
  walletId: string;
}
