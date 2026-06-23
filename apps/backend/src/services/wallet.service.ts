import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../config/database';
import { AppError } from '../types';
import type { CreateWalletOptions, WalletWithKeys } from '../types';
import { encrypt } from '../utils/crypto';

import { StellarService } from './stellar.service';

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

    return {
      id: wallet.id,
      publicKey: wallet.publicKey,
      secretKey,
    };
  },
};
