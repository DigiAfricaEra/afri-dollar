/* eslint-disable @typescript-eslint/unbound-method */
import type { Request, NextFunction } from 'express';

import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ERROR_CODES,
  errorMiddleware,
} from '../../middleware/error.middleware';

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const req = {} as Request;
const next = jest.fn() as unknown as NextFunction;

describe('Error Classes', () => {
  it('AppError sets statusCode, code, isOperational', () => {
    const err = new AppError('test', 400, 'AUTH_001');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('AUTH_001');
    expect(err.isOperational).toBe(true);
    expect(err.message).toBe('test');
    expect(err instanceof Error).toBe(true);
  });

  it('AuthenticationError defaults to 401 / AUTH_001', () => {
    const err = new AuthenticationError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTH_001');
    expect(err.message).toBe('Authentication failed');
    expect(err instanceof AppError).toBe(true);
  });

  it('AuthorizationError defaults to 403 / AUTH_004', () => {
    const err = new AuthorizationError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('AUTH_004');
    expect(err.message).toBe('Access denied');
  });

  it('NotFoundError defaults to 404 / NOT_FOUND_001', () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND_001');
    expect(err.message).toBe('Resource not found');
  });

  it('ValidationError defaults to 422 / VALIDATION_001', () => {
    const err = new ValidationError();
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('VALIDATION_001');
    expect(err.message).toBe('Validation failed');
  });
});

describe('ERROR_CODES', () => {
  it('contains all required codes', () => {
    const required = [
      'AUTH_001',
      'AUTH_002',
      'AUTH_003',
      'AUTH_004',
      'WALLET_001',
      'WALLET_002',
      'TXN_001',
      'TXN_002',
      'FX_001',
      'COMPLIANCE_001',
      'NOT_FOUND_001',
      'VALIDATION_001',
      'SERVER_001',
    ];
    for (const code of required) {
      expect(ERROR_CODES).toHaveProperty(code);
    }
  });
});

describe('errorMiddleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('handles AppError with correct status and format', () => {
    const res = createMockResponse();
    const err = new AppError('Wallet not found', 404, 'WALLET_001');
    errorMiddleware(err, req, res as never, next);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'WALLET_001', message: 'Wallet not found' },
    });
  });

  it('handles AuthenticationError', () => {
    const res = createMockResponse();
    errorMiddleware(
      new AuthenticationError('Invalid credentials', 'AUTH_001'),
      req,
      res as never,
      next
    );
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).success).toBe(false);
  });

  it('handles AuthorizationError', () => {
    const res = createMockResponse();
    errorMiddleware(new AuthorizationError(), req, res as never, next);
    expect(res.statusCode).toBe(403);
  });

  it('handles NotFoundError', () => {
    const res = createMockResponse();
    errorMiddleware(new NotFoundError(), req, res as never, next);
    expect(res.statusCode).toBe(404);
  });

  it('handles ValidationError', () => {
    const res = createMockResponse();
    errorMiddleware(new ValidationError(), req, res as never, next);
    expect(res.statusCode).toBe(422);
  });

  it('handles unexpected errors as 500 without exposing internals', () => {
    const res = createMockResponse();
    const err = new Error('Database exploded');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    errorMiddleware(err, req, res as never, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'SERVER_001', message: ERROR_CODES.SERVER_001 },
    });
    expect(JSON.stringify(res.body)).not.toContain('Database exploded');

    consoleSpy.mockRestore();
  });

  it('response always has success: false', () => {
    const res = createMockResponse();
    errorMiddleware(new AppError('any', 400, 'AUTH_001'), req, res as never, next);
    expect((res.body as Record<string, unknown>).success).toBe(false);
  });
});
