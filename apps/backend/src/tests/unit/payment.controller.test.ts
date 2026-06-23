/* eslint-disable @typescript-eslint/unbound-method */
import type { Response } from 'express';

import { PaymentController } from '../../controllers/payment.controller';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { PaymentService } from '../../services/payment.service';

jest.mock('../../services/payment.service', () => ({
  PaymentService: {
    createCrossBorderPayment: jest.fn(),
    processPayment: jest.fn(),
    getPaymentStatus: jest.fn(),
    getPaymentHistory: jest.fn(),
    cancelPayment: jest.fn(),
  },
}));

const mockCreatePayment = PaymentService.createCrossBorderPayment as jest.Mock;
const mockProcessPayment = PaymentService.processPayment as jest.Mock;
const mockGetPaymentStatus = PaymentService.getPaymentStatus as jest.Mock;
const mockGetPaymentHistory = PaymentService.getPaymentHistory as jest.Mock;
const mockCancelPayment = PaymentService.cancelPayment as jest.Mock;

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

function createAuthRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    body: {},
    params: {},
    query: {},
    user: { userId: 'user-1', email: 'user@example.com' },
    ...overrides,
  } as AuthRequest;
}

describe('PaymentController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    const req = createAuthRequest({ user: undefined });
    const res = createMockResponse();

    await PaymentController.createPayment(req, res as unknown as Response);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockCreatePayment).not.toHaveBeenCalled();
  });

  it('creates a payment successfully', async () => {
    const mockResult = {
      payment: { id: 'tx-1', status: 'created' },
      amount: '100',
      assetCode: 'XLM',
    };
    mockCreatePayment.mockResolvedValue(mockResult);

    const req = createAuthRequest({
      body: {
        sourceWalletId: 'wallet-1',
        destinationAddress: 'GABCDEF',
        amount: '100',
        assetCode: 'XLM',
        purpose: 'Supplier payment',
      },
    });
    const res = createMockResponse();

    await PaymentController.createPayment(req, res as unknown as Response);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, data: mockResult });
  });

  it('returns payment status', async () => {
    const mockStatus = { id: 'tx-1', status: 'completed', stellarTxId: 'hash-1' };
    mockGetPaymentStatus.mockResolvedValue(mockStatus);

    const req = createAuthRequest({ params: { id: 'tx-1' } });
    const res = createMockResponse();

    await PaymentController.getPaymentStatus(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: mockStatus });
  });

  it('returns payment history', async () => {
    const mockHistory = [{ payment: { id: 'tx-1', status: 'completed' } }];
    mockGetPaymentHistory.mockResolvedValue(mockHistory);

    const req = createAuthRequest();
    const res = createMockResponse();

    await PaymentController.getPaymentHistory(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: mockHistory });
  });

  it('cancels a payment', async () => {
    const mockResult = { id: 'tx-1', status: 'cancelled' };
    mockCancelPayment.mockResolvedValue(mockResult);

    const req = createAuthRequest({ params: { id: 'tx-1' } });
    const res = createMockResponse();

    await PaymentController.cancelPayment(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: mockResult });
  });

  it('maps Payment not found to 404', async () => {
    mockGetPaymentStatus.mockRejectedValue(new Error('Payment not found'));

    const req = createAuthRequest({ params: { id: 'nonexistent' } });
    const res = createMockResponse();

    await PaymentController.getPaymentStatus(req, res as unknown as Response);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Payment not found' });
  });

  it('maps sanctions blocked to 403', async () => {
    mockCreatePayment.mockRejectedValue(new Error('Payment blocked: sanctions screening failed'));

    const req = createAuthRequest({ body: {} });
    const res = createMockResponse();

    await PaymentController.createPayment(req, res as unknown as Response);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: 'Payment blocked: sanctions screening failed',
    });
  });

  it('maps unknown errors to 500', async () => {
    mockProcessPayment.mockRejectedValue(new Error('Something unexpected'));

    const req = createAuthRequest({ params: { id: 'tx-1' } });
    const res = createMockResponse();

    await PaymentController.processPayment(req, res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'An error occurred' });
  });

  it('returns 400 for invalid payment ID param', async () => {
    const req = createAuthRequest({ params: { id: '' } });
    const res = createMockResponse();

    await PaymentController.getPaymentStatus(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).success).toBe(false);
    expect((res.body as Record<string, unknown>).error).toBe('Validation error');
    expect(mockGetPaymentStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for non-string walletId query param', async () => {
    const req = createAuthRequest({ query: { walletId: ['a', 'b'] } });
    const res = createMockResponse();

    await PaymentController.getPaymentHistory(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'walletId must be a string' });
    expect(mockGetPaymentHistory).not.toHaveBeenCalled();
  });
});
