import type { Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { SecurityService } from '../services/security.service';
import { AppError } from '../types';

function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }

  res.status(500).json({ success: false, error: 'Internal server error' });
}

export const SecurityController = {
  async getBlockedIps(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const blockedIps = await SecurityService.getBlockedIps();
      res.status(200).json({
        success: true,
        data: blockedIps,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getFlaggedIps(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const flaggedIps = await SecurityService.getFlaggedIps();
      res.status(200).json({
        success: true,
        data: flaggedIps,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getMetrics(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const metrics = await SecurityService.getSecurityMetrics();
      res.status(200).json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
