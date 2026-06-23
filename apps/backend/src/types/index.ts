import type { User } from '@prisma/client';

export * from './auth.types';
export * from './payment.types';
export * from './wallet.types';

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

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  deviceInfo?: string;
  createdAt: Date;
  revokedAt?: Date;
}

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

export class AppError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'AppError';
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
