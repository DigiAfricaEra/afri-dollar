import {
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Asset,
  Memo,
  StrKey,
} from '@stellar/stellar-sdk';

import prisma from '../config/database';
import { AppError } from '../types';
import { decrypt } from '../utils/crypto';

import { StellarService } from './stellar.service';

const server = StellarService.getHorizonServer();

export interface CreatePaymentOptions {
  walletId: string;
  toAddress: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
}

export interface TransactionResult {
  success: boolean;
  stellarTxId?: string;
  status: 'pending' | 'completed' | 'failed';
  errorMessage?: string;
}

export const TransactionService = {
  /**
   * Build a Stellar payment transaction (does not sign or submit).
   */
  async buildPaymentTransaction(
    sourcePublicKey: string,
    options: CreatePaymentOptions
  ): Promise<TransactionBuilder> {
    if (!StrKey.isValidEd25519PublicKey(options.toAddress)) {
      throw new AppError(400, 'Invalid Stellar destination address');
    }

    const amountNum = parseFloat(options.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new AppError(400, 'Amount must be a positive number');
    }

    if (!options.assetCode || !/^[a-zA-Z0-9]{1,12}$/.test(options.assetCode)) {
      throw new AppError(400, 'Asset code must be a non-empty alphanumeric string of 1 to 12 characters');
    }

    if (options.assetCode !== 'XLM') {
      if (!options.assetIssuer) {
        throw new AppError(400, 'Asset issuer is required for non-XLM assets');
      }
      if (!StrKey.isValidEd25519PublicKey(options.assetIssuer)) {
        throw new AppError(400, 'Invalid Stellar asset issuer address');
      }
    } else if (options.assetIssuer) {
      throw new AppError(400, 'Asset issuer must not be provided for XLM (native asset)');
    }

    const networkPassphrase =
      process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const txBuilder = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase,
    });

    if (options.memo) {
      txBuilder.addMemo(Memo.text(options.memo));
    }

    const asset = options.assetIssuer
      ? new Asset(options.assetCode, options.assetIssuer)
      : Asset.native();

    txBuilder.addOperation(
      Operation.payment({
        destination: options.toAddress,
        asset,
        amount: options.amount,
      })
    );

    txBuilder.setTimeout(60);

    return txBuilder;
  },

  /**
   * Sign a Stellar transaction with the wallet's secret key.
   */
  signTransaction(transaction: TransactionBuilder, secretKey: string): ReturnType<TransactionBuilder['build']> {
    const keypair = Keypair.fromSecret(secretKey);
    const tx = transaction.build();
    tx.sign(keypair);
    return tx;
  },

  /**
   * Submit a signed Stellar transaction to the network.
   */
  async submitTransaction(
    signedTransaction: ReturnType<TransactionBuilder['build']>
  ): Promise<{ hash: string }> {
    try {
      const response = await server.submitTransaction(signedTransaction);
      return { hash: response.hash };
    } catch (error: unknown) {
      const err = error as Record<string, unknown>;
      let message = 'Stellar transaction submission failed';

      if (err && typeof err === 'object') {
        const response = err.response as Record<string, unknown> | undefined;
        const data = response?.data as Record<string, unknown> | undefined;
        const extras = data?.extras as Record<string, unknown> | undefined;
        const resultCodes = extras?.result_codes as Record<string, unknown> | undefined;

        if (resultCodes) {
          const txCode = typeof resultCodes.transaction === 'string'
            ? resultCodes.transaction
            : 'unknown';
          const opCodes = Array.isArray(resultCodes.operations)
            ? resultCodes.operations.join(', ')
            : '';
          message = `Stellar transaction failed. Transaction Code: ${txCode}. Operations Codes: [${opCodes}]`;
        } else if (typeof err.message === 'string') {
          message = err.message;
        }
      }

      throw new AppError(502, message);
    }
  },

  /**
   * Build, sign, and submit a payment transaction in one step.
   * Stores the transaction record in the database.
   */
  async createPayment(
    userId: string,
    options: CreatePaymentOptions
  ): Promise<TransactionResult> {
    const wallet = await prisma.wallet.findUnique({
      where: { id: options.walletId },
    });

    if (!wallet) {
      throw new AppError(404, 'Wallet not found');
    }

    if (wallet.userId !== userId) {
      throw new AppError(403, 'Wallet does not belong to user');
    }

    // Create pending transaction record
    const txRecord = await prisma.transaction.create({
      data: {
        userId,
        walletId: options.walletId,
        type: 'transfer',
        status: 'pending',
        amount: options.amount,
        assetCode: options.assetCode,
        assetIssuer: options.assetIssuer || null,
        fromAddress: wallet.publicKey,
        toAddress: options.toAddress,
        metadata: {
          memo: options.memo || null,
        },
      },
    });

    try {
      // Build transaction
      const txBuilder = await this.buildPaymentTransaction(wallet.publicKey, options);

      // Decrypt secret key and sign
      const decryptedSecretKey = decrypt(wallet.secretKeyEncrypted);
      const signedTx = this.signTransaction(txBuilder, decryptedSecretKey);

      // Submit to Stellar network
      const result = await this.submitTransaction(signedTx);

      // Update transaction record to completed
      await prisma.transaction.update({
        where: { id: txRecord.id },
        data: {
          status: 'completed',
          stellarTxId: result.hash,
          completedAt: new Date(),
        },
      });

      return {
        success: true,
        stellarTxId: result.hash,
        status: 'completed',
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof AppError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';

      // Update transaction record to failed
      await prisma.transaction.update({
        where: { id: txRecord.id },
        data: {
          status: 'failed',
          errorMessage,
        },
      });

      return {
        success: false,
        status: 'failed',
        errorMessage,
      };
    }
  },

  /**
   * Track transaction status by checking the Stellar network.
   */
  async trackTransactionStatus(stellarTxId: string): Promise<'pending' | 'completed' | 'failed'> {
    try {
      await server.transactions().transaction(stellarTxId).call();
      return 'completed';
    } catch (error: unknown) {
      const err = error as Record<string, unknown>;
      if (
        err &&
        typeof err.response === 'object' &&
        (err.response as Record<string, unknown>).status === 404
      ) {
        return 'pending';
      }
      return 'failed';
    }
  },

  /**
   * Get transaction history for a wallet.
   */
  async getTransactionHistory(walletId: string) {
    return prisma.transaction.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Get a single transaction by ID.
   */
  async getTransaction(transactionId: string) {
    return prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { wallet: true },
    });
  },
};
