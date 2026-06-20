import { Response } from 'express';

import type { AuthRequest } from '../middleware/auth.middleware';
import { WalletService } from '../services/wallet.service';
import { AppError } from '../types';

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

export const WalletController = {
  async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { walletType, network } = req.body as {
        walletType: 'business' | 'treasury' | 'payroll';
        network?: 'testnet' | 'mainnet';
      };

      const resolvedNetwork = network || 'testnet';

      const wallet = await WalletService.createWallet({
        userId: req.user!.userId,
        walletType,
        network: resolvedNetwork,
      });

      res.status(201).json({
        success: true,
        data: wallet,
      });
    } catch (error) {
      handleError(res, error);
    }
  },
};
