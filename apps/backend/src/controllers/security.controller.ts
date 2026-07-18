import type { Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { SecurityService } from '../services/security.service';
import type { SecurityMetrics } from '../types';
import { handleError } from '../utils';

export const SecurityController = {
  async getBlockedIps(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const metrics = res.locals.securityMetrics as SecurityMetrics | undefined;
      const blockedIps = metrics?.blockedIps ?? (await SecurityService.getBlockedIps());
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
      const metrics = res.locals.securityMetrics as SecurityMetrics | undefined;
      const flaggedIps = metrics?.flaggedIps ?? (await SecurityService.getFlaggedIps());
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
      const metrics =
        (res.locals.securityMetrics as SecurityMetrics | undefined) ??
        (await SecurityService.getSecurityMetrics());
      res.status(200).json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
