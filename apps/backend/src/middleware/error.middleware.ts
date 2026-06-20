import type { Request, Response, NextFunction } from 'express';

export const ERROR_CODES = {
  AUTH_001: 'Invalid credentials',
  AUTH_002: 'Token expired',
  AUTH_003: 'Token invalid',
  AUTH_004: 'Insufficient permissions',
  WALLET_001: 'Wallet not found',
  WALLET_002: 'Insufficient balance',
  TXN_001: 'Transaction failed',
  TXN_002: 'Invalid transaction',
  FX_001: 'Invalid rate',
  COMPLIANCE_001: 'KYC required',
  NOT_FOUND_001: 'Resource not found',
  VALIDATION_001: 'Validation failed',
  SERVER_001: 'Internal server error',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  statusCode: number;
  code: ErrorCode;
  isOperational: boolean;

  constructor(message: string, statusCode: number, code: ErrorCode) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication failed', code: ErrorCode = 'AUTH_001') {
    super(message, 401, code);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Access denied', code: ErrorCode = 'AUTH_004') {
    super(message, 403, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code: ErrorCode = 'NOT_FOUND_001') {
    super(message, 404, code);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', code: ErrorCode = 'VALIDATION_001') {
    super(message, 422, code);
  }
}

export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // Log unexpected errors but don't expose internals
  console.error('Unexpected error:', err);

  res.status(500).json({
    success: false,
    error: {
      code: 'SERVER_001',
      message: ERROR_CODES.SERVER_001,
    },
  });
}
