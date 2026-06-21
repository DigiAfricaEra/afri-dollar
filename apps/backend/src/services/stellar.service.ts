import { Horizon, StrKey } from '@stellar/stellar-sdk';

import { AppError } from '../types';

const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

const horizonServer = new Horizon.Server(HORIZON_URL);

const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const FRIENDBOT_TIMEOUT_MS = 30_000;

export interface StellarBalance {
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.message === 'string') return errObj.message;
  }
  return String(error);
}

async function fundTestnetAccount(publicKey: string): Promise<void> {
  if (STELLAR_NETWORK !== 'testnet') {
    throw new AppError(400, 'Friendbot funding is only available on testnet');
  }

  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new AppError(400, 'Invalid Stellar public key');
  }

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
    if (error instanceof AppError) throw error;

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AppError(504, 'Friendbot funding request timed out');
    }

    throw new AppError(502, `Friendbot funding failed: ${getErrorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export const StellarService = {
  getHorizonServer(): Horizon.Server {
    return horizonServer;
  },

  async getAccountBalances(publicKey: string): Promise<StellarBalance[]> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new AppError(400, 'Invalid Stellar public key');
    }

    try {
      const account = await horizonServer.loadAccount(publicKey);

      return account.balances
        .filter(
          (b) =>
            b.asset_type === 'native' ||
            b.asset_type === 'credit_alphanum4' ||
            b.asset_type === 'credit_alphanum12'
        )
        .map((b) => {
          const balance: StellarBalance = {
            asset_type: b.asset_type,
            balance: b.balance,
          };
          if ('asset_code' in b && b.asset_code) {
            balance.asset_code = b.asset_code;
          }
          if ('asset_issuer' in b && b.asset_issuer) {
            balance.asset_issuer = b.asset_issuer;
          }
          return balance;
        });
    } catch (error) {
      const err = error as Record<string, unknown>;
      if (
        err &&
        typeof err.response === 'object' &&
        (err.response as Record<string, unknown>).status === 404
      ) {
        throw new AppError(404, 'Stellar account not found');
      }
      throw new AppError(502, `Failed to fetch account balances: ${getErrorMessage(error)}`);
    }
  },

  async getAccountTransactions(
    publicKey: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<Horizon.ServerApi.TransactionRecord[]> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new AppError(400, 'Invalid Stellar public key');
    }

    if (options?.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
        throw new AppError(400, 'Limit must be a positive integer between 1 and 200');
      }
    }

    if (options?.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || options.cursor.trim().length === 0) {
        throw new AppError(400, 'Cursor must be a non-empty string');
      }
    }

    try {
      let callBuilder = horizonServer.transactions().forAccount(publicKey);

      if (options?.limit !== undefined) {
        callBuilder = callBuilder.limit(options.limit);
      }
      if (options?.cursor !== undefined) {
        callBuilder = callBuilder.cursor(options.cursor);
      }

      const page = await callBuilder.call();
      return page.records;
    } catch (error) {
      const err = error as Record<string, unknown>;
      if (
        err &&
        typeof err.response === 'object' &&
        (err.response as Record<string, unknown>).status === 404
      ) {
        throw new AppError(404, 'Stellar account not found');
      }
      throw new AppError(502, `Failed to fetch account transactions: ${getErrorMessage(error)}`);
    }
  },

  async fundTestnetAccount(publicKey: string): Promise<void> {
    return fundTestnetAccount(publicKey);
  },
};
