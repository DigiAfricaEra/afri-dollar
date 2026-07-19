import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { AdminService } from '../services/admin.service';
import { AppError } from '../types';
import { queryBooleanSchema } from '../utils/validation';

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const listUsersQuerySchema = paginationSchema.extend({
  status: z.enum(['active', 'suspended', 'banned']).optional(),
  role: z.enum(['USER', 'BUSINESS', 'ADMIN', 'AUDITOR']).optional(),
  email: z.string().optional(),
  kycStatus: z.string().optional(),
});

const userIdParamSchema = z.object({
  id: z.string().min(1),
});

const updateUserStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'banned']),
});

const listTransactionsQuerySchema = paginationSchema.extend({
  status: z.string().optional(),
  type: z.string().optional(),
  userId: z.string().optional(),
  assetCode: z.string().optional(),
  isFlagged: queryBooleanSchema,
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

const flagTransactionSchema = z.object({
  reason: z.string().min(1, 'Flag reason is required').max(1000),
});

const listComplianceAlertsQuerySchema = paginationSchema.extend({
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  severity: z.string().optional(),
  type: z.string().optional(),
  userId: z.string().optional(),
});

const resolveComplianceAlertSchema = z.object({
  status: z.enum(['resolved', 'dismissed']).optional(),
  resolutionNote: z.string().max(2000).optional(),
});

const systemLogsQuerySchema = paginationSchema.extend({
  userId: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  success: queryBooleanSchema,
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

const updateConfigSchema = z.object({
  configs: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        value: z.any(),
        description: z.string().max(500).optional(),
      })
    )
    .min(1)
    .max(50),
});

function handleError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      success: false,
      error: 'Validation error',
      details: error.errors,
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      success: false,
      error: error.message,
    });
    return;
  }

  console.error('Admin controller error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

function requireUser(req: AuthRequest, res: Response): string | null {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized',
    });
    return null;
  }
  return req.user.userId;
}

function getRequestContext(req: AuthRequest): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: req.ip,
    userAgent: req.get('user-agent') || undefined,
  };
}

export const AdminController = {
  async listUsers(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const filters = listUsersQuerySchema.parse(req.query);
      const result = await AdminService.listUsers(filters);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getUser(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const { id } = userIdParamSchema.parse(req.params);
      const user = await AdminService.getUserById(id);

      res.status(200).json({ success: true, data: user });
    } catch (error) {
      handleError(res, error);
    }
  },

  async updateUserStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminUserId = requireUser(req, res);
      if (!adminUserId) return;

      const { id } = userIdParamSchema.parse(req.params);
      const { status } = updateUserStatusSchema.parse(req.body);
      const user = await AdminService.updateUserStatus(
        id,
        status,
        adminUserId,
        getRequestContext(req)
      );

      res.status(200).json({ success: true, data: user });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getUserActivity(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const { id } = userIdParamSchema.parse(req.params);
      const { page, limit } = paginationSchema.parse(req.query);
      const result = await AdminService.getUserActivity(id, page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async listTransactions(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const filters = listTransactionsQuerySchema.parse(req.query);
      const result = await AdminService.listTransactions(filters);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getTransaction(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const { id } = userIdParamSchema.parse(req.params);
      const transaction = await AdminService.getTransactionById(id);

      res.status(200).json({ success: true, data: transaction });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getTransactionAlerts(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const { page, limit } = paginationSchema.parse(req.query);
      const result = await AdminService.getTransactionAlerts(page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async flagTransaction(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminUserId = requireUser(req, res);
      if (!adminUserId) return;

      const { id } = userIdParamSchema.parse(req.params);
      const { reason } = flagTransactionSchema.parse(req.body);
      const transaction = await AdminService.flagTransaction(
        id,
        reason,
        adminUserId,
        getRequestContext(req)
      );

      res.status(200).json({ success: true, data: transaction });
    } catch (error) {
      handleError(res, error);
    }
  },

  async listComplianceAlerts(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const filters = listComplianceAlertsQuerySchema.parse(req.query);
      const result = await AdminService.listComplianceAlerts(filters);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async resolveComplianceAlert(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminUserId = requireUser(req, res);
      if (!adminUserId) return;

      const { id } = userIdParamSchema.parse(req.params);
      const body = resolveComplianceAlertSchema.parse(req.body ?? {});
      const alert = await AdminService.resolveComplianceAlert(id, adminUserId, {
        ...body,
        ...getRequestContext(req),
      });

      res.status(200).json({ success: true, data: alert });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getComplianceReports(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const report = await AdminService.generateComplianceReport();

      res.status(200).json({ success: true, data: report });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getSystemHealth(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const health = await AdminService.getSystemHealth();

      res.status(200).json({ success: true, data: health });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getMetrics(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const metrics = await AdminService.getPerformanceMetrics();

      res.status(200).json({ success: true, data: metrics });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getLogs(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const filters = systemLogsQuerySchema.parse(req.query);
      const result = await AdminService.getSystemLogs(filters);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getConfig(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const config = await AdminService.getPlatformConfig();

      res.status(200).json({ success: true, data: config });
    } catch (error) {
      handleError(res, error);
    }
  },

  async updateConfig(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminUserId = requireUser(req, res);
      if (!adminUserId) return;

      const { configs } = updateConfigSchema.parse(req.body);
      const updated = await AdminService.updatePlatformConfig(
        configs.map((entry) => ({
          key: entry.key,
          value: entry.value as unknown,
          description: entry.description,
        })),
        adminUserId,
        getRequestContext(req)
      );

      res.status(200).json({ success: true, data: updated });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getConfigAudit(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const { page, limit } = paginationSchema.parse(req.query);
      const result = await AdminService.getConfigAuditHistory(page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
