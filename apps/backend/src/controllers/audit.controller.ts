import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { AuditService } from '../services/audit.service';
import { queryBooleanSchema } from '../utils/validation';

const auditLogQuerySchema = z.object({
  userId: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  success: queryBooleanSchema,
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
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

  console.error('Audit query error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

export const AuditController = {
  async queryLogs(req: AuthRequest, res: Response): Promise<void> {
    try {
      const filters = auditLogQuerySchema.parse(req.query);

      const result = await AuditService.query(filters);

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
