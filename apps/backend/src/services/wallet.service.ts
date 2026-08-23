import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../config/database';
import { AppError } from '../types';
import type { CreateWalletOptions, WalletWithKeys } from '../types';
import type { PaymentRecord } from '../types/transaction.types';
import { encrypt } from '../utils/crypto';

import { StellarService } from './stellar.service';
import { TransactionService } from './transaction.service';
import { WebhookService } from './webhook.service';

export const WalletService = {
  async createWallet(options: CreateWalletOptions): Promise<WalletWithKeys> {
    const user = await prisma.user.findUnique({
      where: { id: options.userId },
    });

    if (!user) {
      throw new AppError(404, 'User not found');
    }

    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();
    const secretKey = keypair.secret();

    const secretKeyEncrypted = encrypt(secretKey);

    if (options.network === 'testnet') {
      await StellarService.fundTestnetAccount(publicKey);
    }

    const wallet = await prisma.wallet.create({
      data: {
        userId: options.userId,
        publicKey,
        secretKeyEncrypted,
        walletType: options.walletType,
        network: options.network,
      },
    });

    await WebhookService.emitEvent({
      eventType: 'wallet.created',
      payload: { walletId: wallet.id, walletType: wallet.walletType, network: wallet.network },
      userId: options.userId,
    });

    return {
      id: wallet.id,
      publicKey: wallet.publicKey,
      secretKey,
    };
  },

  /**
   * Sends funds directly from a wallet the user owns, moving real value on
   * Stellar via TransactionService (build → sign → submit → track).
   */
  async sendFromWallet(
    walletId: string,
    userId: string,
    params: {
      destination: string;
      amount: string;
      assetCode: string;
      assetIssuer?: string;
      memo?: string;
    }
  ): Promise<PaymentRecord> {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet) {
      throw new AppError(404, 'Wallet not found');
    }
    if (wallet.userId !== userId) {
      throw new AppError(403, 'Wallet does not belong to user');
    }

    return TransactionService.buildAndSubmitPayment({
      sourceWalletId: wallet.id,
      userId,
      destination: params.destination,
      amount: params.amount,
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
      memo: params.memo,
    });
  },
};
