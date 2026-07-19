/* eslint-disable @typescript-eslint/unbound-method */
import type { Response } from 'express';

import { AdminController } from '../../controllers/admin.controller';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { AdminService } from '../../services/admin.service';

jest.mock('../../services/admin.service', () => ({
  AdminService: {
    listUsers: jest.fn(),
    getUserById: jest.fn(),
    updateUserStatus: jest.fn(),
    getUserActivity: jest.fn(),
    listTransactions: jest.fn(),
    getTransactionById: jest.fn(),
    getTransactionAlerts: jest.fn(),
    flagTransaction: jest.fn(),
    listComplianceAlerts: jest.fn(),
    resolveComplianceAlert: jest.fn(),
    generateComplianceReport: jest.fn(),
    getSystemHealth: jest.fn(),
    getPerformanceMetrics: jest.fn(),
    getSystemLogs: jest.fn(),
    getPlatformConfig: jest.fn(),
    updatePlatformConfig: jest.fn(),
    getConfigAuditHistory: jest.fn(),
  },
}));

const mockListUsers = AdminService.listUsers as jest.Mock;
const mockGetUserById = AdminService.getUserById as jest.Mock;
const mockUpdateUserStatus = AdminService.updateUserStatus as jest.Mock;
const mockFlagTransaction = AdminService.flagTransaction as jest.Mock;
const mockGetSystemHealth = AdminService.getSystemHealth as jest.Mock;
const mockUpdatePlatformConfig = AdminService.updatePlatformConfig as jest.Mock;

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

describe('AdminController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when user is not authenticated', async () => {
    const req = createAuthRequest({ user: undefined });
    const res = createMockResponse();

    await AdminController.listUsers(req, res as unknown as Response);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it('lists users with pagination', async () => {
    const req = createAuthRequest({ query: { page: '1', limit: '10', status: 'active' } });
    const res = createMockResponse();
    const payload = {
      data: [{ id: 'user-1', email: 'a@example.com', status: 'active' }],
      pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
    };
    mockListUsers.mockResolvedValue(payload);

    await AdminController.listUsers(req, res as unknown as Response);

    expect(mockListUsers).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 10, status: 'active' })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: payload.data,
      pagination: payload.pagination,
    });
  });

  it('updates user status', async () => {
    const req = createAuthRequest({
      params: { id: 'user-1' },
      body: { status: 'suspended' },
    });
    const res = createMockResponse();
    const user = { id: 'user-1', status: 'suspended' };
    mockUpdateUserStatus.mockResolvedValue(user);

    await AdminController.updateUserStatus(req, res as unknown as Response);

    expect(mockUpdateUserStatus).toHaveBeenCalledWith(
      'user-1',
      'suspended',
      'admin-1',
      expect.objectContaining({ ipAddress: '127.0.0.1' })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: user });
  });

  it('returns user details', async () => {
    const req = createAuthRequest({ params: { id: 'user-1' } });
    const res = createMockResponse();
    const user = { id: 'user-1', email: 'a@example.com' };
    mockGetUserById.mockResolvedValue(user);

    await AdminController.getUser(req, res as unknown as Response);

    expect(mockGetUserById).toHaveBeenCalledWith('user-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: user });
  });

  it('flags a transaction', async () => {
    const req = createAuthRequest({
      params: { id: 'tx-1' },
      body: { reason: 'Suspicious amount' },
    });
    const res = createMockResponse();
    const transaction = { id: 'tx-1', isFlagged: true };
    mockFlagTransaction.mockResolvedValue(transaction);

    await AdminController.flagTransaction(req, res as unknown as Response);

    expect(mockFlagTransaction).toHaveBeenCalledWith(
      'tx-1',
      'Suspicious amount',
      'admin-1',
      expect.any(Object)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: transaction });
  });

  it('returns system health', async () => {
    const req = createAuthRequest();
    const res = createMockResponse();
    const health = {
      status: 'healthy',
      database: 'connected',
      redis: 'connected',
      stellar: 'connected',
      uptime: 10,
      version: '0.1.0',
    };
    mockGetSystemHealth.mockResolvedValue(health);

    await AdminController.getSystemHealth(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: health });
  });

  it('updates platform config', async () => {
    const req = createAuthRequest({
      body: {
        configs: [{ key: 'maxTransferAmount', value: '10000', description: 'Cap' }],
      },
    });
    const res = createMockResponse();
    const updated = [{ key: 'maxTransferAmount', value: '10000' }];
    mockUpdatePlatformConfig.mockResolvedValue(updated);

    await AdminController.updateConfig(req, res as unknown as Response);

    expect(mockUpdatePlatformConfig).toHaveBeenCalledWith(
      [{ key: 'maxTransferAmount', value: '10000', description: 'Cap' }],
      'admin-1',
      expect.any(Object)
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: updated });
  });

  it('returns validation error for invalid user status', async () => {
    const req = createAuthRequest({
      params: { id: 'user-1' },
      body: { status: 'unknown' },
    });
    const res = createMockResponse();

    await AdminController.updateUserStatus(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
    expect(mockUpdateUserStatus).not.toHaveBeenCalled();
  });
});
