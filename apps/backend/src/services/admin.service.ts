import type { Prisma, UserRole, UserStatus } from '@prisma/client';

import prisma from '../config/database';
import { AppError } from '../types';
import type {
  AdminPerformanceMetrics,
  AdminTransaction,
  AdminUser,
  AdminUserStatus,
  ComplianceAlert,
  ComplianceReportSummary,
  ConnectionStatus,
  SystemConfigEntry,
  SystemHealth,
} from '../types/admin.types';

import { AuditService } from './audit.service';
import { jobQueueService } from './job-queue.service';
import { SecurityService } from './security.service';

const APP_VERSION = process.env.npm_package_version || '0.1.0';
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

export interface AdminListUsersFilters {
  status?: AdminUserStatus;
  role?: string;
  email?: string;
  kycStatus?: string;
  page: number;
  limit: number;
}

export interface AdminListTransactionsFilters {
  status?: string;
  type?: string;
  userId?: string;
  assetCode?: string;
  isFlagged?: boolean;
  startDate?: string;
  endDate?: string;
  page: number;
  limit: number;
}

export interface AdminListComplianceAlertsFilters {
  status?: 'open' | 'resolved' | 'dismissed';
  severity?: string;
  type?: string;
  userId?: string;
  page: number;
  limit: number;
}

export interface PaginationResult {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

function toAdminUserStatus(status: UserStatus | string): AdminUserStatus {
  if (status === 'suspended' || status === 'banned' || status === 'active') {
    return status;
  }
  return 'active';
}

function mapUserToAdminUser(
  user: {
    id: string;
    email: string;
    role: string;
    status: UserStatus;
    createdAt: Date;
    lastLoginAt: Date | null;
    firstName: string | null;
    lastName: string | null;
    isVerified: boolean;
    phoneNumber: string | null;
    walletAddress: string | null;
    kycRecords?: Array<{ status: string }>;
  },
  kycStatusOverride?: string
): AdminUser {
  const kycStatus =
    kycStatusOverride ?? user.kycRecords?.[0]?.status ?? (user.isVerified ? 'approved' : 'pending');

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: toAdminUserStatus(user.status),
    kycStatus,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? undefined,
    firstName: user.firstName,
    lastName: user.lastName,
    isVerified: user.isVerified,
    phoneNumber: user.phoneNumber,
    walletAddress: user.walletAddress,
  };
}

function mapTransaction(tx: {
  id: string;
  userId: string;
  walletId: string;
  type: string;
  status: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  stellarTxId: string | null;
  isFlagged: boolean;
  flagReason: string | null;
  flaggedAt: Date | null;
  flaggedBy: string | null;
  metadata: Prisma.JsonValue | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  user?: {
    id: string;
    email: string;
    status: UserStatus;
  };
}): AdminTransaction {
  return {
    id: tx.id,
    userId: tx.userId,
    walletId: tx.walletId,
    type: tx.type,
    status: tx.status,
    amount: tx.amount,
    assetCode: tx.assetCode,
    assetIssuer: tx.assetIssuer,
    fromAddress: tx.fromAddress,
    toAddress: tx.toAddress,
    stellarTxId: tx.stellarTxId,
    isFlagged: tx.isFlagged,
    flagReason: tx.flagReason,
    flaggedAt: tx.flaggedAt,
    flaggedBy: tx.flaggedBy,
    metadata: tx.metadata,
    errorMessage: tx.errorMessage,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    completedAt: tx.completedAt,
    user: tx.user
      ? {
          id: tx.user.id,
          email: tx.user.email,
          status: toAdminUserStatus(tx.user.status),
        }
      : undefined,
  };
}

function mapComplianceAlert(alert: {
  id: string;
  type: string;
  severity: string;
  status: 'open' | 'resolved' | 'dismissed';
  title: string;
  description: string | null;
  userId: string | null;
  transactionId: string | null;
  metadata: Prisma.JsonValue | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ComplianceAlert {
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    status: alert.status,
    title: alert.title,
    description: alert.description,
    userId: alert.userId,
    transactionId: alert.transactionId,
    metadata: alert.metadata,
    resolvedAt: alert.resolvedAt,
    resolvedBy: alert.resolvedBy,
    resolutionNote: alert.resolutionNote,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

async function checkDatabase(): Promise<ConnectionStatus> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS);
    return 'connected';
  } catch {
    return 'disconnected';
  }
}

async function checkRedis(): Promise<ConnectionStatus> {
  // Job queue readiness is the platform's Redis connectivity signal
  return jobQueueService.getStatus() === 'ready' ? 'connected' : 'disconnected';
}

async function checkStellar(): Promise<ConnectionStatus> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    try {
      const response = await fetch(HORIZON_URL, { signal: controller.signal });
      return response.ok ? 'connected' : 'disconnected';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 'disconnected';
  }
}

function deriveHealthStatus(
  database: ConnectionStatus,
  redis: ConnectionStatus,
  stellar: ConnectionStatus
): SystemHealth['status'] {
  if (database === 'disconnected') {
    return 'down';
  }

  if (redis === 'disconnected' || stellar === 'disconnected') {
    return 'degraded';
  }

  return 'healthy';
}

async function writeAdminAudit(params: {
  adminUserId: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  success?: boolean;
}): Promise<void> {
  await AuditService.log({
    userId: params.adminUserId,
    action: params.action,
    resource: params.resource,
    resourceId: params.resourceId,
    metadata: params.metadata,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    success: params.success ?? true,
  });
}

export const AdminService = {
  async listUsers(
    filters: AdminListUsersFilters
  ): Promise<{ data: AdminUser[]; pagination: PaginationResult }> {
    const where: Prisma.UserWhereInput = {};

    if (filters.status !== undefined) {
      where.status = filters.status;
    }

    if (filters.role !== undefined) {
      where.role = filters.role as UserRole;
    }

    if (filters.email !== undefined && filters.email.length > 0) {
      where.email = { contains: filters.email, mode: 'insensitive' };
    }

    if (filters.kycStatus !== undefined && filters.kycStatus.length > 0) {
      where.kycRecords = {
        some: { status: filters.kycStatus },
      };
    }

    const skip = (filters.page - 1) * filters.limit;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: {
          kycRecords: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: filters.limit,
      }),
      prisma.user.count({ where }),
    ]);

    return {
      data: users.map((user) => mapUserToAdminUser(user)),
      pagination: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  },

  async getUserById(id: string): Promise<AdminUser> {
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        kycRecords: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    return mapUserToAdminUser(user);
  },

  async updateUserStatus(
    id: string,
    status: AdminUserStatus,
    adminUserId: string,
    context?: { ipAddress?: string; userAgent?: string }
  ): Promise<AdminUser> {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError(404, 'User not found');
    }

    if (existing.id === adminUserId && status !== 'active') {
      throw new AppError(400, 'Admins cannot suspend or ban their own account');
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        status,
        isActive: status === 'active',
      },
      include: {
        kycRecords: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });

    await writeAdminAudit({
      adminUserId,
      action: 'admin_user_status_update',
      resource: 'user',
      resourceId: id,
      metadata: { previousStatus: existing.status, status },
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });

    return mapUserToAdminUser(updated);
  },

  async getUserActivity(
    userId: string,
    page: number,
    limit: number
  ): Promise<Awaited<ReturnType<typeof AuditService.query>>> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      throw new AppError(404, 'User not found');
    }

    return AuditService.query({ userId, page, limit });
  },

  async listTransactions(
    filters: AdminListTransactionsFilters
  ): Promise<{ data: AdminTransaction[]; pagination: PaginationResult }> {
    const where: Prisma.TransactionWhereInput = {};

    if (filters.status !== undefined && filters.status.length > 0) {
      where.status = filters.status;
    }

    if (filters.type !== undefined && filters.type.length > 0) {
      where.type = filters.type;
    }

    if (filters.userId !== undefined && filters.userId.length > 0) {
      where.userId = filters.userId;
    }

    if (filters.assetCode !== undefined && filters.assetCode.length > 0) {
      where.assetCode = filters.assetCode;
    }

    if (filters.isFlagged !== undefined) {
      where.isFlagged = filters.isFlagged;
    }

    if (filters.startDate !== undefined || filters.endDate !== undefined) {
      where.createdAt = {};
      if (filters.startDate !== undefined) {
        where.createdAt.gte = new Date(filters.startDate);
      }
      if (filters.endDate !== undefined) {
        where.createdAt.lte = new Date(filters.endDate);
      }
    }

    const skip = (filters.page - 1) * filters.limit;

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: filters.limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    return {
      data: transactions.map(mapTransaction),
      pagination: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  },

  async getTransactionById(id: string): Promise<AdminTransaction> {
    const transaction = await prisma.transaction.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, email: true, status: true },
        },
      },
    });

    if (!transaction) {
      throw new AppError(404, 'Transaction not found');
    }

    return mapTransaction(transaction);
  },

  async getTransactionAlerts(
    page: number,
    limit: number
  ): Promise<{ data: AdminTransaction[]; pagination: PaginationResult }> {
    return this.listTransactions({
      isFlagged: true,
      page,
      limit,
    });
  },

  async flagTransaction(
    id: string,
    reason: string,
    adminUserId: string,
    context?: { ipAddress?: string; userAgent?: string }
  ): Promise<AdminTransaction> {
    const existing = await prisma.transaction.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError(404, 'Transaction not found');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const flagged = await tx.transaction.update({
        where: { id },
        data: {
          isFlagged: true,
          flagReason: reason,
          flaggedAt: new Date(),
          flaggedBy: adminUserId,
        },
        include: {
          user: {
            select: { id: true, email: true, status: true },
          },
        },
      });

      await tx.complianceAlert.create({
        data: {
          type: 'transaction_flag',
          severity: 'high',
          title: `Transaction flagged: ${id}`,
          description: reason,
          userId: existing.userId,
          transactionId: id,
          metadata: {
            amount: existing.amount,
            assetCode: existing.assetCode,
            flaggedBy: adminUserId,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminUserId,
          action: 'admin_transaction_flag',
          resource: 'transaction',
          resourceId: id,
          metadata: { reason },
          ipAddress: context?.ipAddress,
          userAgent: context?.userAgent,
          success: true,
        },
      });

      return flagged;
    });

    return mapTransaction(updated);
  },

  async listComplianceAlerts(
    filters: AdminListComplianceAlertsFilters
  ): Promise<{ data: ComplianceAlert[]; pagination: PaginationResult }> {
    const where: Prisma.ComplianceAlertWhereInput = {};

    if (filters.status !== undefined) {
      where.status = filters.status;
    }

    if (filters.severity !== undefined && filters.severity.length > 0) {
      where.severity = filters.severity;
    }

    if (filters.type !== undefined && filters.type.length > 0) {
      where.type = filters.type;
    }

    if (filters.userId !== undefined && filters.userId.length > 0) {
      where.userId = filters.userId;
    }

    const skip = (filters.page - 1) * filters.limit;

    const [alerts, total] = await Promise.all([
      prisma.complianceAlert.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: filters.limit,
      }),
      prisma.complianceAlert.count({ where }),
    ]);

    return {
      data: alerts.map(mapComplianceAlert),
      pagination: {
        total,
        page: filters.page,
        limit: filters.limit,
        totalPages: Math.ceil(total / filters.limit),
      },
    };
  },

  async resolveComplianceAlert(
    id: string,
    adminUserId: string,
    options?: {
      status?: 'resolved' | 'dismissed';
      resolutionNote?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<ComplianceAlert> {
    const existing = await prisma.complianceAlert.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError(404, 'Compliance alert not found');
    }

    if (existing.status !== 'open') {
      throw new AppError(400, 'Compliance alert is already closed');
    }

    const status = options?.status ?? 'resolved';

    const updated = await prisma.complianceAlert.update({
      where: { id },
      data: {
        status,
        resolvedAt: new Date(),
        resolvedBy: adminUserId,
        resolutionNote: options?.resolutionNote,
      },
    });

    await writeAdminAudit({
      adminUserId,
      action: 'admin_compliance_alert_resolve',
      resource: 'compliance_alert',
      resourceId: id,
      metadata: { status, resolutionNote: options?.resolutionNote },
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
    });

    return mapComplianceAlert(updated);
  },

  async generateComplianceReport(): Promise<ComplianceReportSummary> {
    const [
      kycPending,
      kycApproved,
      kycRejected,
      kycReview,
      openAlerts,
      resolvedAlerts,
      dismissedAlerts,
      severityGroups,
      flaggedTransactions,
    ] = await Promise.all([
      prisma.kYCRecord.count({ where: { status: 'pending' } }),
      prisma.kYCRecord.count({ where: { status: 'approved' } }),
      prisma.kYCRecord.count({ where: { status: 'rejected' } }),
      prisma.kYCRecord.count({ where: { status: 'review' } }),
      prisma.complianceAlert.count({ where: { status: 'open' } }),
      prisma.complianceAlert.count({ where: { status: 'resolved' } }),
      prisma.complianceAlert.count({ where: { status: 'dismissed' } }),
      prisma.complianceAlert.groupBy({
        by: ['severity'],
        _count: { severity: true },
      }),
      prisma.transaction.count({ where: { isFlagged: true } }),
    ]);

    const bySeverity: Record<string, number> = {};
    for (const group of severityGroups) {
      bySeverity[group.severity] = group._count.severity;
    }

    return {
      generatedAt: new Date(),
      kyc: {
        pending: kycPending,
        approved: kycApproved,
        rejected: kycRejected,
        review: kycReview,
      },
      alerts: {
        open: openAlerts,
        resolved: resolvedAlerts,
        dismissed: dismissedAlerts,
        bySeverity,
      },
      flaggedTransactions,
    };
  },

  async getSystemHealth(): Promise<SystemHealth> {
    const [database, redis, stellar] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkStellar(),
    ]);

    return {
      status: deriveHealthStatus(database, redis, stellar),
      database,
      redis,
      stellar,
      uptime: process.uptime(),
      version: APP_VERSION,
    };
  },

  async getPerformanceMetrics(): Promise<AdminPerformanceMetrics> {
    const memory = process.memoryUsage();

    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      bannedUsers,
      totalTransactions,
      pendingTransactions,
      completedTransactions,
      failedTransactions,
      flaggedTransactions,
      openAlerts,
      resolvedAlerts,
      security,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: 'active' } }),
      prisma.user.count({ where: { status: 'suspended' } }),
      prisma.user.count({ where: { status: 'banned' } }),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'pending' } }),
      prisma.transaction.count({ where: { status: 'completed' } }),
      prisma.transaction.count({ where: { status: 'failed' } }),
      prisma.transaction.count({ where: { isFlagged: true } }),
      prisma.complianceAlert.count({ where: { status: 'open' } }),
      prisma.complianceAlert.count({ where: { status: 'resolved' } }),
      SecurityService.getSecurityMetrics(),
    ]);

    return {
      uptime: process.uptime(),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      users: {
        total: totalUsers,
        active: activeUsers,
        suspended: suspendedUsers,
        banned: bannedUsers,
      },
      transactions: {
        total: totalTransactions,
        pending: pendingTransactions,
        completed: completedTransactions,
        failed: failedTransactions,
        flagged: flaggedTransactions,
      },
      compliance: {
        openAlerts,
        resolvedAlerts,
      },
      security: {
        totalBlockedIps: security.totalBlockedIps,
        totalFlaggedIps: security.totalFlaggedIps,
        totalFailedAttempts: security.totalFailedAttempts,
      },
      jobQueue: jobQueueService.getStatus(),
    };
  },

  async getSystemLogs(filters: {
    userId?: string;
    action?: string;
    resource?: string;
    success?: boolean;
    startDate?: string;
    endDate?: string;
    page: number;
    limit: number;
  }): Promise<Awaited<ReturnType<typeof AuditService.query>>> {
    return AuditService.query(filters);
  },

  async getPlatformConfig(): Promise<SystemConfigEntry[]> {
    const configs = await prisma.systemConfig.findMany({
      orderBy: { key: 'asc' },
    });

    return configs.map((config) => ({
      id: config.id,
      key: config.key,
      value: config.value,
      description: config.description,
      updatedBy: config.updatedBy,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    }));
  },

  async updatePlatformConfig(
    entries: Array<{ key: string; value: unknown; description?: string }>,
    adminUserId: string,
    context?: { ipAddress?: string; userAgent?: string }
  ): Promise<SystemConfigEntry[]> {
    if (entries.length === 0) {
      throw new AppError(400, 'At least one configuration entry is required');
    }

    return prisma.$transaction(async (tx) => {
      const updatedEntries: SystemConfigEntry[] = [];

      for (const entry of entries) {
        const previous = await tx.systemConfig.findUnique({ where: { key: entry.key } });

        const updated = await tx.systemConfig.upsert({
          where: { key: entry.key },
          create: {
            key: entry.key,
            value: entry.value as Prisma.InputJsonValue,
            description: entry.description,
            updatedBy: adminUserId,
          },
          update: {
            value: entry.value as Prisma.InputJsonValue,
            description: entry.description,
            updatedBy: adminUserId,
          },
        });

        updatedEntries.push({
          id: updated.id,
          key: updated.key,
          value: updated.value,
          description: updated.description,
          updatedBy: updated.updatedBy,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        });

        // Do not persist raw config payloads — values may contain secrets
        await tx.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'admin_config_update',
            resource: 'system_config',
            resourceId: updated.id,
            metadata: {
              key: entry.key,
              changed: true,
              hadPreviousValue: previous !== null,
            },
            ipAddress: context?.ipAddress,
            userAgent: context?.userAgent,
            success: true,
          },
        });
      }

      return updatedEntries;
    });
  },

  async getConfigAuditHistory(
    page: number,
    limit: number
  ): Promise<Awaited<ReturnType<typeof AuditService.query>>> {
    return AuditService.query({
      action: 'admin_config_update',
      resource: 'system_config',
      page,
      limit,
    });
  },
};
