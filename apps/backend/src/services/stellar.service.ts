import {
  Asset,
  Config,
  Horizon,
  Keypair,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import {
  getDefaultHorizonUrl,
  getNetworkPassphrase as resolveNetworkPassphrase,
  parseStellarNetwork,
} from '../config/stellar-network';
import { AppError } from '../types';

let horizonServer: Horizon.Server | undefined;

function getHorizonServerInstance(): Horizon.Server {
  if (horizonServer === undefined) {
    horizonServer = new Horizon.Server(getDefaultHorizonUrl());
  }
  return horizonServer;
}

/**
 * Finite timeout for general Horizon requests (loadAccount, fetchBaseFee,
 * status lookups). Transaction submission keeps the SDK's own hardcoded
 * 60-second timeout, independent of this global setting.
 */
const HORIZON_REQUEST_TIMEOUT_MS = 15_000;
Config.setTimeout(HORIZON_REQUEST_TIMEOUT_MS);

const FRIENDBOT_URL = 'https://friendbot.stellar.org';
const FRIENDBOT_TIMEOUT_MS = 30_000;

export interface StellarBalance {
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

/**
 * Safely extracts the error message from an unknown error value.
 */
function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.message === 'string') return errObj.message;
  }
  return String(error);
}

/**
 * Fund a Stellar testnet account using the Friendbot faucet.
 * Only works when STELLAR_NETWORK is set to 'testnet'.
 */
async function fundTestnetAccount(publicKey: string): Promise<void> {
  if (parseStellarNetwork() !== 'testnet') {
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

export class StellarPaymentSubmitError extends AppError {
  transactionHash?: string;

  constructor(message: string, transactionHash?: string) {
    super(502, message);
    this.name = 'StellarPaymentSubmitError';
    this.transactionHash = transactionHash;
  }
}

/**
 * Chooses a per-operation fee from Horizon fee stats (p90 of fee_charged).
 * Falls back to STELLAR_BASE_FEE or 100 stroops when stats are unavailable.
 */
async function resolveBaseFee(server: Horizon.Server): Promise<string> {
  const configured = process.env.STELLAR_BASE_FEE?.trim();
  try {
    const stats = await server.feeStats();
    const p90 = Number(stats.fee_charged?.p90);
    if (Number.isFinite(p90) && p90 > 0) {
      return String(Math.ceil(p90));
    }
    const lastBase = Number(stats.last_ledger_base_fee);
    if (Number.isFinite(lastBase) && lastBase > 0) {
      return String(Math.ceil(lastBase));
    }
  } catch {
    // Horizon fee stats are advisory; a static fallback keeps payments moving.
  }

  if (configured !== undefined && configured.length > 0 && Number.isFinite(Number(configured))) {
    return configured;
  }
  return '100';
}

function resolvePaymentAsset(assetCode: string, assetIssuer?: string): Asset {
  const code = assetCode.trim().toUpperCase();
  const isNative = code === 'XLM' || code === 'NATIVE';
  if (isNative) {
    return Asset.native();
  }
  if (assetIssuer === undefined || assetIssuer.length === 0) {
    throw new AppError(400, `assetIssuer is required for ${assetCode}`);
  }
  return new Asset(assetCode, assetIssuer);
}

export const StellarService = {
  /**
   * Returns the configured Horizon server instance.
   */
  getHorizonServer(): Horizon.Server {
    return getHorizonServerInstance();
  },

  /**
   * Fetches and returns balances for a Stellar account.
   * Filters out liquidity pool shares, returning only native and asset balances.
   */
  async getAccountBalances(publicKey: string): Promise<StellarBalance[]> {
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new AppError(400, 'Invalid Stellar public key');
    }

    try {
      const account = await getHorizonServerInstance().loadAccount(publicKey);

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

  /**
   * Fetches paginated transaction history for a Stellar account.
   * Validates public key, limit (1-200), and cursor before querying Horizon.
   */
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
      options.cursor = options.cursor.trim();
    }

    try {
      let callBuilder = getHorizonServerInstance().transactions().forAccount(publicKey);

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

  /**
   * Funds a Stellar testnet account using the Friendbot faucet.
   * Throws if not on testnet or if the public key is invalid.
   */
  async fundTestnetAccount(publicKey: string): Promise<void> {
    return fundTestnetAccount(publicKey);
  },

  getNetworkPassphrase(): string {
    return resolveNetworkPassphrase();
  },

  /**
   * Signs and submits a payment from a source secret key.
   * Returns the Horizon transaction hash on success.
   */
  async submitPayment(options: {
    sourceSecret: string;
    destination: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string;
    memo?: string;
    beforeSubmit?: (hash: string) => Promise<void>;
  }): Promise<{ hash: string }> {
    if (!StrKey.isValidEd25519SecretSeed(options.sourceSecret)) {
      throw new AppError(500, 'Invalid treasury signing key');
    }
    if (!StrKey.isValidEd25519PublicKey(options.destination)) {
      throw new AppError(400, 'Invalid Stellar destination address');
    }

    const sourceKeypair = Keypair.fromSecret(options.sourceSecret);
    const networkPassphrase = resolveNetworkPassphrase();
    const server = getHorizonServerInstance();
    let transactionHash: string | undefined;

    try {
      const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
      const fee = await resolveBaseFee(server);
      const txBuilder = new TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase,
      });

      if (options.memo) {
        txBuilder.addMemo(Memo.text(options.memo.slice(0, 28)));
      }

      const asset = resolvePaymentAsset(options.assetCode, options.assetIssuer);

      txBuilder.addOperation(
        Operation.payment({
          destination: options.destination,
          asset,
          amount: options.amount,
        })
      );
      txBuilder.setTimeout(60);

      const stellarTx = txBuilder.build();
      stellarTx.sign(sourceKeypair);
      transactionHash = stellarTx.hash().toString('hex');
      if (options.beforeSubmit) {
        await options.beforeSubmit(transactionHash);
      }

      const response = await server.submitTransaction(stellarTx);
      return { hash: response.hash };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new StellarPaymentSubmitError(
        `Failed to submit Stellar payment: ${getErrorMessage(error)}`,
        transactionHash
      );
    }
  },
};
