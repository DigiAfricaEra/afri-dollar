import type { Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { StellarService } from '../services/stellar.service';
import { AppError } from '../types';

/**
 * Sends a JSON error response for AppError instances or a generic 500 otherwise.
 */
function handleError(res: Response, error: unknown): void {
  if (error instanceof AppError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }

  if (error instanceof Error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
    return;
  }

  res.status(500).json({ success: false, error: 'An unknown error occurred' });
}

export const StellarController = {
  /**
   * GET /api/v1/stellar/balances/:publicKey
   * Returns Stellar account balances for the given public key.
   */
  async getBalances(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { publicKey } = req.params as { publicKey: string };
      const balances = await StellarService.getAccountBalances(publicKey);

      res.status(200).json({ success: true, data: balances });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * GET /api/v1/stellar/transactions/:publicKey
   * Returns paginated transaction history, optional limit and cursor query params.
   */
  async getTransactions(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { publicKey } = req.params as { publicKey: string };
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const cursor = req.query.cursor as string | undefined;

      const transactions = await StellarService.getAccountTransactions(publicKey, {
        limit: isNaN(limit as number) ? undefined : limit,
        cursor,
      });

      res.status(200).json({ success: true, data: transactions });
    } catch (error) {
      handleError(res, error);
    }
  },

  /**
   * POST /api/v1/stellar/fund/:publicKey
   * Funds a Stellar testnet account via Friendbot (testnet only).
   */
  async fundAccount(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { publicKey } = req.params as { publicKey: string };
      await StellarService.fundTestnetAccount(publicKey);

      res.status(200).json({ success: true, message: 'Testnet account funded successfully' });
    } catch (error) {
      handleError(res, error);
    }
  },
};
