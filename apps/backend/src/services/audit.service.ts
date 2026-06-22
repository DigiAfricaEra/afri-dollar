import type { Prisma } from '@prisma/client';

import prisma from '../config/database';

export interface AuditLogQuery {
  userId?: string;
  action?: string;
  resource?: string;
  success?: boolean;
  startDate?: string;
  endDate?: string;
  page: number;
  limit: number;
}

export interface PaginatedAuditLogs {
  data: Array<{
    id: string;
    userId: string | null;
    action: string;
    resource: string;
    resourceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    metadata: Prisma.JsonValue | null;
    success: boolean;
    createdAt: Date;
  }>;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export const AuditService = {
  async log(data: {
    action: string;
    resource: string;
    userId?: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
    success?: boolean;
  }): Promise<void> {
    const { metadata, ...rest } = data;

    try {
      await prisma.auditLog.create({
        data: {
          ...rest,
          metadata: metadata as any,
        },
      });
    } catch (error) {
      console.error('Failed to write audit log:', error);
    }
  },

  async query(filters: AuditLogQuery): Promise<PaginatedAuditLogs> {
    const where: Prisma.AuditLogWhereInput = {};

    if (filters.userId) {
      where.userId = filters.userId;
    }

    if (filters.action) {
      where.action = { contains: filters.action, mode: 'insensitive' };
    }

    if (filters.resource) {
      where.resource = { contains: filters.resource, mode: 'insensitive' };
    }

    if (filters.success !== undefined) {
      where.success = filters.success;
    }

    if (filters.startDate || filters.endDate) {
      where.createdAt = {};

      if (filters.startDate) {
        where.createdAt.gte = new Date(filters.startDate);
      }

      if (filters.endDate) {
        where.createdAt.lte = new Date(filters.endDate);
      }
    }

    const page = filters.page;
    const limit = filters.limit;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  },
};
