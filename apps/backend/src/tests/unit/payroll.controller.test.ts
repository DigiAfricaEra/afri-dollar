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
const mockApprovePayrollBatch = PayrollService.approvePayrollBatch as jest.Mock;
const mockProcessPayrollBatch = PayrollService.processPayrollBatch as jest.Mock;
const mockGetPayrollHistory = PayrollService.getPayrollHistory as jest.Mock;

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

    await PayrollController.listBatches(req, res as unknown as Response);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockGetPayrollBatches).not.toHaveBeenCalled();
  });

  it('returns payroll batches for the authenticated user', async () => {
    const req = createAuthRequest();
    const res = createMockResponse();
    const mockBatches = [
      { id: 'batch-1', name: 'June Payroll', status: 'pending' },
      { id: 'batch-2', name: 'July Payroll', status: 'approved' },
    ];
    mockGetPayrollBatches.mockResolvedValue(mockBatches);

    await PayrollController.listBatches(req, res as unknown as Response);

    expect(mockGetPayrollBatches).toHaveBeenCalledWith('user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: mockBatches });
  });

  it('creates a payroll batch and forwards userId to the service', async () => {
    const req = createAuthRequest({
      body: { name: 'June Payroll', description: 'June payouts', walletId: 'wallet-1' },
    });
    const res = createMockResponse();
    const mockBatch = { id: 'batch-1', name: 'June Payroll', status: 'pending' };
    mockCreatePayrollBatch.mockResolvedValue(mockBatch);

    await PayrollController.createBatch(req, res as unknown as Response);

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

    // Use an error message string that your controller's handleMap actively maps to 400
    mockCreatePayrollBatch.mockRejectedValueOnce(new Error('Amount must be a positive number'));

    await PayrollController.createBatch(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'Amount must be a positive number',
    });
    expect(mockCreatePayrollBatch).toHaveBeenCalled();
  });

  it('maps wallet ownership errors to 404 to avoid revealing wallet existence', async () => {
    const req = createAuthRequest({
      body: { name: 'June Payroll', walletId: 'wallet-1' },
    });
    const res = createMockResponse();
    mockCreatePayrollBatch.mockRejectedValueOnce(new Error('Wallet does not belong to user'));

    await PayrollController.createBatch(req, res as unknown as Response);

    expect(res.statusCode).toBe(404);
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

    await PayrollController.addItem(req, res as unknown as Response);

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

    await PayrollController.getBatch(req, res as unknown as Response);

    expect(mockGetPayrollBatch).toHaveBeenCalledWith('missing-batch', 'user-1');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Payroll batch not found' });
  });

  it('approves a payroll batch and forwards userId to the service', async () => {
    const req = createAuthRequest({ params: { id: 'batch-1' } });
    const res = createMockResponse();
    const mockBatch = { id: 'batch-1', name: 'June Payroll', status: 'approved' };
    mockApprovePayrollBatch.mockResolvedValue(mockBatch);

    await PayrollController.approveBatch(req, res as unknown as Response);

    expect(mockApprovePayrollBatch).toHaveBeenCalledWith('batch-1', 'user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: mockBatch });
  });

  it('maps approve batch not found errors to 404', async () => {
    const req = createAuthRequest({ params: { id: 'missing-batch' } });
    const res = createMockResponse();
    mockApprovePayrollBatch.mockRejectedValue(new Error('Payroll batch not found'));

    await PayrollController.approveBatch(req, res as unknown as Response);

    expect(mockApprovePayrollBatch).toHaveBeenCalledWith('missing-batch', 'user-1');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Payroll batch not found' });
  });

  it('maps non-pending approve errors to 400', async () => {
    const req = createAuthRequest({ params: { id: 'batch-1' } });
    const res = createMockResponse();
    mockApprovePayrollBatch.mockRejectedValue(new Error('Only pending batches can be approved'));

    await PayrollController.approveBatch(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Only pending batches can be approved' });
  });

  it('maps double-processing errors to 409', async () => {
    const req = createAuthRequest({ params: { id: 'batch-1' } });
    const res = createMockResponse();
    mockProcessPayrollBatch.mockRejectedValue(new Error('Batch is already being processed'));

    await PayrollController.processBatch(req, res as unknown as Response);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Batch is already being processed' });
  });

  it('returns payroll history for the authenticated user', async () => {
    const req = createAuthRequest();
    const res = createMockResponse();
    const mockHistory = [{ id: 'batch-1', items: [] }];
    mockGetPayrollHistory.mockResolvedValue(mockHistory);

    await PayrollController.getHistory(req, res as unknown as Response);

    expect(mockGetPayrollHistory).toHaveBeenCalledWith('user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: mockHistory });
  });
});
