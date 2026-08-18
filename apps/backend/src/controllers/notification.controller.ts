import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { NotificationService } from '../services/notification.service';
import { AppError } from '../types';

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
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }

  if (error instanceof Error) {
    const errorMap: Record<string, number> = {
      'Invalid push subscription': 400,
      'Push subscription not found': 404,
    };

    const status = errorMap[error.message] || 500;
    const clientMessage = status === 500 ? 'An error occurred' : error.message;

    res.status(status).json({
      success: false,
      error: clientMessage,
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

export const NotificationController = {
  /**
   * GET /api/v1/notifications?page&limit&unreadOnly
   */
  async listNotifications(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { page, limit, unreadOnly } = req.query;
      const result = await NotificationService.getNotifications(userId, {
        page: typeof page === 'string' ? Number(page) : undefined,
        limit: typeof limit === 'string' ? Number(limit) : undefined,
        unreadOnly: unreadOnly === 'true',
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * POST /api/v1/notifications/read
   * Body: { ids: string[] }
   */
  async markRead(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { ids } = z
        .object({
          ids: z.array(z.string().min(1)).min(1, 'At least one notification id is required'),
        })
        .parse(req.body);

      const markedRead = await NotificationService.markRead(userId, ids);

      res.status(200).json({
        success: true,
        data: { markedRead },
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * GET /api/v1/notifications/preferences
   */
  async getPreferences(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const preferences = await NotificationService.getPreferences(userId);

      res.status(200).json({
        success: true,
        data: preferences,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * PUT /api/v1/notifications/preferences
   */
  async updatePreferences(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const preferences = z
        .object({
          email: z.boolean().optional(),
          sms: z.boolean().optional(),
          push: z.boolean().optional(),
          transactionAlerts: z.boolean().optional(),
          securityAlerts: z.boolean().optional(),
          payrollAlerts: z.boolean().optional(),
          marketing: z.boolean().optional(),
        })
        .parse(req.body);

      const updated = await NotificationService.updatePreferences(userId, preferences);

      res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * POST /api/v1/notifications/push-subscriptions
   */
  async registerPushSubscription(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const body = z
        .object({
          endpoint: z.string().url('Invalid endpoint URL'),
          keys: z.object({
            p256dh: z.string().min(1),
            auth: z.string().min(1),
          }),
          userAgent: z.string().optional(),
        })
        .parse(req.body);

      const subscription = await NotificationService.registerPushSubscription(userId, body);

      res.status(201).json({
        success: true,
        data: subscription,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * DELETE /api/v1/notifications/push-subscriptions/:id
   */
  async deletePushSubscription(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const deleted = await NotificationService.deletePushSubscription(userId, id);

      if (!deleted) {
        res.status(404).json({ success: false, error: 'Push subscription not found' });
        return;
      }

      res.status(200).json({
        success: true,
        data: { deleted },
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * GET /api/v1/notifications/push-subscriptions
   */
  async listPushSubscriptions(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const subscriptions = await NotificationService.getPushSubscriptions(userId);

      res.status(200).json({
        success: true,
        data: subscriptions,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
