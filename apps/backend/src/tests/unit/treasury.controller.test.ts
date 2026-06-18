/* eslint-disable @typescript-eslint/unbound-method */
import type { Response } from 'express';

import { TreasuryController } from '../../controllers/treasury.controller';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { TreasuryService } from '../../services/treasury.service';

jest.mock('../../services/treasury.service', () => ({
  TreasuryService: {
    getTreasuryBalance: jest.fn(),
    getTreasuryPositions: jest.fn(),
    rebalance: jest.fn(),
    getTreasuryHistory: jest.fn(),
  },
}));

const mockGetTreasuryBalance = TreasuryService.getTreasuryBalance as jest.Mock;
const mockGetTreasuryPositions = TreasuryService.getTreasuryPositions as jest.Mock;
const mockRebalance = TreasuryService.rebalance as jest.Mock;
const mockGetTreasuryHistory = TreasuryService.getTreasuryHistory as jest.Mock;

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
    user: { userId: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    ...overrides,
  } as AuthRequest;
}

describe('TreasuryController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    const req = createAuthRequest({ user: undefined });
    const res = createMockResponse();

    await TreasuryController.getBalance(req, res as unknown as Response);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockGetTreasuryBalance).not.toHaveBeenCalled();
  });

  it('returns the treasury balance summary', async () => {
    const req = createAuthRequest();
    const res = createMockResponse();
    const summary = {
      totalValueUsd: '1000.00',
      assetCount: 1,
      walletCount: 1,
      positions: [],
    };
    mockGetTreasuryBalance.mockResolvedValue(summary);

    await TreasuryController.getBalance(req, res as unknown as Response);

    expect(mockGetTreasuryBalance).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: summary });
  });

  it('returns treasury positions', async () => {
    const req = createAuthRequest();
    const res = createMockResponse();
    const positions = [{ assetCode: 'USDC', balance: '500.0', valueUsd: '500.00', allocation: 50 }];
    mockGetTreasuryPositions.mockResolvedValue(positions);

    await TreasuryController.getPositions(req, res as unknown as Response);

    expect(mockGetTreasuryPositions).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: positions });
  });

  it('rebalances and forwards targets and admin id to the service', async () => {
    const req = createAuthRequest({
      body: {
        targets: [
          { assetCode: 'USDC', targetAllocation: 60 },
          { assetCode: 'NGN', targetAllocation: 40 },
        ],
      },
    });
    const res = createMockResponse();
    const operations = [{ id: 'op-1', type: 'rebalance', amount: '10.0', assetCode: 'USDC' }];
    mockRebalance.mockResolvedValue(operations);

    await TreasuryController.rebalance(req, res as unknown as Response);

    expect(mockRebalance).toHaveBeenCalledWith(
      [
        { assetCode: 'USDC', targetAllocation: 60 },
        { assetCode: 'NGN', targetAllocation: 40 },
      ],
      'admin-1'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: operations });
  });

  it('returns 400 for an invalid rebalance payload', async () => {
    const req = createAuthRequest({ body: { targets: [] } });
    const res = createMockResponse();

    await TreasuryController.rebalance(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({ success: false, error: 'Validation error' })
    );
    expect(mockRebalance).not.toHaveBeenCalled();
  });

  it('maps "must sum to 100" rebalance errors to 400', async () => {
    const req = createAuthRequest({
      body: { targets: [{ assetCode: 'USDC', targetAllocation: 60 }] },
    });
    const res = createMockResponse();
    mockRebalance.mockRejectedValue(new Error('Target allocations must sum to 100 percent'));

    await TreasuryController.rebalance(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Target allocations must sum to 100 percent',
    });
  });

  it('maps missing treasury wallet errors to 404', async () => {
    const req = createAuthRequest({
      body: { targets: [{ assetCode: 'USDC', targetAllocation: 100 }] },
    });
    const res = createMockResponse();
    mockRebalance.mockRejectedValue(new Error('No treasury wallet found'));

    await TreasuryController.rebalance(req, res as unknown as Response);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'No treasury wallet found' });
  });

  it('returns treasury history and forwards parsed filters', async () => {
    const req = createAuthRequest({ query: { type: 'rebalance', limit: '5' } });
    const res = createMockResponse();
    const history = [{ id: 'op-1', type: 'rebalance', amount: '10.0', assetCode: 'USDC' }];
    mockGetTreasuryHistory.mockResolvedValue(history);

    await TreasuryController.getHistory(req, res as unknown as Response);

    expect(mockGetTreasuryHistory).toHaveBeenCalledWith({ type: 'rebalance', limit: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: history });
  });

  it('returns 400 for an invalid history filter', async () => {
    const req = createAuthRequest({ query: { type: 'invalid-type' } });
    const res = createMockResponse();

    await TreasuryController.getHistory(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({ success: false, error: 'Validation error' })
    );
    expect(mockGetTreasuryHistory).not.toHaveBeenCalled();
  });
});
