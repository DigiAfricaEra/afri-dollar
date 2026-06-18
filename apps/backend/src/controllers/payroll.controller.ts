/**
 * Payroll Controller
 * Handles payroll-related HTTP requests
 */
import type { Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { PayrollService } from '../services/payroll.service';
import { AppError } from '../types';
import type { CreatePayrollBatchOptions } from '../types';
import { batchIdParamSchema } from '../utils/validation';

/**
 * Maps standard runtime errors using the app error pattern
 */
function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }

  if (error instanceof Error) {
    const errorMap: Record<string, number> = {
      'Wallet not found': 404,
      'Wallet does not belong to user': 404,
      'Payroll batch not found': 404,
      'Cannot add items to a batch that is not pending approval': 400,
      'Only pending batches can be approved': 400,
      'Only approved batches can be processed': 400,
      'Batch is already being processed': 409,
      'Invalid Stellar recipient address': 400,
      'Amount must be a positive number': 400,
      'Asset code must be a non-empty alphanumeric string of 1 to 12 characters': 400,
      'Asset issuer is required for non-XLM assets': 400,
      'Invalid Stellar asset issuer address': 400,
      'Asset issuer must not be provided for XLM (native asset)': 400,
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

export const PayrollController = {
  async createBatch(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      // Cast cleanly to the specific options configuration your service layer expects
      const validatedData = req.body as CreatePayrollBatchOptions;
      const batch = await PayrollService.createPayrollBatch(validatedData, userId);

      res.status(201).json({
        success: true,
        data: batch,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async listBatches(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const batches = await PayrollService.getPayrollBatches(userId);

      res.status(200).json({
        success: true,
        data: batches,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getBatch(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = batchIdParamSchema.parse(req.params);
      const batch = await PayrollService.getPayrollBatch(id, userId);

      res.status(200).json({
        success: true,
        data: batch,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async addItem(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = batchIdParamSchema.parse(req.params);

      // Inline the exact interface expected by the parameter to bridge the null vs undefined gap
      const validatedData = req.body as {
        recipientAddress: string;
        amount: string;
        assetCode: string;
        assetIssuer?: string;
        memo?: string;
      };

      const item = await PayrollService.addPayrollItem(id, validatedData, userId);

      res.status(201).json({
        success: true,
        data: item,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async approveBatch(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = batchIdParamSchema.parse(req.params);
      const batch = await PayrollService.approvePayrollBatch(id, userId);

      res.status(200).json({
        success: true,
        data: batch,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async processBatch(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { id } = batchIdParamSchema.parse(req.params);
      const result = await PayrollService.processPayrollBatch(id, userId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getHistory(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const history = await PayrollService.getPayrollHistory(userId);

      res.status(200).json({
        success: true,
        data: history,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
