import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { WebhookService } from '../services/webhook.service';
import { AppError } from '../types';
import type { CreateWebhookOptions } from '../types/webhook.types';
import {
  createWebhookSchema,
  webhookIdParamSchema,
  webhookDeliveryQuerySchema,
} from '../utils/validation';

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
      'Webhook not found': 404,
      'Invalid webhook URL': 400,
      'At least one event is required': 400,
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

export const WebhookController = {
  async createWebhook(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const options = createWebhookSchema.parse(req.body) as CreateWebhookOptions;
      const result = await WebhookService.createWebhook(options, userId);

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async listWebhooks(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const webhooks = await WebhookService.listWebhooks(userId);

      res.status(200).json({
        success: true,
        data: webhooks,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async deleteWebhook(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = webhookIdParamSchema.parse(req.params);
      await WebhookService.deleteWebhook(id, userId);

      res.status(200).json({
        success: true,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async testWebhook(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = webhookIdParamSchema.parse(req.params);
      const result = await WebhookService.testWebhook(id, userId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getDeliveries(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = webhookIdParamSchema.parse(req.params);
      const query = webhookDeliveryQuerySchema.parse(req.query);
      const result = await WebhookService.getDeliveries(id, userId, {
        limit: query.limit,
        cursor: query.cursor,
      });

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
