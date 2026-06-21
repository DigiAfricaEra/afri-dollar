import {
  Prisma,
  type Transaction as DbTransaction,
  type WalletBalance as DbWalletBalance,
} from '@afri-dollar/database';
import { generateRandomString } from '@afri-dollar/shared';
import { addMinutes } from 'date-fns';

import prisma from '../config/database';

const QUOTE_TTL_MINUTES = 10;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_AMOUNT_PRECISION = 6;
const DEFAULT_RATE_PRECISION = 8;

type RateSource = 'internal' | 'external' | 'manual';

interface RateDefinition {
  fromAsset: string;
  toAsset: string;
  rate: string;
  source: RateSource;
}

export interface FXRate {
  fromAsset: string;
  toAsset: string;
  rate: string;
  source: string;
  validFrom: Date;
  validUntil: Date | null;
}

export interface CreateFXQuoteOptions {
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
}

export interface FXQuote {
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  expiresAt: Date;
  quoteId: string;
}

export interface ExecuteConversionOptions {
  quoteId: string;
  walletId: string;
}

export interface FXConversionResult {
  quote: FXQuote;
  walletId: string;
  transactionId: string;
  fromBalance: string;
  toBalance: string;
  executedAt: Date;
}

export interface FXHistoryItem {
  transactionId: string;
  walletId: string;
  quoteId?: string;
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  status: string;
  executedAt: Date | null;
  createdAt: Date;
}

interface ExternalRatesResponse {
  rates?: unknown;
  data?: unknown;
  base?: unknown;
}

const INTERNAL_BASE_RATES: Array<Omit<RateDefinition, 'source'>> = [
  { fromAsset: 'USDC', toAsset: 'NGN', rate: '1550' },
  { fromAsset: 'USDC', toAsset: 'KES', rate: '128.5' },
  { fromAsset: 'USDC', toAsset: 'GHS', rate: '15.4' },
];

function normaliseAsset(asset: string): string {
  return asset.trim().toUpperCase();
}

function normaliseNumericString(value: string, precision: number): string {
  const numericValue = Number.parseFloat(value);

  if (Number.isNaN(numericValue) || numericValue <= 0) {
    throw new Error('Amount must be a positive number');
  }

  return numericValue.toFixed(precision).replace(/\.?0+$/, '');
}

function formatRate(value: number): string {
  return value.toFixed(DEFAULT_RATE_PRECISION).replace(/\.?0+$/, '');
}

function formatAmount(value: number): string {
  return value.toFixed(DEFAULT_AMOUNT_PRECISION).replace(/\.?0+$/, '');
}

function getPairKey(fromAsset: string, toAsset: string): string {
  return `${fromAsset}:${toAsset}`;
}

function mapRateDefinition(rate: {
  fromAsset: string;
  toAsset: string;
  rate: string;
  source: string;
  validFrom: Date;
  validUntil: Date | null;
}): FXRate {
  return {
    fromAsset: rate.fromAsset,
    toAsset: rate.toAsset,
    rate: rate.rate,
    source: rate.source,
    validFrom: rate.validFrom,
    validUntil: rate.validUntil,
  };
}

function mapQuote(quote: {
  quoteId: string;
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  expiresAt: Date;
}): FXQuote {
  return {
    quoteId: quote.quoteId,
    fromAsset: quote.fromAsset,
    toAsset: quote.toAsset,
    fromAmount: quote.fromAmount,
    toAmount: quote.toAmount,
    rate: quote.rate,
    expiresAt: quote.expiresAt,
  };
}

function buildInternalRates(): RateDefinition[] {
  return INTERNAL_BASE_RATES.flatMap((rate) => {
    const forwardRate: RateDefinition = {
      ...rate,
      source: 'internal',
    };
    const reverseRate: RateDefinition = {
      fromAsset: rate.toAsset,
      toAsset: rate.fromAsset,
      rate: formatRate(1 / Number.parseFloat(rate.rate)),
      source: 'internal',
    };

    return [forwardRate, reverseRate];
  });
}

function parseRateArray(rawRates: unknown, source: RateSource): RateDefinition[] {
  if (!Array.isArray(rawRates)) {
    return [];
  }

  return rawRates.flatMap((rate): RateDefinition[] => {
    if (!rate || typeof rate !== 'object') {
      return [];
    }

    const record = rate as Record<string, unknown>;
    const fromAsset = typeof record.fromAsset === 'string' ? normaliseAsset(record.fromAsset) : '';
    const toAsset = typeof record.toAsset === 'string' ? normaliseAsset(record.toAsset) : '';
    const rawValue = record.rate;
    const numericRate =
      typeof rawValue === 'string' || typeof rawValue === 'number'
        ? Number.parseFloat(String(rawValue))
        : Number.NaN;

    if (
      !fromAsset ||
      !toAsset ||
      fromAsset === toAsset ||
      Number.isNaN(numericRate) ||
      numericRate <= 0
    ) {
      return [];
    }

    return [
      {
        fromAsset,
        toAsset,
        rate: formatRate(numericRate),
        source,
      },
    ];
  });
}

function parseObjectRates(rawRates: unknown, source: RateSource): RateDefinition[] {
  if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
    return [];
  }

  const parsedRates: RateDefinition[] = [];

  for (const [fromAssetKey, nestedValue] of Object.entries(rawRates)) {
    if (!nestedValue || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
      continue;
    }

    const fromAsset = normaliseAsset(fromAssetKey);

    const nestedRates = nestedValue as Record<string, unknown>;

    for (const [toAssetKey, rateValue] of Object.entries(nestedRates)) {
      const numericRate =
        typeof rateValue === 'string' || typeof rateValue === 'number'
          ? Number.parseFloat(String(rateValue))
          : Number.NaN;

      if (Number.isNaN(numericRate) || numericRate <= 0) {
        continue;
      }

      parsedRates.push({
        fromAsset,
        toAsset: normaliseAsset(toAssetKey),
        rate: formatRate(numericRate),
        source,
      });
    }
  }

  return parsedRates.filter((rate) => rate.fromAsset !== rate.toAsset);
}

function parseManualRates(): RateDefinition[] {
  const rawRates = process.env.FX_MANUAL_RATES;

  if (!rawRates) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawRates) as unknown;
    return [...parseRateArray(parsed, 'manual'), ...parseObjectRates(parsed, 'manual')];
  } catch (error) {
    console.warn('Unable to parse FX_MANUAL_RATES:', error);
    return [];
  }
}

async function fetchExternalRates(): Promise<RateDefinition[]> {
  const externalApiUrl = process.env.FX_EXTERNAL_API_URL;

  if (!externalApiUrl) {
    return [];
  }

  try {
    const response = await fetch(externalApiUrl);

    if (!response.ok) {
      console.warn(`FX external rate request failed with status ${response.status}`);
      return [];
    }

    const payload = (await response.json()) as ExternalRatesResponse | unknown[];

    return [
      ...parseRateArray(payload, 'external'),
      ...parseRateArray((payload as ExternalRatesResponse).rates, 'external'),
      ...parseRateArray((payload as ExternalRatesResponse).data, 'external'),
      ...parseObjectRates((payload as ExternalRatesResponse).rates, 'external'),
    ];
  } catch (error) {
    console.warn('Unable to fetch external FX rates:', error);
    return [];
  }
}

async function syncRateHistory(rates: RateDefinition[]): Promise<void> {
  for (const rate of rates) {
    const latestRate = await prisma.exchangeRate.findFirst({
      where: {
        fromAsset: rate.fromAsset,
        toAsset: rate.toAsset,
        isActive: true,
      },
      orderBy: {
        validFrom: 'desc',
      },
    });

    if (latestRate && latestRate.rate === rate.rate && latestRate.source === rate.source) {
      continue;
    }

    const validFrom = new Date();

    await prisma.$transaction([
      prisma.exchangeRate.updateMany({
        where: {
          fromAsset: rate.fromAsset,
          toAsset: rate.toAsset,
          isActive: true,
        },
        data: {
          isActive: false,
          validUntil: validFrom,
        },
      }),
      prisma.exchangeRate.create({
        data: {
          fromAsset: rate.fromAsset,
          toAsset: rate.toAsset,
          rate: rate.rate,
          source: rate.source,
          isActive: true,
          validFrom,
        },
      }),
    ]);
  }
}

async function logAudit(
  userId: string | undefined,
  action: string,
  resourceId: string | null,
  success: boolean,
  metadata?: Prisma.InputJsonValue
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId || null,
        action,
        resource: 'fx',
        resourceId,
        success,
        metadata: metadata || undefined,
      },
    });
  } catch (error) {
    console.error('Failed to write FX audit log:', error);
  }
}

async function findWalletBalance(
  client: Prisma.TransactionClient,
  walletId: string,
  assetCode: string
): Promise<DbWalletBalance | null> {
  const balances = await client.walletBalance.findMany({
    where: {
      walletId,
      assetCode,
    },
    orderBy: {
      updatedAt: 'desc',
    },
    take: 5,
  });

  return balances.find((balance) => balance.assetIssuer === null) || balances[0] || null;
}

function extractHistoryMetadata(metadata: Prisma.JsonValue | null): {
  quoteId?: string;
  toAsset?: string;
  toAmount?: string;
  rate?: string;
} {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const record = metadata as Record<string, unknown>;

  return {
    quoteId: typeof record.quoteId === 'string' ? record.quoteId : undefined,
    toAsset: typeof record.toAsset === 'string' ? record.toAsset : undefined,
    toAmount: typeof record.toAmount === 'string' ? record.toAmount : undefined,
    rate: typeof record.rate === 'string' ? record.rate : undefined,
  };
}

function mapHistoryItem(transaction: DbTransaction): FXHistoryItem {
  const metadata = extractHistoryMetadata(transaction.metadata);

  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    quoteId: metadata.quoteId,
    fromAsset: transaction.assetCode,
    toAsset: metadata.toAsset || '',
    fromAmount: transaction.amount,
    toAmount: metadata.toAmount || '',
    rate: metadata.rate || '',
    status: transaction.status,
    executedAt: transaction.completedAt,
    createdAt: transaction.createdAt,
  };
}

export const FXService = {
  async getCurrentRates(filters?: { fromAsset?: string; toAsset?: string }): Promise<FXRate[]> {
    const fromAsset = filters?.fromAsset ? normaliseAsset(filters.fromAsset) : undefined;
    const toAsset = filters?.toAsset ? normaliseAsset(filters.toAsset) : undefined;

    const rateMap = new Map<string, RateDefinition>();

    for (const rate of buildInternalRates()) {
      rateMap.set(getPairKey(rate.fromAsset, rate.toAsset), rate);
    }

    for (const rate of await fetchExternalRates()) {
      rateMap.set(getPairKey(rate.fromAsset, rate.toAsset), rate);
    }

    for (const rate of parseManualRates()) {
      rateMap.set(getPairKey(rate.fromAsset, rate.toAsset), rate);
    }

    const selectedRates = Array.from(rateMap.values()).filter((rate) => {
      if (fromAsset && rate.fromAsset !== fromAsset) {
        return false;
      }

      if (toAsset && rate.toAsset !== toAsset) {
        return false;
      }

      return true;
    });

    await syncRateHistory(selectedRates);

    const rates = await prisma.exchangeRate.findMany({
      where: {
        isActive: true,
        ...(fromAsset ? { fromAsset } : {}),
        ...(toAsset ? { toAsset } : {}),
      },
      orderBy: [{ fromAsset: 'asc' }, { toAsset: 'asc' }],
    });

    return rates.map(mapRateDefinition);
  },

  async calculateQuote(options: CreateFXQuoteOptions): Promise<FXQuote> {
    const fromAsset = normaliseAsset(options.fromAsset);
    const toAsset = normaliseAsset(options.toAsset);

    if (fromAsset === toAsset) {
      throw new Error('From and to assets must be different');
    }

    const fromAmount = normaliseNumericString(options.fromAmount, DEFAULT_AMOUNT_PRECISION);
    const availableRates = await this.getCurrentRates({ fromAsset, toAsset });
    const selectedRate = availableRates[0];

    if (!selectedRate) {
      throw new Error('FX rate not available');
    }

    const convertedAmount = formatAmount(
      Number.parseFloat(fromAmount) * Number.parseFloat(selectedRate.rate)
    );
    const expiresAt = addMinutes(new Date(), QUOTE_TTL_MINUTES);
    const quoteId = generateRandomString(24);

    const quote = await prisma.conversionQuote.create({
      data: {
        quoteId,
        fromAsset,
        toAsset,
        fromAmount,
        toAmount: convertedAmount,
        rate: selectedRate.rate,
        source: selectedRate.source,
        expiresAt,
      },
    });

    return mapQuote(quote);
  },

  async executeConversion(
    options: ExecuteConversionOptions,
    userId: string
  ): Promise<FXConversionResult> {
    const wallet = await prisma.wallet.findFirst({
      where: {
        id: options.walletId,
        userId,
        isActive: true,
      },
    });

    if (!wallet) {
      await logAudit(userId, 'fx_conversion_failed', options.quoteId, false, {
        error: 'Wallet not found',
        walletId: options.walletId,
      });
      throw new Error('Wallet not found');
    }

    const quote = await prisma.conversionQuote.findUnique({
      where: {
        quoteId: options.quoteId,
      },
    });

    if (!quote) {
      await logAudit(userId, 'fx_conversion_failed', options.quoteId, false, {
        error: 'Quote not found',
        walletId: options.walletId,
      });
      throw new Error('Quote not found');
    }

    if (quote.status === 'executed') {
      throw new Error('Quote has already been used');
    }

    if (quote.expiresAt <= new Date()) {
      if (quote.status === 'pending') {
        await prisma.conversionQuote.update({
          where: { quoteId: options.quoteId },
          data: { status: 'expired' },
        });
      }

      throw new Error('Quote has expired');
    }

    const executedAt = new Date();

    const result = await prisma.$transaction(async (client) => {
      const lockedQuote = await client.conversionQuote.findUnique({
        where: {
          quoteId: options.quoteId,
        },
      });

      if (!lockedQuote) {
        throw new Error('Quote not found');
      }

      if (lockedQuote.status === 'executed') {
        throw new Error('Quote has already been used');
      }

      if (lockedQuote.expiresAt <= executedAt) {
        await client.conversionQuote.update({
          where: {
            quoteId: options.quoteId,
          },
          data: {
            status: 'expired',
          },
        });

        throw new Error('Quote has expired');
      }

      const sourceBalance = await findWalletBalance(client, wallet.id, lockedQuote.fromAsset);

      if (!sourceBalance) {
        throw new Error('Insufficient balance');
      }

      const sourceBalanceValue = Number.parseFloat(sourceBalance.balance);
      const debitAmount = Number.parseFloat(lockedQuote.fromAmount);

      if (sourceBalanceValue < debitAmount) {
        throw new Error('Insufficient balance');
      }

      const targetBalance = await findWalletBalance(client, wallet.id, lockedQuote.toAsset);
      const newSourceBalance = formatAmount(sourceBalanceValue - debitAmount);
      const newTargetBalance = formatAmount(
        Number.parseFloat(targetBalance?.balance || '0') + Number.parseFloat(lockedQuote.toAmount)
      );

      const updatedSourceBalance = await client.walletBalance.update({
        where: {
          id: sourceBalance.id,
        },
        data: {
          balance: newSourceBalance,
        },
      });

      const updatedTargetBalance = targetBalance
        ? await client.walletBalance.update({
            where: {
              id: targetBalance.id,
            },
            data: {
              balance: newTargetBalance,
            },
          })
        : await client.walletBalance.create({
            data: {
              walletId: wallet.id,
              assetCode: lockedQuote.toAsset,
              assetIssuer: null,
              balance: newTargetBalance,
            },
          });

      await client.conversionQuote.update({
        where: {
          quoteId: options.quoteId,
        },
        data: {
          status: 'executed',
          walletId: wallet.id,
          executedAt,
        },
      });

      const metadata: Prisma.InputJsonObject = {
        quoteId: lockedQuote.quoteId,
        fromAsset: lockedQuote.fromAsset,
        toAsset: lockedQuote.toAsset,
        fromAmount: lockedQuote.fromAmount,
        toAmount: lockedQuote.toAmount,
        rate: lockedQuote.rate,
        source: lockedQuote.source,
      };

      const transaction = await client.transaction.create({
        data: {
          userId,
          walletId: wallet.id,
          type: 'exchange',
          status: 'completed',
          amount: lockedQuote.fromAmount,
          assetCode: lockedQuote.fromAsset,
          metadata,
          completedAt: executedAt,
        },
      });

      return {
        transaction,
        updatedSourceBalance,
        updatedTargetBalance,
        quote: lockedQuote,
      };
    });

    await logAudit(userId, 'fx_conversion_executed', result.transaction.id, true, {
      walletId: wallet.id,
      quoteId: result.quote.quoteId,
      fromAsset: result.quote.fromAsset,
      toAsset: result.quote.toAsset,
      fromAmount: result.quote.fromAmount,
      toAmount: result.quote.toAmount,
    });

    return {
      quote: mapQuote(result.quote),
      walletId: wallet.id,
      transactionId: result.transaction.id,
      fromBalance: result.updatedSourceBalance.balance,
      toBalance: result.updatedTargetBalance.balance,
      executedAt,
    };
  },

  async getConversionHistory(
    userId: string,
    options?: {
      walletId?: string;
      limit?: number;
      cursor?: string;
      fromDate?: string;
      toDate?: string;
    }
  ): Promise<FXHistoryItem[]> {
    const limit = Math.min(Math.max(options?.limit || 50, 1), MAX_HISTORY_LIMIT);

    const where: Record<string, unknown> = {
      userId,
      type: 'exchange',
    };

    if (options?.walletId) {
      where.walletId = options.walletId;
    }

    if (options?.cursor) {
      where.id = { lt: options.cursor };
    }

    if (options?.fromDate || options?.toDate) {
      const createdAtFilter: Record<string, Date> = {};
      if (options?.fromDate) {
        createdAtFilter.gte = new Date(options.fromDate);
      }
      if (options?.toDate) {
        createdAtFilter.lte = new Date(options.toDate);
      }
      where.createdAt = createdAtFilter;
    }

    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
    });

    return transactions.map(mapHistoryItem);
  },

  async upsertRate(data: { fromAsset: string; toAsset: string; rate: string }): Promise<FXRate> {
    const fromAsset = normaliseAsset(data.fromAsset);
    const toAsset = normaliseAsset(data.toAsset);

    if (fromAsset === toAsset) {
      throw new Error('From and to assets must be different');
    }

    const rate = normaliseNumericString(data.rate, DEFAULT_RATE_PRECISION);
    const validFrom = new Date();

    await prisma.$transaction([
      prisma.exchangeRate.updateMany({
        where: {
          fromAsset,
          toAsset,
          isActive: true,
        },
        data: {
          isActive: false,
          validUntil: validFrom,
        },
      }),
      prisma.exchangeRate.create({
        data: {
          fromAsset,
          toAsset,
          rate,
          source: 'manual',
          isActive: true,
          validFrom,
        },
      }),
    ]);

    const newRate = await prisma.exchangeRate.findFirst({
      where: {
        fromAsset,
        toAsset,
        isActive: true,
      },
      orderBy: {
        validFrom: 'desc',
      },
    });

    if (!newRate) {
      throw new Error('Failed to create exchange rate');
    }

    return mapRateDefinition(newRate);
  },

  async deactivateRate(id: string): Promise<void> {
    const rate = await prisma.exchangeRate.findUnique({
      where: { id },
    });

    if (!rate) {
      throw new Error('Exchange rate not found');
    }

    if (!rate.isActive) {
      throw new Error('Exchange rate is already inactive');
    }

    await prisma.exchangeRate.update({
      where: { id },
      data: {
        isActive: false,
        validUntil: new Date(),
      },
    });
  },
};
