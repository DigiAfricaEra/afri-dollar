/**
 * Treasury Controller
 * Handles treasury-related HTTP requests (admin only).
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { TreasuryService } from '../services/treasury.service';

const rebalanceSchema = z.object({
  targets: z
    .array(
      z.object({
        assetCode: z.string().min(1, 'Asset code is required'),
        assetIssuer: z.string().optional(),
        targetAllocation: z
          .number({ invalid_type_error: 'Target allocation must be a number' })
          .min(0, 'Target allocation must be between 0 and 100')
          .max(100, 'Target allocation must be between 0 and 100'),
      })
    )
    .min(1, 'At least one rebalance target is required'),
});

const historyQuerySchema = z.object({
  type: z.enum(['deposit', 'withdrawal', 'rebalance', 'transfer']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

function getErrorResponse(error: Error): { status: number; message: string } {
  const errorMap: Record<string, { status: number; message: string }> = {
    'No treasury wallet found': { status: 404, message: 'No treasury wallet found' },
    'Treasury has no value to rebalance': {
      status: 400,
      message: 'Treasury has no value to rebalance',
    },
    'Target allocations must sum to 100 percent': {
      status: 400,
      message: 'Target allocations must sum to 100 percent',
    },
    'Allocation must be between 0 and 100': {
      status: 400,
      message: 'Allocation must be between 0 and 100',
    },
    'Duplicate asset in rebalance targets': {
      status: 400,
      message: 'Duplicate asset in rebalance targets',
    },
    'At least one rebalance target is required': {
      status: 400,
      message: 'At least one rebalance target is required',
    },
  };

  if (error.message.startsWith('No USD exchange rate available for asset')) {
    return { status: 400, message: error.message };
  }

  return errorMap[error.message] || { status: 500, message: 'An error occurred' };
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      success: false,
      error: 'Validation error',
      details: error.errors,
    });
    return;
  }

  if (error instanceof Error) {
    const { status, message } = getErrorResponse(error);
    res.status(status).json({
      success: false,
      error: message,
    });
    return;
  }

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

export const TreasuryController = {
  async getBalance(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const balance = await TreasuryService.getTreasuryBalance();

      res.status(200).json({
        success: true,
        data: balance,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getPositions(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const positions = await TreasuryService.getTreasuryPositions();

      res.status(200).json({
        success: true,
        data: positions,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async rebalance(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { targets } = rebalanceSchema.parse(req.body);
      const operations = await TreasuryService.rebalance(targets, userId);

      res.status(200).json({
        success: true,
        data: operations,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getHistory(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!requireUser(req, res)) return;

      const filters = historyQuerySchema.parse(req.query);
      const history = await TreasuryService.getTreasuryHistory(filters);

      res.status(200).json({
        success: true,
        data: history,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
