/* eslint-disable @typescript-eslint/unbound-method */
import prisma from '../../config/database';
import { AdminService } from '../../services/admin.service';
import { AuditService } from '../../services/audit.service';
import { AppError } from '../../types';

jest.mock('../../config/database', () => {
  const client: Record<string, unknown> = {
    user: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    transaction: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    complianceAlert: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn(),
    },
    kYCRecord: {
      count: jest.fn(),
    },
    systemConfig: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };

  client.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => Promise<unknown>)(client);
    }

    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }

    throw new TypeError('Unsupported $transaction argument');
  });

  return {
    __esModule: true,
    default: client,
  };
});

jest.mock('../../services/audit.service', () => ({
  AuditService: {
    log: jest.fn(),
    query: jest.fn(),
  },
}));

jest.mock('../../services/job-queue.service', () => ({
  jobQueueService: {
    getStatus: jest.fn(() => 'ready'),
  },
}));

jest.mock('../../services/security.service', () => ({
  SecurityService: {
    getSecurityMetrics: jest.fn(async () => ({
      blockedIps: [],
      flaggedIps: [],
      totalBlockedIps: 0,
      totalFlaggedIps: 0,
      totalFailedAttempts: 0,
    })),
  },
}));

const originalFetch = global.fetch;
const mockFetch = jest.fn();

const mockUserFindMany = prisma.user.findMany as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockUserCount = prisma.user.count as jest.Mock;
const mockUserUpdate = prisma.user.update as jest.Mock;
const mockTransactionFindUnique = prisma.transaction.findUnique as jest.Mock;
const mockTransactionUpdate = prisma.transaction.update as jest.Mock;
const mockComplianceAlertCreate = prisma.complianceAlert.create as jest.Mock;
const mockComplianceAlertFindUnique = prisma.complianceAlert.findUnique as jest.Mock;
const mockComplianceAlertUpdate = prisma.complianceAlert.update as jest.Mock;
const mockSystemConfigFindUnique = prisma.systemConfig.findUnique as jest.Mock;
const mockSystemConfigUpsert = prisma.systemConfig.upsert as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockAuditServiceLog = AuditService.log as jest.Mock;

describe('AdminService', () => {
  beforeAll(() => {
    global.fetch = mockFetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists users and maps KYC status', async () => {
    mockUserFindMany.mockResolvedValue([
      {
        id: 'user-1',
        email: 'a@example.com',
        role: 'USER',
        status: 'active',
        createdAt: new Date('2026-01-01'),
        lastLoginAt: null,
        firstName: 'Ada',
        lastName: 'Lovelace',
        isVerified: false,
        phoneNumber: null,
        walletAddress: null,
        kycRecords: [{ status: 'review' }],
      },
    ]);
    mockUserCount.mockResolvedValue(1);

    const result = await AdminService.listUsers({ page: 1, limit: 20 });

    expect(result.data[0]).toMatchObject({
      id: 'user-1',
      email: 'a@example.com',
      status: 'active',
      kycStatus: 'review',
    });
    expect(result.pagination).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
  });

  it('updates user status and writes an audit log', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      status: 'active',
    });
    mockUserUpdate.mockResolvedValue({
      id: 'user-1',
      email: 'a@example.com',
      role: 'USER',
      status: 'suspended',
      createdAt: new Date('2026-01-01'),
      lastLoginAt: null,
      firstName: null,
      lastName: null,
      isVerified: true,
      phoneNumber: null,
      walletAddress: null,
      kycRecords: [{ status: 'approved' }],
    });

    const result = await AdminService.updateUserStatus('user-1', 'suspended', 'admin-1');

    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { status: 'suspended', isActive: false },
      include: expect.any(Object),
    });
    expect(mockAuditServiceLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_user_status_update',
        resource: 'user',
        resourceId: 'user-1',
      })
    );
    expect(result.status).toBe('suspended');
  });

  it('prevents admins from suspending themselves', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'admin-1',
      status: 'active',
    });

    await expect(AdminService.updateUserStatus('admin-1', 'banned', 'admin-1')).rejects.toThrow(
      AppError
    );
  });

  it('flags a transaction and creates a compliance alert atomically', async () => {
    mockTransactionFindUnique.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      amount: '1000',
      assetCode: 'USDC',
    });
    mockTransactionUpdate.mockResolvedValue({
      id: 'tx-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      type: 'transfer',
      status: 'completed',
      amount: '1000',
      assetCode: 'USDC',
      assetIssuer: null,
      fromAddress: null,
      toAddress: null,
      stellarTxId: null,
      isFlagged: true,
      flagReason: 'Suspicious',
      flaggedAt: new Date('2026-07-19'),
      flaggedBy: 'admin-1',
      metadata: null,
      errorMessage: null,
      createdAt: new Date('2026-07-18'),
      updatedAt: new Date('2026-07-19'),
      completedAt: new Date('2026-07-18'),
      user: { id: 'user-1', email: 'a@example.com', status: 'active' },
    });
    mockComplianceAlertCreate.mockResolvedValue({});
    mockAuditLogCreate.mockResolvedValue({});

    const result = await AdminService.flagTransaction('tx-1', 'Suspicious', 'admin-1');

    expect(result.isFlagged).toBe(true);
    expect(mockComplianceAlertCreate).toHaveBeenCalled();
    expect(mockAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin_transaction_flag',
        resourceId: 'tx-1',
      }),
    });
  });

  it('resolves an open compliance alert', async () => {
    mockComplianceAlertFindUnique.mockResolvedValue({
      id: 'alert-1',
      status: 'open',
    });
    mockComplianceAlertUpdate.mockResolvedValue({
      id: 'alert-1',
      type: 'kyc',
      severity: 'high',
      status: 'resolved',
      title: 'KYC review required',
      description: null,
      userId: 'user-1',
      transactionId: null,
      metadata: null,
      resolvedAt: new Date('2026-07-19'),
      resolvedBy: 'admin-1',
      resolutionNote: 'Verified manually',
      createdAt: new Date('2026-07-18'),
      updatedAt: new Date('2026-07-19'),
    });

    const result = await AdminService.resolveComplianceAlert('alert-1', 'admin-1', {
      resolutionNote: 'Verified manually',
    });

    expect(result.status).toBe('resolved');
    expect(mockAuditServiceLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_compliance_alert_resolve' })
    );
  });

  it('returns healthy system status when dependencies respond', async () => {
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
    mockFetch.mockResolvedValue({ ok: true });

    const health = await AdminService.getSystemHealth();

    expect(health.status).toBe('healthy');
    expect(health.database).toBe('connected');
    expect(health.redis).toBe('connected');
    expect(health.stellar).toBe('connected');
  });

  it('updates platform config atomically without logging raw values', async () => {
    mockSystemConfigFindUnique.mockResolvedValue(null);
    mockSystemConfigUpsert.mockResolvedValue({
      id: 'cfg-1',
      key: 'feature.flags',
      value: { reports: true },
      description: 'Feature flags',
      updatedBy: 'admin-1',
      createdAt: new Date('2026-07-19'),
      updatedAt: new Date('2026-07-19'),
    });
    mockAuditLogCreate.mockResolvedValue({});

    const result = await AdminService.updatePlatformConfig(
      [{ key: 'feature.flags', value: { reports: true }, description: 'Feature flags' }],
      'admin-1'
    );

    expect(result).toHaveLength(1);
    expect(mockAuditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin_config_update',
        resource: 'system_config',
        metadata: {
          key: 'feature.flags',
          changed: true,
          hadPreviousValue: false,
        },
      }),
    });
  });
});
