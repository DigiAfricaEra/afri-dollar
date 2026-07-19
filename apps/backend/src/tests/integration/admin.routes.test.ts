import http from 'http';

import type { NextFunction, Response } from 'express';

import type { AuthRequest } from '../../middleware/auth.middleware';

const mockListUsers = jest.fn(async () => ({
  data: [
    {
      id: 'user-1',
      email: 'user@example.com',
      role: 'USER',
      status: 'active',
      kycStatus: 'approved',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      isVerified: true,
    },
  ],
  pagination: { total: 1, page: 1, limit: 50, totalPages: 1 },
}));

const mockGetSystemHealth = jest.fn(async () => ({
  status: 'healthy',
  database: 'connected',
  redis: 'connected',
  stellar: 'connected',
  uptime: 12,
  version: '0.1.0',
}));

jest.mock('../../middleware/auth.middleware', () => {
  const actual = jest.requireActual('../../middleware/auth.middleware');

  return {
    ...actual,
    authMiddleware: (req: AuthRequest, _res: Response, next: NextFunction): void => {
      const roleHeader = req.header('x-test-role');
      const role =
        roleHeader === 'USER' || roleHeader === 'BUSINESS' || roleHeader === 'AUDITOR'
          ? roleHeader
          : 'ADMIN';

      req.user = {
        userId: 'admin-1',
        email: 'admin@example.com',
        role,
        iat: 0,
        exp: 0,
      };
      next();
    },
  };
});

jest.mock('../../services/admin.service', () => ({
  AdminService: {
    listUsers: mockListUsers,
    getUserById: jest.fn(),
    updateUserStatus: jest.fn(),
    getUserActivity: jest.fn(),
    listTransactions: jest.fn(async () => ({
      data: [],
      pagination: { total: 0, page: 1, limit: 50, totalPages: 0 },
    })),
    getTransactionById: jest.fn(),
    getTransactionAlerts: jest.fn(async () => ({
      data: [],
      pagination: { total: 0, page: 1, limit: 50, totalPages: 0 },
    })),
    flagTransaction: jest.fn(),
    listComplianceAlerts: jest.fn(async () => ({
      data: [],
      pagination: { total: 0, page: 1, limit: 50, totalPages: 0 },
    })),
    resolveComplianceAlert: jest.fn(),
    generateComplianceReport: jest.fn(),
    getSystemHealth: mockGetSystemHealth,
    getPerformanceMetrics: jest.fn(),
    getSystemLogs: jest.fn(async () => ({
      data: [],
      pagination: { total: 0, page: 1, limit: 50, totalPages: 0 },
    })),
    getPlatformConfig: jest.fn(async () => []),
    updatePlatformConfig: jest.fn(),
    getConfigAuditHistory: jest.fn(async () => ({
      data: [],
      pagination: { total: 0, page: 1, limit: 50, totalPages: 0 },
    })),
  },
}));

jest.mock('../../services/job-queue.service', () => ({
  jobQueueService: {
    getStatus: jest.fn(() => 'disabled'),
    getDefinitions: jest.fn(() => []),
    listExecutions: jest.fn(async () => []),
    getExecution: jest.fn(async () => null),
    stop: jest.fn(async () => undefined),
  },
}));

describe('Admin dashboard routes', () => {
  let server: http.Server | null = null;
  let baseUrl: string;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  beforeAll(async () => {
    const { app } = await import('../../index');

    server = app.listen(0);
    await new Promise<void>((resolve) => {
      server?.once('listening', resolve);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected server to listen on a TCP port');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server === null) {
      return;
    }

    const runningServer = server;
    await new Promise<void>((resolve, reject) => {
      runningServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it('lists users via GET /api/v1/admin/users', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/users`);
    const body = (await response.json()) as {
      success: boolean;
      data: Array<{ id: string; email: string }>;
      pagination: { total: number };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data[0]?.email).toBe('user@example.com');
    expect(body.pagination.total).toBe(1);
    expect(mockListUsers).toHaveBeenCalled();
  });

  it('rejects non-admin users with 403', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/users`, {
      headers: { 'x-test-role': 'USER' },
    });
    const body = (await response.json()) as { success: boolean; error: string };

    expect(response.status).toBe(403);
    expect(body).toEqual({
      success: false,
      error: 'Admin privileges required',
    });
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it('returns health via GET /api/v1/admin/health', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/health`);
    const body = (await response.json()) as {
      success: boolean;
      data: { status: string; database: string };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('healthy');
    expect(body.data.database).toBe('connected');
    expect(mockGetSystemHealth).toHaveBeenCalled();
  });

  it('serves transaction alerts before :id routes', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/transactions/alerts`);
    const body = (await response.json()) as { success: boolean; data: unknown[] };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('serves config audit history', async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/config/audit`);
    const body = (await response.json()) as { success: boolean; data: unknown[] };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});
