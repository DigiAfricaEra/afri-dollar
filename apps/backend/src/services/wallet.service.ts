import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../config/database';
import { AppError } from '../types';
import type { CreateWalletOptions, WalletWithKeys } from '../types';
import { encrypt } from '../utils/crypto';

const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const FRIENDBOT_TIMEOUT_MS = 30_000;

async function fundTestnetAccount(publicKey: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FRIENDBOT_TIMEOUT_MS);

  try {
    const response = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AppError(502, `Friendbot funding failed: ${response.status} ${body}`);
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AppError(504, 'Friendbot funding request timed out');
    }

    if (error instanceof TypeError) {
      throw new AppError(503, 'Friendbot funding failed: network error');
    }

    throw new AppError(502, `Friendbot funding failed: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

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
      await fundTestnetAccount(publicKey);
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
