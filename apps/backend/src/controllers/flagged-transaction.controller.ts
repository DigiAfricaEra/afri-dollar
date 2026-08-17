import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { AdminService } from '../services/admin.service';

import { handleError, requireUser, getRequestContext } from './admin.controller';

const flaggedTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const reviewTransactionSchema = z.object({
  action: z.enum(['release', 'block', 'reviewing']),
  note: z.string().max(2000).optional(),
});

const transactionIdParamSchema = z.object({
  id: z.string().min(1),
});

export const FlaggedTransactionController = {
  async listFlagged(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const { page, limit } = flaggedTransactionsQuerySchema.parse(req.query);
      const result = await AdminService.listFlaggedTransactions(page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getFlaggedStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const stats = await AdminService.getFlaggedTransactionStats();

      res.status(200).json({
        success: true,
        data: stats,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async reviewTransaction(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminUserId = requireUser(req, res);
      if (!adminUserId) return;

      const { id } = transactionIdParamSchema.parse(req.params);
      const { action, note } = reviewTransactionSchema.parse(req.body);
      const transaction = await AdminService.reviewFlaggedTransaction(id, action, adminUserId, {
        note,
        ...getRequestContext(req),
      });

      res.status(200).json({
        success: true,
        data: transaction,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
