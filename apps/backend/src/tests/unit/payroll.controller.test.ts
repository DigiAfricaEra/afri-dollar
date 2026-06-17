/* eslint-disable @typescript-eslint/unbound-method */
import type { Response } from 'express';

import { PayrollController } from '../../controllers/payroll.controller';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { PayrollService } from '../../services/payroll.service';

jest.mock('../../services/payroll.service', () => ({
  PayrollService: {
    createPayrollBatch: jest.fn(),
    getPayrollBatches: jest.fn(),
    getPayrollBatch: jest.fn(),
    addPayrollItem: jest.fn(),
    approvePayrollBatch: jest.fn(),
    processPayrollBatch: jest.fn(),
    getPayrollHistory: jest.fn(),
  },
}));

const mockCreatePayrollBatch = PayrollService.createPayrollBatch as jest.Mock;
const mockGetPayrollBatches = PayrollService.getPayrollBatches as jest.Mock;
const mockGetPayrollBatch = PayrollService.getPayrollBatch as jest.Mock;
const mockAddPayrollItem = PayrollService.addPayrollItem as jest.Mock;
const mockProcessPayrollBatch = PayrollService.processPayrollBatch as jest.Mock;
const mockGetPayrollHistory = PayrollService.getPayrollHistory as jest.Mock;

function createMockResponse(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number): Response & { statusCode: number; body: unknown } {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown): Response & { statusCode: number; body: unknown } {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: unknown };
}

function createAuthRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    body: {},
    params: {},
    user: { userId: 'user-1', email: 'user@example.com' },
    ...overrides,
  } as AuthRequest;
}

describe('PayrollController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    const req = createAuthRequest({ user: undefined });
    const res = createMockResponse();

    await PayrollController.listBatches(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockGetPayrollBatches).not.toHaveBeenCalled();
  });

  it('creates a payroll batch and forwards userId to the service', async () => {
    const req = createAuthRequest({
      body: { name: 'June Payroll', description: 'June payouts', walletId: 'wallet-1' },
    });
    const res = createMockResponse();
    const mockBatch = { id: 'batch-1', name: 'June Payroll', status: 'pending' };
    mockCreatePayrollBatch.mockResolvedValue(mockBatch);

    await PayrollController.createBatch(req, res);

    expect(mockCreatePayrollBatch).toHaveBeenCalledWith(
      { name: 'June Payroll', description: 'June payouts', walletId: 'wallet-1' },
      'user-1'
    );
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, data: mockBatch });
  });

  it('returns 400 for invalid create batch payload', async () => {
    const req = createAuthRequest({ body: { name: '', walletId: '' } });
    const res = createMockResponse();

    await PayrollController.createBatch(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: false,
        error: 'Validation error',
      })
    );
    expect(mockCreatePayrollBatch).not.toHaveBeenCalled();
  });

  it('maps wallet ownership errors to 403', async () => {
    const req = createAuthRequest({
      body: { name: 'June Payroll', walletId: 'wallet-1' },
    });
    const res = createMockResponse();
    mockCreatePayrollBatch.mockRejectedValue(new Error('Wallet does not belong to user'));

    await PayrollController.createBatch(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Wallet does not belong to user' });
  });

  it('adds a payroll item using batch id from params', async () => {
    const req = createAuthRequest({
      params: { id: 'batch-1' },
      body: {
        recipientAddress: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '100.00',
        assetCode: 'USDC',
        assetIssuer: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
      },
    });
    const res = createMockResponse();
    const mockItem = { id: 'item-1', payrollBatchId: 'batch-1', status: 'pending' };
    mockAddPayrollItem.mockResolvedValue(mockItem);

    await PayrollController.addItem(req, res);

    expect(mockAddPayrollItem).toHaveBeenCalledWith(
      'batch-1',
      expect.objectContaining({ amount: '100.00', assetCode: 'USDC' }),
      'user-1'
    );
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, data: mockItem });
  });

  it('maps batch not found errors to 404', async () => {
    const req = createAuthRequest({ params: { id: 'missing-batch' } });
    const res = createMockResponse();
    mockGetPayrollBatch.mockRejectedValue(new Error('Payroll batch not found'));

    await PayrollController.getBatch(req, res);

    expect(mockGetPayrollBatch).toHaveBeenCalledWith('missing-batch', 'user-1');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Payroll batch not found' });
  });

  it('maps double-processing errors to 409', async () => {
    const req = createAuthRequest({ params: { id: 'batch-1' } });
    const res = createMockResponse();
    mockProcessPayrollBatch.mockRejectedValue(new Error('Batch is already being processed'));

    await PayrollController.processBatch(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Batch is already being processed' });
  });

  it('returns payroll history for the authenticated user', async () => {
    const req = createAuthRequest();
    const res = createMockResponse();
    const mockHistory = [{ id: 'batch-1', items: [] }];
    mockGetPayrollHistory.mockResolvedValue(mockHistory);

    await PayrollController.getHistory(req, res);

    expect(mockGetPayrollHistory).toHaveBeenCalledWith('user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: mockHistory });
  });
});
