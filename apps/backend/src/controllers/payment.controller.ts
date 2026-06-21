import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { PaymentService } from '../services/payment.service';
import { AppError } from '../types';
import type { CreateCrossBorderPaymentOptions } from '../types/payment.types';
import { paymentIdParamSchema } from '../utils/validation';

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
      'Invalid Stellar destination address': 400,
      'Amount must be a positive number': 400,
      'Asset code must be a non-empty alphanumeric string of 1 to 12 characters': 400,
      'Asset issuer is required for non-XLM assets': 400,
      'Invalid Stellar asset issuer address': 400,
      'Asset issuer must not be provided for XLM (native asset)': 400,
      'Wallet not found': 404,
      'Wallet does not belong to user': 404,
      'Payment not found': 404,
      'Payment blocked: sanctions screening failed': 403,
      'Payment blocked: beneficiary information required for amounts >= 1000': 400,
      'Only created payments can be processed': 400,
      'Payment is already being processed': 409,
      'Only created or pending payments can be cancelled': 400,
      'Wallet decryption failure': 500,
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

export const PaymentController = {
  async createPayment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const options = req.body as CreateCrossBorderPaymentOptions;
      const result = await PaymentService.createCrossBorderPayment(options, userId);

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async processPayment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = paymentIdParamSchema.parse(req.params);
      const result = await PaymentService.processPayment(id, userId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getPaymentStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = paymentIdParamSchema.parse(req.params);
      const status = await PaymentService.getPaymentStatus(id, userId);

      res.status(200).json({
        success: true,
        data: status,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getPaymentHistory(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const walletIdParam = req.query.walletId;
      if (walletIdParam !== undefined && typeof walletIdParam !== 'string') {
        res.status(400).json({ success: false, error: 'walletId must be a string' });
        return;
      }
      const history = await PaymentService.getPaymentHistory(userId, walletIdParam);

      res.status(200).json({
        success: true,
        data: history,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async cancelPayment(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = paymentIdParamSchema.parse(req.params);
      const result = await PaymentService.cancelPayment(id, userId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
