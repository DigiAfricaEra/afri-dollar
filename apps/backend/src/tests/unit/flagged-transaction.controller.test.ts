/* eslint-disable @typescript-eslint/unbound-method */
import type { Response } from 'express';

import { FlaggedTransactionController } from '../../controllers/flagged-transaction.controller';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { AdminService } from '../../services/admin.service';

jest.mock('../../services/admin.service', () => ({
  AdminService: {
    listFlaggedTransactions: jest.fn(),
    getFlaggedTransactionStats: jest.fn(),
    reviewFlaggedTransaction: jest.fn(),
  },
}));

const mockListFlaggedTransactions = AdminService.listFlaggedTransactions as jest.Mock;
const mockGetFlaggedTransactionStats = AdminService.getFlaggedTransactionStats as jest.Mock;
const mockReviewFlaggedTransaction = AdminService.reviewFlaggedTransaction as jest.Mock;

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
    ip: '127.0.0.1',
    get: (header: string) => (header.toLowerCase() === 'user-agent' ? 'jest' : undefined),
    user: { userId: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    ...overrides,
  } as AuthRequest;
}

describe('FlaggedTransactionController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    const req = createAuthRequest({ user: undefined });
    const res = createMockResponse();

    await FlaggedTransactionController.listFlagged(req, res as unknown as Response);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockListFlaggedTransactions).not.toHaveBeenCalled();
  });

  it('lists flagged transactions with pagination', async () => {
    const req = createAuthRequest({ query: { page: '1', limit: '10' } });
    const res = createMockResponse();
    const payload = {
      data: [{ id: 'tx-1', isFlagged: true, flagReason: 'large amount' }],
      pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
    };
    mockListFlaggedTransactions.mockResolvedValue(payload);

    await FlaggedTransactionController.listFlagged(req, res as unknown as Response);

    expect(mockListFlaggedTransactions).toHaveBeenCalledWith(1, 10);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: payload.data,
      pagination: payload.pagination,
    });
  });

  it('returns flagged transaction stats', async () => {
    const req = createAuthRequest();
    const res = createMockResponse();
    const stats = {
      total: 5,
      pendingReview: 2,
      reviewing: 1,
      released: 1,
      blocked: 1,
      bySeverity: { high: 3, medium: 2 },
      byRule: { LARGE_TX: 3, STRUCTURING: 2 },
    };
    mockGetFlaggedTransactionStats.mockResolvedValue(stats);

    await FlaggedTransactionController.getFlaggedStats(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: stats });
  });

  it('reviews a flagged transaction with release action', async () => {
    const req = createAuthRequest({
      params: { id: 'tx-1' },
      body: { action: 'release', note: 'cleared after manual review' },
    });
    const res = createMockResponse();
    const reviewed = { id: 'tx-1', isFlagged: true, flagReviewAction: 'release' };
    mockReviewFlaggedTransaction.mockResolvedValue(reviewed);

    await FlaggedTransactionController.reviewTransaction(req, res as unknown as Response);

    expect(mockReviewFlaggedTransaction).toHaveBeenCalledWith(
      'tx-1',
      'release',
      'admin-1',
      expect.objectContaining({
        note: 'cleared after manual review',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: reviewed });
  });

  it('returns 400 for an invalid review action', async () => {
    const req = createAuthRequest({
      params: { id: 'tx-1' },
      body: { action: 'maybe' },
    });
    const res = createMockResponse();

    await FlaggedTransactionController.reviewTransaction(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(mockReviewFlaggedTransaction).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid transaction id param', async () => {
    const req = createAuthRequest({ params: {}, body: { action: 'release' } });
    const res = createMockResponse();

    await FlaggedTransactionController.reviewTransaction(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(mockReviewFlaggedTransaction).not.toHaveBeenCalled();
  });
});
