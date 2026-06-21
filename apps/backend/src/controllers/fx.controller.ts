import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { FXService } from '../services/fx.service';

const getRatesSchema = z.object({
  fromAsset: z.string().optional(),
  toAsset: z.string().optional(),
});

const createQuoteSchema = z.object({
  fromAsset: z.string().min(1, 'From asset is required'),
  toAsset: z.string().min(1, 'To asset is required'),
  amount: z.string().min(1, 'Amount is required'),
});

const convertSchema = z.object({
  quoteId: z.string().min(1, 'Quote ID is required'),
  walletId: z.string().min(1, 'Wallet ID is required'),
});

const historySchema = z.object({
  walletId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

const upsertRateSchema = z.object({
  fromAsset: z.string().min(1, 'From asset is required'),
  toAsset: z.string().min(1, 'To asset is required'),
  rate: z.string().min(1, 'Rate is required'),
});

function getErrorResponse(error: Error): { status: number; message: string } {
  const errorMap: Record<string, { status: number; message: string }> = {
    'Amount must be a positive number': {
      status: 400,
      message: 'Amount must be a positive number',
    },
    'From and to assets must be different': {
      status: 400,
      message: 'From and to assets must be different',
    },
    'FX rate not available': {
      status: 404,
      message: 'FX rate not available for the requested pair',
    },
    'Quote not found': {
      status: 404,
      message: 'Quote not found',
    },
    'Quote has expired': {
      status: 400,
      message: 'Quote has expired',
    },
    'Quote has already been used': {
      status: 409,
      message: 'Quote has already been used',
    },
    'Wallet not found': {
      status: 404,
      message: 'Wallet not found',
    },
    'Insufficient balance': {
      status: 400,
      message: 'Insufficient balance',
    },
    'Exchange rate not found': {
      status: 404,
      message: 'Exchange rate not found',
    },
    'Exchange rate is already inactive': {
      status: 400,
      message: 'Exchange rate is already inactive',
    },
  };

  return errorMap[error.message] || { status: 500, message: 'An error occurred' };
}

export const FXController = {
  async getRates(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedQuery = getRatesSchema.parse(req.query);
      const rates = await FXService.getCurrentRates(validatedQuery);

      res.status(200).json({
        success: true,
        data: rates,
      });
    } catch (error) {
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
  },

  async createQuote(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedBody = createQuoteSchema.parse(req.body);
      const quote = await FXService.calculateQuote({
        fromAsset: validatedBody.fromAsset,
        toAsset: validatedBody.toAsset,
        fromAmount: validatedBody.amount,
      });

      res.status(201).json({
        success: true,
        data: quote,
      });
    } catch (error) {
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
  },

  async convert(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
        return;
      }

      const validatedBody = convertSchema.parse(req.body);
      const result = await FXService.executeConversion(validatedBody, req.user.userId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
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
  },

  async history(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
        return;
      }

      const validatedQuery = historySchema.parse(req.query);
      const history = await FXService.getConversionHistory(req.user.userId, {
        walletId: validatedQuery.walletId,
        limit: validatedQuery.limit,
        cursor: validatedQuery.cursor,
        fromDate: validatedQuery.fromDate,
        toDate: validatedQuery.toDate,
      });

      res.status(200).json({
        success: true,
        data: history,
      });
    } catch (error) {
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
  },

  async upsertRate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const validatedBody = upsertRateSchema.parse(req.body);
      const rate = await FXService.upsertRate(validatedBody);

      res.status(201).json({
        success: true,
        data: rate,
      });
    } catch (error) {
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
  },

  async deactivateRate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Rate ID is required',
        });
        return;
      }

      await FXService.deactivateRate(id);

      res.status(200).json({
        success: true,
        data: { message: 'Exchange rate deactivated' },
      });
    } catch (error) {
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
  },
};
